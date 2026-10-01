// marca — puerta de marca para quien compra en Loekemeyer Y en Chef (Pablo Olejavetzky, 01/10, D008).
//
// Pedido textual: "cuando se le hace una consulta algún cliente que tenga ambas marcas, deberíamos consultarle a cuál se
// refiere, también con los pedidos; es el doble de trabajo de flow, pero es la única que va a quedar bien y sin errores".
//
// Cómo funciona (un solo lugar, delante del FAQ y del agente; no toca a quien compra en una sola marca):
//   1. Es de "las dos marcas" un cliente de Loekemeyer cuyo CUIT también es cliente de Chef (bot_cuentas, empresa CH) Y le compró a
//      Chef hace poco: una factura de Chef en los últimos 12 meses (isis_ch.documentos) o un pedido en los últimos 90 días
//      (chef_orders_cache). Medido el 01/10: de 357 clientes que están en las dos empresas, sólo 64 (17,9 %) tienen una factura de
//      Chef en 12 meses; preguntarle la marca a los otros 293 (82,1 %) era ruido. Ante la duda (Gestión no responde), se pregunta.
//   2. Su consulta se pregunta ("¿De qué marca es tu consulta: Loekemeyer o Chef?") salvo que:
//        · sea saludo, cortesía o una consulta de plata (facturas, saldo, pagos, descuentos): esas ya contestan las dos
//          empresas por separado (faq.ts, consultar_mis_facturas) y preguntar sólo sumaría un paso;
//        · nombre la marca ("el pedido de Chef") o ya haya elegido una en los últimos 15 minutos.
//   3. Con la marca elegida:
//        · Chef → atenderClienteChef (chef.ts): lo que Chef ya sabe contestar (pedidos, facturas, pagos) y, lo demás, una
//          persona, con la alerta marcada como Chef. Es lo mismo que recibe un cliente que sólo compra en Chef.
//        · Loekemeyer → el flujo de siempre (FAQ y agente), que busca en Loekemeyer.
//   4. Cada respuesta de marca lleva la etiqueta *Chef* o *Loekemeyer* arriba. La etiqueta es también la memoria: la marca
//      elegida se lee del historial (bot_historial_chat), sin tablas nuevas. Si el último mensaje con etiqueta tiene más de 15
//      minutos, se vuelve a preguntar: ante la duda, se pregunta.
//
// Cuando Chef sume una herramienta nueva, entra en atenderClienteChef y la puerta no cambia.
import { supabase } from "./supabase.ts";
import { SIM } from "./simulacion.ts";
import { type Customer, ctxPagosDeCliente, esSoloSaludo, lookupOrderStatus } from "./faq.ts";
import { cuitNorm, facturasChef } from "./empresas.ts";
import { atenderClienteChef, type CuentaChef, esConsultaDePagos, esCortesia } from "./chef.ts";
import {
  esConsultaEstado, hayPedidosChefRecientes, hoyAR, marcaEnTexto, marcaNombrada, pedidosChef, textoPedidosChef,
} from "./pedidos-marca.ts";

export type MarcaUna = "lk" | "chef";

/** Frase fija de la pregunta: el historial la usa para reconocer que el cliente está contestándola. */
export const MARCA_PREGUNTA = "¿De qué marca es tu consulta";
const VENTANA_MIN = 15;
const NOMBRE: Record<MarcaUna, string> = { lk: "Loekemeyer", chef: "Chef" };

export const etiquetaMarca = (m: MarcaUna) => `*${NOMBRE[m]}*`;
export const conEtiqueta = (m: MarcaUna, reply: string) =>
  reply.startsWith(`${etiquetaMarca(m)}\n`) ? reply : `${etiquetaMarca(m)}\n${reply}`;

export const preguntaMarca = (nombre: string, conAmbas = false) =>
  `${nombre}, compraste en Loekemeyer y en Chef. ${MARCA_PREGUNTA}: *Loekemeyer* o *Chef*?${conAmbas ? " (o escribí *los dos*)" : ""}`;
const preguntaDeAUna = `Para no mezclar las respuestas vamos de a una marca. ${MARCA_PREGUNTA} primero: *Loekemeyer* o *Chef*?`;

