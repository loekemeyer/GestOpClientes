// pedidos-marca — "¿cuándo llega mi pedido?" para quien compra en las dos marcas o sólo en Chef (Pablo Olejavetzky, 01/10).
//
// Pedido textual: "cuando un cliente de Chef pregunta por la llegada de su pedido, podríamos ver los pedidos que tiene
// cargados. Si tiene de ambos, deberíamos consultarle de qué 'marca' es el pedido".
//
// Reglas (D008: la empresa viaja con cada dato, nunca se adivina):
//   · cliente sólo de Chef → sus pedidos de Chef con estado y fecha, directo (chef.ts);
//   · cliente de Loekemeyer sin pedidos de Chef en curso → sigue el flujo de siempre (faq.ts, lookupOrderStatus);
//   · cliente de Loekemeyer con pedidos en curso en las DOS marcas → se le pregunta de cuál es, y lo que conteste
//     ("Chef", "Loeke", "los dos") se resuelve acá;
//   · cliente de Loekemeyer con pedidos en curso sólo en Chef → se le muestran los de Chef, con el nombre de la marca.
//   · si dice la marca en la pregunta ("¿cuándo llega mi pedido de Chef?") no se le pregunta nada.
//
// De dónde sale cada dato (medido el 01/10):
//   · los pedidos de Chef: chef_orders_cache (PaginaLK; id 145–241), unidos a chef_customers_cache por CUIT (un cliente de
//     Loekemeyer cruza con Chef por CUIT, nunca por código) o por el código de Chef (cliente sólo de Chef);
//   · su estado y fecha de salida: la vista gv_pedido_web_estado_pagina de Gestión (empresa = 'chef');
//   · anulados: GV_Pedidos_Anulados / GV_Pedidos_Prueba_Historial (pedidos-anulados.ts, empresa 'chef').
//
// ⚠ Límite conocido: los pedidos que Chef carga directo en Gestión (order_id ≥ 1.000.000) no pasan por la web y no tienen
// cliente asociado: el bot no los ve. Un pedido de Chef que no figura en la vista y tiene más de 7 días se da por entregado
// (mismo criterio que lookupOrderStatus con los trabados): si el cliente dice que no le llegó, es reclamo (RE_NO_LLEGO).
import { getGestionClient, supabase } from "./supabase.ts";
import { SIM } from "./simulacion.ts";
import { pedidosAnulados } from "./pedidos-anulados.ts";
import { cuitNorm } from "./empresas.ts";
import {
  ctxPagosDeCliente, type Customer, lookupOrderStatus, RE_ESTADO_PEDIDO, RE_INGRESO, RE_NO_LLEGO, RE_PLAZO_ENTREGA,
} from "./faq.ts";

export type Marca = "lk" | "chef" | "ambas";

export type PedidoChef = {
  creado: string;                    // ISO (chef_orders_cache.created_at)
  estado: string | null;             // vista de Gestión; null = todavía no figura
  fecha_entrega: string | null;      // yyyy-mm-dd
  entregado_at: string | null;
  retiro: string | null;             // yyyy-mm-dd, si lo retira en el depósito
  reingreso: string | null;          // yyyy-mm-dd: tiene artículos que todavía no ingresaron
  sucursal: string | null;
};

/** Marca de la pregunta al cliente. Se busca en el historial para reconocer la respuesta ("Chef"). */
export const PREGUNTA_MARCA = "¿De qué marca es el pedido";
const VENTANA_MIN = 30;

const RE_CHEF = /\bche+f/i;
const RE_LK = /\b(lo[eé]?[kq]u?e\w*|loeck\w*|lk)\b/i;
const RE_AMBAS = /\b(los\s+dos|las\s+dos|ambos|ambas|los\s+2|todos|todas)\b/i;

/** Marca nombrada en un texto: "Chef", "Loeke", "los dos". null = no nombra ninguna. */
export function marcaEnTexto(text: string): Marca | null {
  const ch = RE_CHEF.test(text), lk = RE_LK.test(text);
  if ((ch && lk) || RE_AMBAS.test(text)) return "ambas";
  return ch ? "chef" : lk ? "lk" : null;
}

