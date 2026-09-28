// humor — cliente molesto y mensajes urgentes, sin IA (0 tokens). Pedido de Pablo Olejavetzky (28/09):
// "cuando notes que alguien responde con mal humor también lo envíes a una persona" y "darte cuenta
// qué mensajes son urgentes".
//
// Molesto: insultos, quejas fuertes ("una vergüenza", "nadie contesta", "estoy harto"), o gritos
// (mensaje en MAYÚSCULAS con varios signos). El webhook lo deriva a una persona antes de cualquier
// otra respuesta y la alerta queda urgente.
// Urgente: además de "molesto", palabras de apuro o de problema con la entrega/cobro.

import { supabase } from "./supabase.ts";
import { notificarHumano } from "./alertas.ts";
import { SIM } from "./simulacion.ts";
import { estaMolesto } from "./humor-reglas.ts";
export { esUrgente, estaMolesto } from "./humor-reglas.ts";

/**
 * Cliente molesto → alerta urgente (motivo cliente_molesto → tarea en Planify) y respuesta breve de
 * disculpa. Si ya hay una alerta de molestia abierta de ese número en las últimas 2 h, no crea otra.
 * null si el mensaje no es de alguien molesto.
 */
export async function atenderMalHumor(
  phone: string,
  text: string,
  customer: { customer_id: string; business_name: string } | null,
): Promise<string | null> {
  if (!estaMolesto(text)) return null;
  let yaAvisado = false;
  if (!SIM.activo) {
    const { data } = await supabase.from("wa_alertas_humano").select("id")
      .eq("phone", phone).in("estado", ["pendiente", "notificado"])
      .eq("contexto->>motivo", "cliente_molesto")
      .gt("created_at", new Date(Date.now() - 2 * 3600_000).toISOString()).limit(1);
    yaAvisado = !!data?.length;
  }
  if (yaAvisado) {
    return "Ya le avisé a una persona del equipo: te escribe por acá a la brevedad. 🙏";
  }
  await notificarHumano({
    tipo: "escalation", phone, customerId: customer?.customer_id ?? null,
    contexto: { motivo: "cliente_molesto", urgente: true, texto_recibido: text.trim().slice(0, 300),
      razon_social: customer?.business_name ?? null },
  });
  return "Perdón por las molestias. Ya le paso tu mensaje a una persona del equipo para que te responda cuanto antes por acá. 🙏";
}