// ── historial ────────────────────────────────────────────────────────────────────────────────────
export type FilaHistorial = { rol: string; contenido: string | null; creado_en: string };
// La respuesta puede venir con el saludo de primer contacto por delante.
const RE_ETIQUETA = /^(?:¡Hola[^\n]*\n\n)?\*(Loekemeyer|Chef)\*\n/;

/** ¿La fila es una respuesta corta con sólo una marca ("Chef", "el de Loeke")? Esas no son la consulta original. */
const esRespuestaDeMarca = (c: string) => marcaEnTexto(c) !== null && c.trim().split(/\s+/).length <= 4;

/**
 * Qué dice el historial sobre la marca. `filas` va de la más nueva a la más vieja y NO incluye el mensaje que llega ahora.
 *   · pendiente: lo último que le dijimos fue la pregunta de marca y no contestó nada en el medio; `original` es la consulta
 *     que la disparó (el último mensaje suyo que no es una respuesta de marca).
 *   · marca: la del último mensaje con etiqueta de los últimos 15 minutos (si no hay una pregunta más nueva).
 */
export function leerHistorial(filas: FilaHistorial[], ahora = Date.now()):
  { pendiente: boolean; original: string | null; marca: MarcaUna | null } {
  const limite = ahora - VENTANA_MIN * 60_000;
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i];
    if (new Date(f.creado_en).getTime() < limite) break;
    if (f.rol !== "assistant") continue;
    const c = String(f.contenido ?? "");
    if (c.startsWith("[Aviso automático")) continue;
    if (c.includes(MARCA_PREGUNTA)) {
      if (!filas.slice(0, i).every((x) => x.rol === "assistant")) return { pendiente: false, original: null, marca: null };
      const orig = filas.slice(i + 1).find((x) => x.rol === "user" && !esRespuestaDeMarca(String(x.contenido ?? "")));
      return { pendiente: true, original: orig ? String(orig.contenido) : null, marca: null };
    }
    const m = RE_ETIQUETA.exec(c);
    if (m) return { pendiente: false, original: null, marca: m[1] === "Chef" ? "chef" : "lk" };
  }
  return { pendiente: false, original: null, marca: null };
}

async function filasRecientes(phone: string): Promise<FilaHistorial[]> {
  if (SIM.activo) return [...SIM.historial].reverse().slice(0, 14);
  const { data } = await supabase.from("bot_historial_chat").select("rol, contenido, creado_en")
    .eq("telefono", phone).order("creado_en", { ascending: false }).limit(14);
  return (data ?? []) as FilaHistorial[];
}

// ── la cuenta de Chef de un cliente de Loekemeyer (por CUIT, nunca por código) ──────────────────
const cacheCuentas = new Map<string, { hasta: number; cuenta: CuentaChef | null }>();

/**
 * ¿Compró en Chef hace poco? `facturas12m` = cantidad de facturas de Chef en los últimos 12 meses y `pedidos90d` = si tiene pedidos
 * de Chef cargados en los últimos 90 días; null = no se pudo leer. "dudoso" se trata como activo: ante la duda, se pregunta.
 */
export function decidirActividadChef(facturas12m: number | null, pedidos90d: boolean | null): "activo" | "inactivo" | "dudoso" {
  if ((facturas12m ?? 0) > 0 || pedidos90d === true) return "activo";
  if (facturas12m === null || pedidos90d === null) return "dudoso";
  return "inactivo";
}

/** La cuenta de Chef del cliente SI es de las dos marcas (CUIT en Chef + compra en los últimos 12 meses); si no, null. */
export async function cuentaChefDeCliente(customer: NonNullable<Customer>): Promise<CuentaChef | null> {
  const hit = cacheCuentas.get(customer.id);
  if (hit && hit.hasta > Date.now()) return hit.cuenta;
  const cuit = cuitNorm((await ctxPagosDeCliente(customer)).cuit);
  let cuenta: CuentaChef | null = null;
  let cachear = true;
  if (cuit) {
    const { data, error } = await supabase.from("bot_cuentas").select("cod_cliente, razon_social")
      .eq("empresa", "CH").eq("cuit", cuit).order("cod_cliente").limit(1);
    if (error) { console.error("cuentaChefDeCliente:", error.message); return null; }   // ante la falla no se cachea
    const r = data?.[0];
    if (r) {
      const desde = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
      const [facs, pedidos] = await Promise.all([facturasChef(cuit, desde), hayPedidosChefRecientes(cuit, 90)]);
      const act = decidirActividadChef(facs === null ? null : facs.length, pedidos);
      if (act !== "inactivo") cuenta = { cod_cliente: String(r.cod_cliente), razon_social: String(r.razon_social ?? ""), cuit, fuente: "cuit" };
      if (act === "dudoso") cachear = false;                                              // la próxima vez se vuelve a mirar
    }
  }
  if (cachear) cacheCuentas.set(customer.id, { hasta: Date.now() + 10 * 60_000, cuenta });
  return cuenta;
}

