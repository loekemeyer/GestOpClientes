// Compuerta de `confirmar_pedido`: la decide el SERVIDOR, no el modelo (Pablo Olejavetzky, 06/10/2026, medida 1 de la lista de seguridad).
//
// Hasta acá, que el cliente hubiera visto el resumen y dicho "sí" era una REGLA DE PROMPT (agente-fijos.ts, paso 6): un jailbreak, o
// una orden escondida en un cotizador o una transcripción de audio, podía llamar a `confirmar_pedido` directo y cargar un pedido que
// el cliente nunca vio. Esto lo chequea en código, con tres condiciones que se cumplen TODAS:
//   1. El mensaje del cliente (lo que escribió desde la última respuesta del bot) es un sí a secas: sólo vocabulario de confirmación.
//      "sí pero cambiá…", "sí, y agregame…", "no", "¿cuánto sale?" no pasan: cualquier palabra fuera del vocabulario bloquea.
//   2. Lo último que dijo el bot es el resumen de un pedido (formato fijo de `armar_pedido`: "Tu pedido…", "Total…", "Entrega…").
//   3. Ese resumen es el MISMO que se va a cargar y tiene menos de 1 hora: cada renglón del resumen que el servidor acaba de rearmar
//      con los datos a cargar (razón social, cada artículo con sus cajas e importe, subtotal, forma de pago, total y entrega) está
//      igual en lo que vio el cliente, y vio la misma cantidad de artículos.
//
// Hasta el 08/10 el punto 3 miraba sólo los códigos y el total, y dejaba pasar otras cajas con el mismo total, otra entrega, un
// artículo menos o una forma de pago cuyo total coincidía con el subtotal mostrado (revisión de GPT Astra sobre 3d47af8, auditoría 740).
//
// Es la misma ventana que usa `ultimoDelBotEsDePedido` (pedido-turno.ts). Módulo PURO (sin red ni base): se prueba en
// tests/pedido-gate.test.ts. Falla cerrado: ante la duda NO se carga, el modelo vuelve a mostrar el resumen y el cliente confirma de nuevo.

export interface FilaHistorial { rol: string; contenido: string; creado_en: string }

export type MotivoBloqueo = "sin_si" | "sin_resumen" | "resumen_viejo" | "resumen_distinto";
export type VeredictoConfirmacion = { ok: true } | { ok: false; motivo: MotivoBloqueo };

/** Cuánto vale el resumen mostrado: pasada la hora, precios y stock pueden haber cambiado. */
export const VIGENCIA_RESUMEN_MS = 60 * 60_000;

// Palabras que SOLAS ya son un sí. Con estiramientos ("siii", "daleee", "okkk") y sin tildes (se normaliza antes).
const RE_SI = /^(?:si+p?|dale+|o+k+(?:ey|ay|a)?|listo+|confirm(?:o|ado|amos|a|ar|alo)|proce(?:de|da|der)|perfecto|correcto|adelante|vale|va|joya|barbaro|manda(?:l[eo])?|carga(?:lo|r)?|hacelo|exacto|genial|excelente|buenisimo)$/;

// Palabras que acompañan un sí sin cambiar nada ("sí, gracias", "de acuerdo", "dale, por favor"). Todo lo demás bloquea.
const RELLENO = new Set([
  "de", "acuerdo", "asi", "es", "por", "favor", "gracias", "muchas", "todo", "bien", "esta", "ya", "entonces", "claro", "obvio",
  "tal", "cual", "y", "bueno", "buen", "dia", "tarde", "noches", "hola", "che", "el", "pedido", "lo", "con", "eso",
]);

const MAX_PALABRAS = 10;

/** Palabras del mensaje, sin tildes. Los dígitos CUENTAN ("sí 5" no es un sí) y una letra de otro alfabeto deja una palabra "#" que
 *  nunca está en el vocabulario: lo que no se puede leer, bloquea. */
