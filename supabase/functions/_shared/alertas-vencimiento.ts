// Categorías y vencimiento de las alertas para humanos (wa_alertas_humano).
// Lo usan lk_alertas (bandeja del dashboard) y lk_fallas-mail (mail de vencidas), así los dos
// calculan el mismo vencimiento. Minutos por categoría editables en app_settings.wa_alertas_vencimiento.

import { supabase } from "./supabase.ts";
import { esUrgente } from "./humor-reglas.ts";

export const SETTING_VENCIMIENTO = "wa_alertas_vencimiento";

// Nombre visible y vencimiento por defecto (minutos) de cada categoría.
export const CATEGORIAS: Record<string, { label: string; min: number }> = {
  cliente_molesto:        { label: "Cliente molesto", min: 30 },
  respuesta_aviso_cambio: { label: "Cambio o cancelación de pedido (respuesta a un aviso)", min: 60 },
  escalation:             { label: "Pidió hablar con una persona", min: 120 },
  comprobante_recibido:   { label: "Comprobante de pago recibido", min: 240 },
  comprobante_error:      { label: "Comprobante de pago con error", min: 120 },
  llm_timeout:            { label: "El bot no llegó a responder", min: 30 },
  llm_error:              { label: "El bot falló al responder", min: 30 },
  alta_cliente:           { label: "Alta de cliente nuevo", min: 1440 },
  blacklist:              { label: "Escribió un número bloqueado", min: 1440 },
  faq_no_match:           { label: "Pregunta sin respuesta", min: 240 },
  consulta_stock:         { label: "Consulta de stock sin disponibilidad", min: 120 },
  otro:                   { label: "Otros", min: 240 },
  whitelist_gate:         { label: "Número fuera de la lista de prueba", min: 1440 },
};

// deno-lint-ignore no-explicit-any
export function categoria(a: any): string {
  const motivo = String(a?.contexto?.motivo ?? "");
  if (motivo && CATEGORIAS[motivo]) return motivo;
  if (a?.contexto?.lead_id || motivo === "alta") return "alta_cliente";
  return CATEGORIAS[a?.tipo] ? a.tipo : "otro";
}

export async function vencimientos(): Promise<Record<string, number>> {
  const base = Object.fromEntries(Object.entries(CATEGORIAS).map(([k, v]) => [k, v.min]));
  const { data } = await supabase.from("app_settings").select("value").eq("key", SETTING_VENCIMIENTO).maybeSingle();
  try {
    const guardado = data?.value ? JSON.parse(data.value) : {};
    for (const [k, v] of Object.entries(guardado)) if (k in base && Number(v) > 0) base[k] = Number(v);
  } catch { /* JSON roto → defaults */ }
  return base;
}

// Urgencia de una alerta: la que se guardó al crearla (contexto.urgente, ver alertas.ts) o, para las
// alertas viejas que no la tienen, por categoría + texto.
const CATEGORIAS_URGENTES = new Set(["cliente_molesto", "respuesta_aviso_cambio", "comprobante_error"]);
// deno-lint-ignore no-explicit-any
export function urgente(a: any): boolean {
  const ctx = a?.contexto ?? {};
  if (typeof ctx.urgente === "boolean") return ctx.urgente;
  const texto = String(ctx.texto_recibido ?? ctx.texto ?? "");
  return CATEGORIAS_URGENTES.has(categoria(a)) || (texto ? esUrgente(texto) : false);
}