// "¿Cuándo llega mi pedido?", "¿dónde está mi pedido?", "¿ya salió?": preguntas por la llegada, que RE_ESTADO_PEDIDO y
// RE_PLAZO_ENTREGA (faq.ts) no cubren.
const RE_CUANDO_LLEGA = /\b(cu[aá]ndo|qu[eé]\s+d[ií]a|a\s+qu[eé]\s+hora)\b[^.?!]{0,40}\b(llega\w*|entreg\w*|sale\w*|despach\w*|viene\w*|traen|mandan|env[ií]an|reciben)\b|\bd[oó]nde\s+(est[aá]|anda|viene|qued[oó])(?![a-zñáéíóú])[^.?!]{0,30}\b(pedido|mercader[ií]a|compra)\b|\b(ya\s+)?(sali[oó]|despacharon|enviaron|mandaron)(?![a-zñáéíóú])[^.?!]{0,30}\b(pedido|mercader[ií]a)\b/i;
const RE_PEDIDO_PALABRA = /\b(pedidos?|mercader[ií]a|compra|orden|entregas?|env[ií]os?)\b/i;
// "el pedido del 17/9": con fecha explícita el pedido lo busca la IA (mismo criterio que faq.ts).
const RE_FECHA = /\b\d{1,2}\s*[/-]\s*\d{1,2}\b|\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/i;

/** ¿Pregunta por el estado o la llegada de su pedido? (no un reclamo "no me llegó" ni "cuándo ingresa el artículo"). */
export function esConsultaEstado(text: string): boolean {
  const t = text.trim();
  if (!t || RE_NO_LLEGO.test(t) || RE_INGRESO.test(t)) return false;
  if (RE_ESTADO_PEDIDO.test(t) || RE_PLAZO_ENTREGA.test(t)) return true;
  if (!RE_CUANDO_LLEGA.test(t)) return false;
  if (RE_PEDIDO_PALABRA.test(t)) return true;
  // "¿Cuándo llega?" suelto: sólo si es corto y no nombra un código ("¿cuándo llega el 404E?" es de stock).
  return t.split(/\s+/).length <= 6 && !/\d{3}/.test(t);
}

// ── texto ────────────────────────────────────────────────────────────────────────────────────────
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const conDia = (iso: string) => `${DIAS[new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay()]} ${ddmm(iso)}`;
const diaAR = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(iso));
const hoyAR = () => diaAR(new Date().toISOString());
const diasEntre = (hasta: string, desde: string) => Math.round((Date.parse(hasta.slice(0, 10)) - Date.parse(desde.slice(0, 10))) / 86400_000);

const ESTADO_TXT: Record<string, string> = {
  sin_programar: "📝 recibido, todavía sin fecha de salida",
  recibido: "📝 recibido, todavía sin fecha de salida",
  programado: "🚚 programado",
  en_armado: "🛠️ en preparación en el depósito",
  armado: "🛠️ en preparación en el depósito",
  pickeado: "🛠️ en preparación en el depósito",
  facturado: "🧾 facturado, listo para salir",
  entregado: "✅ entregado",
};
const CON_FECHA = new Set(["programado", "en_armado", "armado", "pickeado", "facturado"]);

export const CIERRE_PEDIDOS = "Si tu consulta es por otro pedido, decime de qué fecha es y lo revisamos.";

/**
 * Pedidos de Chef que le faltan entregar, en el formato de lookupOrderStatus (faq.ts). `hoy` = yyyy-mm-dd.
 * Se listan los que faltan entregar (hasta 8) y el entregado en los últimos 3 días; lo demás se da por entregado.
 * null = no hay nada para decir (sin pedidos pendientes y `soloSiHay`): el que llama sigue por otro camino.
 */
