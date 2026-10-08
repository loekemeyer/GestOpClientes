// hechos-charla — memoria de la charla para el agente IA: lo que YA pasó con este número aunque haya quedado fuera de las 16 filas de
// historial que lee runConversation. Pablo Olejavetzky, 08/10/2026 ("qué le falta para ser un agente", paso 2, opción A).
//
// Caso que lo motivó (Damián, Chef 411, 08/10): a las 09:32 la capa fija pasó su consulta a Ventas (alerta 858). A las 09:42 preguntó
// "¿me van a llamar hoy, mañana o en cuántos minutos?" y contestó Sonnet 4.6, pero el pase de las 09:32 ya no estaba en las 16 filas (la
// última que entraba era la de las 09:33): el agente no sabía que había una persona en camino y le mandó la foto del 505 por quinta vez.
//
// El bloque lo arma el CÓDIGO en cada turno, sin IA (0 tokens de salida, US$ 0 de armado), con dos cosas:
//   1. pases a una persona (wa_alertas_humano) de este número: los abiertos de los últimos 7 días y los atendidos de las últimas 24 h.
//      Sólo los motivos de MOTIVOS (lista cerrada): las alertas internas (errores de la IA, tope de gasto, filtro de salida, canario,
//      whitelist…) nunca llegan al prompt. Sin texto libre del cliente: motivo, hora y estado.
//   2. acciones del bot con efecto para el cliente (bot_auditoria) de las últimas 24 h: fotos, catálogo, pedidos cargados. Las que dejan
//      una alerta (derivar_a_persona, solicitar_*) ya salen por el punto 1.
// Va en la parte VARIABLE del prompt (bot-conversation.ts, promptVariable), así no rompe el caché de la base.
// En el Simulador sale de SIM.charla (lo que pasó en la simulación entera); no lee la base.

import { supabase } from "./supabase.ts";
import { SIM } from "./simulacion.ts";
import { conTope } from "./ejemplos-aprobados.ts";

export type AlertaHecho = { tipo: string; estado: string; motivo?: string | null; simulador?: unknown; created_at: string; atendido_at?: string | null };
export type AccionHecho = { nombre: string; parametros?: Record<string, unknown> | null; resultado?: string | null; creado_en: string };

// Motivo (contexto.motivo, o el tipo si la alerta no trae motivo) → cómo se lo nombra al agente. Lo que no está acá NO se muestra.
export const MOTIVOS: Record<string, string> = {
  entrega: "la entrega de un pedido",
  reclamo: "un reclamo",
  pago: "pagos",
  reclamo_saldo: "el saldo de su cuenta",
  cambio_pedido: "un cambio en un pedido",
  anulacion_pedido: "la anulación de un pedido",
  pedido_no_encontrado: "un pedido que no encontramos",
  excepcion_minimo: "una excepción al pedido mínimo",
  cambio_datos: "un cambio de datos de su cuenta",
  consulta_stock: "stock",
  devolucion: "una devolución",
  acceso_web: "el acceso a la web",
  reseteo_clave: "la clave de la web",
  nota_cliente: "una nota o pedido que dejó para el equipo",
  pedido_archivo: "un pedido que mandó por archivo",
  pedido_mail: "un pedido que mandó por mail",
  pedido_whatsapp: "un pedido por WhatsApp",
  respuesta_aviso_cambio: "su respuesta a un aviso de un pedido",
  cliente_molesto: "su pedido de que lo atienda una persona",
  cliente_chef: "una consulta de Chef",
  alta_cliente: "su alta como cliente",
  alta_cliente_nuevo: "su alta como cliente",
  solicitud_alta_completa: "su alta como cliente",
  adjunto_recibido: "un archivo que mandó",
  comprobante_recibido: "un comprobante de pago que mandó",
  comprobante_error: "un comprobante de pago que mandó",
  escalation: "una consulta que necesitaba una persona",
};

// Acciones del agente que el cliente ve y que no dejan alerta. confirmar_pedido / enviar_pedido sólo cuentan si salieron bien.
export const ACCIONES = ["enviar_fotos_producto", "enviar_catalogo", "confirmar_pedido", "enviar_pedido"];

const H24 = 24 * 3600_000;
const D7 = 7 * H24;
const MAX_LINEAS = 8;

// Hora de Argentina armada a mano: "es-AR" con 2-digit da "5/10" o "05/10" según la versión de ICU (Deno local vs. edge runtime).
const FMT_AR = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function partesAR(d: Date): { dia: string; hm: string } {
  const p: Record<string, string> = {};
  for (const x of FMT_AR.formatToParts(d)) p[x.type] = x.value.padStart(2, "0");
  return { dia: `${p.day}/${p.month}`, hm: `${p.hour}:${p.minute}` };
}
function hora(iso: string, ahora: Date): string {
  const d = partesAR(new Date(iso));
  return d.dia === partesAR(ahora).dia ? `hoy ${d.hm}` : `${d.dia} ${d.hm}`;
}

// Lista cerrada: con motivo, vale sólo si el motivo está en MOTIVOS (faq_no_match, tope_gasto, download_meta… no); sin motivo, vale
// el tipo ("escalation" de una FAQ que pide una persona, "comprobante_recibido"; "otro" o "llm_timeout" no). Un motivo nuevo que nadie
// agregó acá no se muestra: falla cerrado.
function motivoDe(a: AlertaHecho): string | null {
  return (a.motivo ? MOTIVOS[a.motivo] : MOTIVOS[a.tipo]) ?? null;
}