function palabras(texto: string): string[] {
  const t = String(texto ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // sin tildes
    .replace(/[\u{1F44D}\u{2705}\u{1F44C}\u{1F197}\u{1F64C}]/gu, " ok ")  // 👍 ✅ 👌 🆗 🙌
    .replace(/\b(?:de acuerdo|asi es)\b/g, " ok ");
  const ajeno = /[\p{L}\p{N}]/u.test(t.replace(/[a-z0-9]/g, ""));
  const p = t.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return ajeno ? [...p, "#"] : p;
}

/** ¿Es un sí a secas? Al menos una palabra de confirmación y NADA fuera del vocabulario (ni "pero", ni "no", ni números). */
export function esSiAsecas(texto: string): boolean {
  const p = palabras(texto);
  if (!p.length || p.length > MAX_PALABRAS) return false;
  if (!p.every((w) => RE_SI.test(w) || RELLENO.has(w))) return false;
  return p.some((w) => RE_SI.test(w));
}

/** Lo que el cliente escribió desde la última respuesta del bot. `historial` viene del más nuevo al más viejo (como `loadHistory`).
 *  El mensaje de ahora puede no estar guardado todavía (`lk_chat-test` no lo guarda antes), por eso se agrega si falta. Si el cliente
 *  mandó dos mensajes seguidos ("sí" y "gracias") el webhook contesta sólo el último: se miran los dos. */
export function textosSinContestar(historial: FilaHistorial[], textoActual: string): string[] {
  const out: string[] = [];
  for (const h of historial) {
    if (h.rol === "assistant") break;
    if (h.rol === "user") out.push(String(h.contenido ?? ""));
  }
  if (!out.length || out[0] !== textoActual) out.unshift(textoActual);
  return out;
}

/** ¿El texto del bot es un resumen de pedido en el formato de `armar_pedido`? */
export function esResumenDePedido(texto: string): boolean {
  return /tu\s+pedido/i.test(texto) && /total/i.test(texto) && /entrega/i.test(texto);
}

/** Un historial con fecha más adelante que el reloj del servidor no es confiable (falla cerrado). Margen por diferencia de relojes. */
const TOLERANCIA_RELOJ_MS = 2 * 60_000;

/** Renglón comparable: sin negritas ni viñeta inicial, guiones largos como "-", espacios simples y minúsculas. Sólo tolera lo que
 *  WhatsApp o el modelo cambian de forma; cajas, códigos, importes, forma de pago y entrega tienen que estar iguales. */
function renglon(s: string): string {
  return s.replace(/[*_~]/g, "").replace(/[–—]/g, "-").replace(/^\s*[•·-]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}
const renglones = (texto: string) => String(texto ?? "").split(/\r?\n/).map(renglon).filter(Boolean);

/** Renglón de artículo del resumen: "3 cajas Pelapapas (505) - $120.000". */
const RE_RENGLON_ARTICULO = /^\d+ cajas? .*\([^()]*\) - \$\d[\d.]*$/;
const cuantosArticulos = (rs: string[]) => rs.filter((r) => RE_RENGLON_ARTICULO.test(r)).length;

export interface EntradaConfirmacion {
  /** Mensaje del cliente en este turno. */
  textoCliente: string;
  /** Historial del más nuevo al más viejo. */
  historial: FilaHistorial[];
  /** Resumen que el servidor acaba de rearmar con los datos que se van a cargar (`resumen_para_el_cliente` de armar_pedido). */
  resumen: string;
  ahora?: number;
}

export function evaluarConfirmacion(e: EntradaConfirmacion): VeredictoConfirmacion {
  const textos = textosSinContestar(e.historial, e.textoCliente);
  const sinPalabrasRaras = textos.every((t) => palabras(t).every((w) => RE_SI.test(w) || RELLENO.has(w)) && palabras(t).length <= MAX_PALABRAS);
  if (!sinPalabrasRaras || !textos.some(esSiAsecas)) return { ok: false, motivo: "sin_si" };

  const ult = e.historial.find((h) => h.rol === "assistant");
  const visto = String(ult?.contenido ?? "");
  if (!ult || !esResumenDePedido(visto)) return { ok: false, motivo: "sin_resumen" };

  const t = new Date(ult.creado_en).getTime();
  const ahora = e.ahora ?? Date.now();
  if (!Number.isFinite(t) || ahora - t > VIGENCIA_RESUMEN_MS || t - ahora > TOLERANCIA_RELOJ_MS) return { ok: false, motivo: "resumen_viejo" };

  // Cada renglón del resumen a cargar tiene que estar en lo que vio el cliente, y con la misma cantidad de artículos: así un
  // artículo de más en lo visto (o de menos en lo que se carga) tampoco pasa.
  const aCargar = renglones(e.resumen);
  const vistos = renglones(visto);
  const set = new Set(vistos);
  const articulos = cuantosArticulos(aCargar);
  if (!articulos || !esResumenDePedido(e.resumen) || !aCargar.every((r) => set.has(r)) || cuantosArticulos(vistos) !== articulos) {
    return { ok: false, motivo: "resumen_distinto" };
  }
  return { ok: true };
}

/** ¿El cliente ya dijo "sí" a ESTE resumen? Lo usa `armar_pedido` cuando el agente lo vuelve a llamar en el turno del "sí" (el paso 6
 *  se lo permite para tener los datos): sin esto, la `regla` de siempre ("mostrale el resumen y pedile que confirme") lo hacía repetir
 *  el resumen y el cliente tenía que decir "sí" dos veces (Sonnet 4.6 en el Simulador, 08/10, auditoría 742). Es la misma compuerta
 *  de `confirmar_pedido`, así que sólo da true si `confirmar_pedido` con estos datos va a pasar. */
export function yaConfirmoEsteResumen(e: EntradaConfirmacion): boolean {
  return evaluarConfirmacion(e).ok;
}

/** La `regla` de `armar_pedido` cuando el cliente ya confirmó ese mismo resumen. */
export const REGLA_YA_CONFIRMO = "El cliente ya confirmó este mismo resumen con un sí: llamá confirmar_pedido AHORA con exactamente estos datos (mismos artículos y cajas, condicion_code, slot y retiro) y pasale su texto_para_el_cliente. No le vuelvas a mostrar el resumen ni le pidas otra confirmación.";

/** Lo que se le dice al MODELO cuando la compuerta no deja cargar (nunca al cliente tal cual: no revela el mecanismo). */
export const REGLA_BLOQUEO: Record<MotivoBloqueo, string> = {
  sin_si: "No se cargó: el cliente todavía no confirmó con un sí. Mostrale el resumen de armar_pedido tal cual y pedile que confirme con un sí. No vuelvas a llamar confirmar_pedido hasta que lo diga.",
  sin_resumen: "No se cargó: el cliente todavía no vio el resumen. Llamá armar_pedido, mostrale el resumen tal cual y pedile que confirme con un sí.",
  resumen_viejo: "No se cargó: el resumen que vio el cliente es de hace más de una hora. Llamá armar_pedido, mostrale el resumen actualizado tal cual y pedile que confirme de nuevo con un sí.",
  resumen_distinto: "No se cargó: lo que querés cargar no coincide con el resumen que vio el cliente (artículos, cajas, forma de pago, entrega o total). Llamá armar_pedido con lo que el cliente confirmó, mostrale resumen_para_el_cliente tal cual, renglón por renglón y sin cambiarle nada, y pedile que confirme con un sí.",
};