export function textoPedidosChef(
  nombre: string, pedidos: PedidoChef[], hoy: string,
  opts: { cierre?: boolean; soloSiHay?: boolean; sinNombre?: boolean } = {},
): string | null {
  const cierre = opts.cierre !== false;
  const saludo = opts.sinNombre ? "" : `${nombre}, `;
  const cola = cierre ? `\n\n${CIERRE_PEDIDOS}` : "";
  const nuevos = [...pedidos].sort((a, b) => b.creado.localeCompare(a.creado));

  const visibles = nuevos.filter((p) => {
    if (!p.estado) return diasEntre(hoy, diaAR(p.creado)) <= 7;           // recién cargado: todavía no figura en Gestión
    if (p.estado === "entregado") return !!(p.entregado_at ?? p.fecha_entrega) && diasEntre(hoy, String(p.entregado_at ?? p.fecha_entrega)) <= 3;
    return true;
  }).slice(0, 8);

  if (!visibles.length) {
    if (opts.soloSiHay) return null;
    if (!nuevos.length) {
      return `${saludo}no veo pedidos de Chef en los últimos 30 días. Si hiciste uno por otro medio, decime de qué fecha es y se lo paso a una persona del equipo.`;
    }
    const u = nuevos[0];
    const cuando = u.entregado_at ?? u.fecha_entrega;
    return `${saludo}todos tus pedidos de Chef están entregados. El último, del ${ddmm(diaAR(u.creado))}, ${cuando ? `se entregó el ${conDia(String(cuando))}` : "figura entregado"}.${cola}`;
  }

  const variasSuc = new Set(visibles.map((p) => p.sucursal ?? "")).size > 1;
  const lineas = visibles.map((p, i) => {
    const estado = p.estado ?? "recibido";
    const reingresa = p.reingreso && p.reingreso > hoy;
    let l = `${i + 1}️⃣ Pedido del ${ddmm(diaAR(p.creado))}${variasSuc && p.sucursal ? ` (${p.sucursal})` : ""} — `;
    if (reingresa) {
      // Con artículos que todavía no ingresaron la fecha de la vista puede no ser la de salida: la confirma una persona.
      return l + `📝 recibido: tiene artículos que ingresan desde el ${ddmm(p.reingreso!)}; una persona del equipo te confirma la fecha de salida`;
    }
    l += ESTADO_TXT[estado] ?? estado;
    if (estado === "entregado") {
      const cuando = p.entregado_at ?? p.fecha_entrega;
      if (cuando) l += ` el ${conDia(String(cuando))}`;
    } else if (CON_FECHA.has(estado) && p.fecha_entrega && p.fecha_entrega >= hoy) {
      l += p.retiro ? `: lo podés retirar desde el ${conDia(p.retiro)}` : `: sale el ${conDia(p.fecha_entrega)}`;
    }
    return l;
  });
  const hayEntregado = visibles.some((p) => p.estado === "entregado");
  const unoSolo = visibles.length === 1;
  const titulo = hayEntregado
    ? (unoSolo ? "este es tu pedido de Chef en curso" : "estos son tus pedidos de Chef en curso")
    : (unoSolo ? "este es tu pedido de Chef que falta entregar" : "estos son tus pedidos de Chef que faltan entregar");
  const resto = nuevos.length > visibles.length ? "Los demás pedidos ya están entregados. " : "";
  return `${saludo}${titulo}:\n\n${lineas.join("\n")}\n\n${resto}${cierre ? CIERRE_PEDIDOS : ""}`.trimEnd();
}

// ── datos ────────────────────────────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
const payload = (o: any, ...claves: string[]): string | null => {
  for (const k of claves) { const v = String(o?.sheets_payload?.[k] ?? "").trim(); if (v) return v; }
  return null;
};

/**
 * Pedidos de Chef de los últimos 30 días de un cliente, con su estado en Gestión. `cuit` cruza con Chef (un cliente de
 * Loekemeyer); `codChef` es el código de Chef de un cliente sólo de Chef (no se usa para uno de Loekemeyer: el número es otro
 * cliente en cada empresa). null = no se pudo leer (el que llama no debe decir "no tenés pedidos").
 */
