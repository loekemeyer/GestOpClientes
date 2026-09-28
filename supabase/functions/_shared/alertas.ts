// _shared/alertas.ts — pipeline de aviso humano (stub).
//
// Por ahora solo escribe filas a `wa_alertas_humano`. Cuando exista el
// sistema de notificación real (WhatsApp al vendedor, email, dashboard,
// etc.), un consumidor lee esta cola y hace el resto — sin tocar los
// call-sites que ya usan `notificarHumano`.

import { supabase } from "./supabase.ts";
import { SIM } from "./simulacion.ts";
import { esUrgente } from "./humor-reglas.ts";

// Categorías que siempre son urgentes (además de lo que diga el texto).
const MOTIVOS_URGENTES = new Set(["cliente_molesto", "respuesta_aviso_cambio", "comprobante_error"]);

export type TipoAlerta =
  | "llm_timeout"
  | "llm_error"
  | "faq_no_match"
  | "escalation"
  | "whitelist_gate"   // mensaje descartado por la whitelist (lo inserta el webhook, no este helper)
  | "otro";
// "escalation" queda declarado para cablear el aviso de las FAQ categoría
// HUMANO cuando se decida notificar. Hoy NO hay call-site que lo use.

export interface AlertaHumanoInput {
  tipo: TipoAlerta;
  phone?: string | null;
  customerId?: string | null;
  contexto?: Record<string, unknown>;
}

/**
 * Encola un aviso para revisión humana. Fire-and-forget: nunca lanza,
 * porque no queremos romper el flujo del bot por un fallo del logger.
 */
export async function notificarHumano(a: AlertaHumanoInput): Promise<void> {
  const ctx: Record<string, unknown> = { ...(a.contexto ?? {}) };
  if (ctx.urgente === undefined) {
    const texto = String(ctx.texto_recibido ?? ctx.texto ?? ctx.userText ?? "");
    ctx.urgente = MOTIVOS_URGENTES.has(String(ctx.motivo ?? "")) || (texto ? esUrgente(texto) : false);
  }
  a = { ...a, contexto: ctx };
  if (SIM.activo) { SIM.alertas.push({ tipo: a.tipo, ...ctx }); return; }
  try {
    await supabase.from("wa_alertas_humano").insert({
      tipo: a.tipo,
      phone: a.phone ?? null,
      customer_id: a.customerId ?? null,
      contexto: a.contexto ?? {},
    });
  } catch (e) {
    console.error("[notificarHumano] no pude encolar la alerta:", e);
  }
}
