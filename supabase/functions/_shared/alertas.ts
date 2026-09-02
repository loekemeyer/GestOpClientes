// _shared/alertas.ts — pipeline de aviso humano (stub).
//
// Por ahora solo escribe filas a `wa_alertas_humano`. Cuando exista el
// sistema de notificación real (WhatsApp al vendedor, email, dashboard,
// etc.), un consumidor lee esta cola y hace el resto — sin tocar los
// call-sites que ya usan `notificarHumano`.

import { supabase } from "./supabase.ts";

export type TipoAlerta = "llm_timeout" | "llm_error" | "faq_no_match" | "escalation" | "otro";
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