export async function pedidosChef(c: { cuit?: string | null; codChef?: string | null }): Promise<PedidoChef[] | null> {
  try {
    const cuit = cuitNorm(c.cuit);
    const filtros: string[] = [];
    if (cuit) filtros.push(`cuit.eq.${cuit}`, `cuit.eq.${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`);
    if (c.codChef && /^\d+$/.test(c.codChef)) filtros.push(`cod_cliente.eq.${c.codChef}`);
    if (!filtros.length) return [];
    const { data: cli, error: e1 } = await supabase.from("chef_customers_cache").select("id").or(filtros.join(","));
    if (e1) throw new Error(e1.message);
    const ids = (cli ?? []).map((r: { id: string }) => r.id);
    if (!ids.length) return [];
    const { data: ords, error: e2 } = await supabase.from("chef_orders_cache").select("id, created_at, sheets_payload")
      .in("customer_id", ids).gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
      .order("created_at", { ascending: false }).limit(15);
    if (e2) throw new Error(e2.message);
    const anul = await pedidosAnulados("chef");
    // deno-lint-ignore no-explicit-any
    const vivos = ((ords ?? []) as any[]).filter((o) => !anul.has(Number(o.id)));
    if (!vivos.length) return [];

    const g = await getGestionClient("public");
    const r = await Promise.race([
      g.from("gv_pedido_web_estado_pagina").select("order_id, estado, fecha_entrega, entregado_at")
        .eq("empresa", "chef").in("order_id", vivos.map((o) => Number(o.id))),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
    ]);
    if (r.error) throw new Error(r.error.message);
    // deno-lint-ignore no-explicit-any
    const est = new Map<number, any>((r.data ?? []).map((e: { order_id: number }): [number, unknown] => [Number(e.order_id), e]));
    return vivos.map((o) => {
      const e = est.get(Number(o.id));
      return {
        creado: String(o.created_at),
        estado: e?.estado ? String(e.estado) : null,
        fecha_entrega: e?.fecha_entrega ? String(e.fecha_entrega).slice(0, 10) : null,
        entregado_at: e?.entregado_at ? String(e.entregado_at).slice(0, 10) : null,
        retiro: payload(o, "retiro_fecha")?.slice(0, 10) ?? null,
        reingreso: payload(o, "reingreso_desde")?.slice(0, 10) ?? null,
        sucursal: payload(o, "sucursalEntrega", "sucursal_entrega"),
      };
    });
  } catch (e) {
    console.error("pedidosChef:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function preguntaPendiente(phone: string): Promise<boolean> {
  const { data } = SIM.activo
    ? { data: SIM.historial.slice(-1) }
    : await supabase.from("bot_historial_chat").select("rol, contenido, creado_en")
      .eq("telefono", phone).order("creado_en", { ascending: false }).limit(1);
  const ult = data?.[0];
  if (!ult || ult.rol !== "assistant" || !String(ult.contenido ?? "").includes(PREGUNTA_MARCA)) return false;
  return Date.now() - new Date(ult.creado_en).getTime() <= VENTANA_MIN * 60_000;
}

// lookupOrderStatus (faq.ts) titula "…que falta(n) entregar" o "…en curso" cuando hay algo pendiente.
const lkTienePendientes = (t: string | null) => !!t && /\b(falta|faltan) entregar|\ben curso\b/.test(t);

/**
 * Cliente de Loekemeyer que consulta por su pedido (el flujo de un cliente sólo de Chef está en chef.ts). Devuelve la
 * respuesta o null si no corresponde (otro tema, o sin pedidos de Chef en curso: sigue el flujo de Loekemeyer de siempre).
 */
export async function responderEstadoPedidos(
  phone: string, text: string, customer: NonNullable<Customer>,
): Promise<{ reply: string; via: string } | null> {
  const nombre = customer.business_name;
  const hoy = hoyAR();
  const porMarca = async (marca: Marca, chef: PedidoChef[] | null) => {
    if (marca === "lk") return (await lookupOrderStatus(customer)) ?? "";
    if (chef === null) return null;
    if (marca === "chef") return textoPedidosChef(nombre, chef, hoy)!;
    const lk = (await lookupOrderStatus(customer)) ?? "";
    return `*Loekemeyer*\n${lk}\n\n*Chef*\n${textoPedidosChef(nombre, chef, hoy, { cierre: false, sinNombre: true })!}`;
  };

  // 1) Contesta la pregunta de marca que le hicimos (se mira el historial sólo si el mensaje nombra una marca).
  const respuesta = marcaEnTexto(text);
  if (respuesta && await preguntaPendiente(phone)) {
    const chef = respuesta === "lk" ? [] : await pedidosChef({ cuit: (await ctxPagosDeCliente(customer)).cuit });
    const reply = await porMarca(respuesta, chef);
    if (reply) return { reply, via: `estado_pedidos (${respuesta})` };
  }

  // 2) Pregunta por su pedido.
  if (!esConsultaEstado(text) || RE_FECHA.test(text)) return null;
  const nombrada = marcaEnTexto(text);
  if (nombrada === "lk") return null;            // dijo Loekemeyer: el flujo de siempre
  const chef = await pedidosChef({ cuit: (await ctxPagosDeCliente(customer)).cuit });
  if (!chef) return null;                        // Gestión no respondió: no se afirma nada de Chef
  if (nombrada) {
    const reply = await porMarca(nombrada, chef);
    return reply ? { reply, via: `estado_pedidos (${nombrada})` } : null;
  }
  const chefPend = textoPedidosChef(nombre, chef, hoy, { soloSiHay: true });
  if (!chefPend) return null;                    // sin pedidos de Chef en curso: Loekemeyer como siempre
  if (!lkTienePendientes(await lookupOrderStatus(customer))) {
    return { reply: chefPend, via: "estado_pedidos (chef)" };
  }
  return {
    reply: `${nombre}, tenés pedidos en curso de las dos marcas. ${PREGUNTA_MARCA} que consultás: *Loekemeyer* o *Chef*? (o escribí *los dos*)`,
    via: "estado_pedidos (pregunta la marca)",
  };
}