// ── la puerta ────────────────────────────────────────────────────────────────────────────────────
export type Puerta =
  | { tipo: "responder"; reply: string; via: string; documentos?: Array<{ url: string; filename: string }> }
  | { tipo: "seguir"; texto: string; via: string };   // sigue el flujo de Loekemeyer (FAQ / agente) con este texto, etiquetado

async function estadoDeLasDos(customer: NonNullable<Customer>, cuenta: CuentaChef): Promise<string> {
  const lk = (await lookupOrderStatus(customer)) ?? "";
  const chef = await pedidosChef({ cuit: cuenta.cuit });
  const bloqueChef = chef === null
    ? "No pude consultar tus pedidos de Chef en este momento: una persona del equipo te los confirma por acá. 🙏"
    : textoPedidosChef(customer.business_name, chef, hoyAR(), { cierre: false, sinNombre: true })!;
  return `${etiquetaMarca("lk")}\n${lk}\n\n${etiquetaMarca("chef")}\n${bloqueChef}`;
}

/**
 * Antes del FAQ y del agente, para un cliente de Loekemeyer. null = no corresponde (compra en una sola marca, o es un saludo,
 * una cortesía o una consulta de plata): sigue el flujo de siempre, sin etiqueta.
 */
export async function puertaMarca(phone: string, text: string, customer: NonNullable<Customer>): Promise<Puerta | null> {
  const t = text.trim();
  if (!t || esSoloSaludo(t) || esCortesia(t) || esConsultaDePagos(t)) return null;
  const cuenta = await cuentaChefDeCliente(customer);
  if (!cuenta) return null;

  const h = leerHistorial(await filasRecientes(phone));
  // Contesta la pregunta ("Chef", "el de Loeke", "los dos") o, si el mensaje es nuevo, ¿nombra la marca?
  const respondiendo = h.pendiente ? marcaEnTexto(t) : null;
  const marca = respondiendo ?? marcaNombrada(t);
  const consulta = respondiendo ? h.original : t;           // lo que hay que contestar

  if (marca) {
    if (!consulta) {
      // Contestó la marca pero no encuentro qué había preguntado (pasó la ventana o se perdió el historial).
      if (marca === "ambas") return { tipo: "responder", reply: preguntaDeAUna, via: "marca (pregunta de a una)" };
      return { tipo: "responder", reply: conEtiqueta(marca, "Perfecto. ¿Qué querés consultar?"), via: `marca (${marca}) sin consulta` };
    }
    if (marca === "ambas") {
      if (esConsultaEstado(consulta)) return { tipo: "responder", reply: await estadoDeLasDos(customer, cuenta), via: "marca (las dos) → estado de pedidos" };
      return { tipo: "responder", reply: preguntaDeAUna, via: "marca (pregunta de a una)" };
    }
    return await resolver(marca, consulta, phone, cuenta);
  }
  if (h.marca) return await resolver(h.marca, t, phone, cuenta);       // ya eligió hace menos de 15 minutos
  return { tipo: "responder", reply: preguntaMarca(customer.business_name, esConsultaEstado(t)), via: "marca (pregunta)" };
}

async function resolver(marca: MarcaUna, consulta: string, phone: string, cuenta: CuentaChef): Promise<Puerta> {
  if (marca === "lk") return { tipo: "seguir", texto: consulta, via: "marca (lk)" };
  const r = await atenderClienteChef(phone, consulta, cuenta);
  return { tipo: "responder", reply: conEtiqueta("chef", r.reply), via: `marca (chef) → ${r.via}`, ...(r.documentos?.length ? { documentos: r.documentos } : {}) };
}