function lineaAlerta(a: AlertaHecho, ahora: Date): string | null {
  const t = Date.parse(a.created_at);
  if (!Number.isFinite(t) || a.estado === "descartado" || a.simulador === true || a.simulador === "true") return null;
  const motivo = motivoDe(a);
  if (!motivo) return null;
  const edad = ahora.getTime() - t;
  const abierta = a.estado !== "atendido";
  if (edad > D7 || (!abierta && edad > H24)) return null;
  const estado = abierta
    ? "Todavía no la tomó nadie: una persona le va a escribir por acá."
    : `En el sistema figura atendida${a.atendido_at ? ` (${hora(a.atendido_at, ahora)})` : ""}.`;
  return `- ${hora(a.created_at, ahora)}: se pasó a una persona su consulta sobre ${motivo}. ${estado}`;
}

function salioBien(resultado: string | null | undefined): boolean {
  const r = String(resultado ?? "");
  return /"ok":\s*true/.test(r) && !/"no_cargado":\s*true/.test(r) && !/"simulado":\s*true/.test(r);
}

function lineasAcciones(acciones: AccionHecho[], ahora: Date): string[] {
  const grupos = new Map<string, { texto: string; veces: number; ultima: string }>();
  for (const a of acciones) {
    const t = Date.parse(a.creado_en);
    if (!Number.isFinite(t) || ahora.getTime() - t > H24 || !ACCIONES.includes(a.nombre)) continue;
    const p = a.parametros ?? {};
    let clave: string, texto: string;
    if (a.nombre === "enviar_fotos_producto") {
      const cod = String(p.cod ?? "").replace(/[^\w.-]/g, "").slice(0, 20);
      if (!cod) continue;
      clave = `fotos:${cod}`; texto = `le mandaste la foto del cód. ${cod}`;
    } else if (a.nombre === "enviar_catalogo") {
      clave = "catalogo"; texto = "le mandaste el catálogo";
    } else {
      if (!salioBien(a.resultado)) continue;
      clave = `pedido:${a.creado_en}`; texto = "quedó cargado un pedido por WhatsApp";
    }
    const g = grupos.get(clave);
    if (!g) grupos.set(clave, { texto, veces: 1, ultima: a.creado_en });
    else { g.veces++; if (Date.parse(a.creado_en) > Date.parse(g.ultima)) g.ultima = a.creado_en; }
  }
  return [...grupos.values()]
    .sort((x, y) => Date.parse(y.ultima) - Date.parse(x.ultima))
    .map((g) => g.veces > 1
      ? `- ${g.texto[0].toUpperCase()}${g.texto.slice(1)}: ${g.veces} veces, la última ${hora(g.ultima, ahora)}.`
      : `- ${hora(g.ultima, ahora)}: ${g.texto}.`);
}

/** El bloque para el prompt. Vacío ("") si no hay nada que contar. Función pura: la prueban tests/hechos-charla.test.ts. */
export function bloqueHechos(alertas: AlertaHecho[], acciones: AccionHecho[], ahora = new Date()): string {
  const pases = [...alertas]
    .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))
    .map((a) => lineaAlerta(a, ahora)).filter((l): l is string => !!l)
    .slice(0, MAX_LINEAS);
  const hechas = lineasAcciones(acciones, ahora).slice(0, MAX_LINEAS);
  if (!pases.length && !hechas.length) return "";
  const partes = [
    "## Hechos de esta charla",
    "Lo que ya pasó con este cliente, aunque no figure en los mensajes de arriba. Usalo para no contradecirte ni repetir: si pregunta por " +
      "algo que ya se pasó a una persona, decile que ya está pasado y desde cuándo, en vez de hacer otra cosa. Que algo se mandó no " +
      "confirma que le llegó. No le leas esta lista.",
  ];
  if (pases.length) partes.push("Pases a una persona:", ...pases);
  if (hechas.length) partes.push("Lo que hizo el bot en las últimas 24 horas:", ...hechas);
  return partes.join("\n");
}

/** Lee los hechos de este número y arma el bloque. Nunca lanza ni demora el turno más de 1,5 s: ante cualquier problema, "". */
export async function hechosDeLaCharla(phone: string, ahora = new Date()): Promise<string> {
  if (SIM.activo) return bloqueHechos(SIM.charla.alertas, SIM.charla.acciones, ahora);
  if (!phone) return "";
  try {
    const desde7 = new Date(ahora.getTime() - D7).toISOString();
    const desde24 = new Date(ahora.getTime() - H24).toISOString();
    const [al, ac] = await conTope(Promise.all([
      supabase.from("wa_alertas_humano")
        .select("tipo, estado, created_at, atendido_at, motivo:contexto->>motivo, simulador:contexto->>simulador")
        .eq("phone", phone).neq("estado", "descartado").gte("created_at", desde7)
        .order("created_at", { ascending: false }).limit(30),
      supabase.from("bot_auditoria")
        .select("tool_usado, parametros, resultado_resumen, creado_en")
        .eq("telefono", phone).in("tool_usado", ACCIONES).gte("creado_en", desde24)
        .order("creado_en", { ascending: false }).limit(50),
    ]), 1500);
    if (al.error) console.warn("hechos-charla: alertas:", al.error.message);
    if (ac.error) console.warn("hechos-charla: acciones:", ac.error.message);
    const acciones = (ac.data ?? []).map((r: { tool_usado: string; parametros: Record<string, unknown> | null; resultado_resumen: string | null; creado_en: string }) =>
      ({ nombre: r.tool_usado, parametros: r.parametros, resultado: r.resultado_resumen, creado_en: r.creado_en }));
    return bloqueHechos((al.data ?? []) as AlertaHecho[], acciones, ahora);
  } catch (e) {
    console.warn("hechos-charla:", e instanceof Error ? e.message : e);
    return "";
  }
}
