import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { supabase } from "../_shared/supabase.ts";

// lk_vinculaciones — revisión humana de teléfonos nuevos que dicen ser un cliente (sql/072).
// La usa el dashboard (Panel de Control → Vinculaciones). Sólo admins (requireAdmin).
//
//   {action:"list"}                                         → solicitudes pendientes (bot_register_pending)
//   {action:"decide", request_id, decision, motivo?}        → aprueba/rechaza (bot_register_decide)
//
// El aviso al que pidió la vinculación NO se manda desde acá: se ENCOLA en wa_outbox y lo despacha
// lk_outbox-flush detrás de la llave wa_envio_automatico (principio D007: un solo corte de salida).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function avisoAlSolicitante(decision: string, tipo: string, negocio: string, motivo: string): string {
  if (decision === "approve") {
    return tipo === "pedidos_access"
      ? "Hola, te escribimos de Loekemeyer.\nYa habilitamos tu número para consultar tus pedidos."
      : `Hola ${negocio}, te escribimos de Loekemeyer.\nYa vinculamos este número a tu cuenta: podés consultar tus pedidos, descuentos y fechas de entrega.`;
  }
  return "Hola, te escribimos de Loekemeyer.\nNo pudimos confirmar la vinculación de este número" +
    (motivo ? ` (${motivo})` : "") +
    ".\nSi creés que es un error, escribinos a ventas@loekemeyer.com o al WhatsApp 11 3118 1021.";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const gate = await requireAdmin(body);
    if (!gate.ok) return json({ error: gate.error }, gate.status);

    if (body.action === "list") {
      const { data, error } = await supabase.rpc("bot_register_pending");
      if (error) return json({ ok: false, error: error.message }, 200);
      return json({ ok: true, pendientes: data ?? [] });
    }

    if (body.action === "decide") {
      const requestId = Number(body.request_id);
      const decision = String(body.decision ?? "");
      const motivo = String(body.motivo ?? "").trim();
      if (!requestId || (decision !== "approve" && decision !== "reject")) {
        return json({ ok: false, error: "parámetros inválidos" }, 400);
      }
      if (decision === "reject" && !motivo) return json({ ok: false, error: "El rechazo necesita un motivo." }, 400);

      const { data, error } = await supabase.rpc("bot_register_decide", {
        p_request_id: requestId, p_decision: decision, p_agente: gate.email, p_motivo: motivo || null,
      });
      if (error) return json({ ok: false, error: error.message }, 200);
      const row = Array.isArray(data) ? data[0] : null;
      if (!row?.ok) return json({ ok: false, error: `No se pudo decidir (estado: ${row?.status ?? "error"}).` }, 200);

      if (row.telefono) {
        const { error: eOut } = await supabase.from("wa_outbox").insert({
          phone: row.telefono,
          body: avisoAlSolicitante(decision, String(row.tipo ?? "registro"), String(row.business_name ?? ""), motivo),
          context: decision === "approve" ? "vinculacion_aprobada" : "vinculacion_rechazada",
          ref_id: String(requestId),
        });
        if (eOut) console.error("lk_vinculaciones: no se pudo encolar el aviso:", eOut.message);
      }
      console.log(`lk_vinculaciones: ${decision} #${requestId} por ${gate.email}`);
      return json({ ok: true, status: row.status });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_vinculaciones error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
