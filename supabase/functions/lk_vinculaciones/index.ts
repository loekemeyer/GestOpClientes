import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { supabase } from "../_shared/supabase.ts";
import { cadenasListaPropia } from "../_shared/cadenas.ts";

// lk_vinculaciones — revisión humana de teléfonos nuevos que dicen ser un cliente (sql/072).
// La usa el dashboard (Panel de Control → Vinculaciones). Sólo admins (requireAdmin).
//
//   {action:"list"}                                         → solicitudes pendientes (bot_register_pending),
//                                                             con `cadena` si es una cadena con lista propia (sql/114)
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

function avisoAlSolicitante(decision: string, tipo: string, negocio: string, motivo: string, empresa = "LK"): string {
  // sql/116: cuenta de Chef. El bot todavía le contesta sólo facturas y datos de pago (_shared/chef.ts): no se le
  // promete ver pedidos ni descuentos.
  if (empresa === "CH") {
    return decision === "approve"
      ? `Hola ${negocio}, te escribimos de Chef.\nYa vinculamos este número a tu cuenta: por acá podés consultar tus facturas pendientes y los datos de pago, y para todo lo demás te responde una persona del equipo.`
      : "Hola, te escribimos de Chef.\nNo pudimos confirmar la vinculación de este número" + (motivo ? ` (${motivo})` : "") +
        ".\nSi creés que es un error, respondé este mensaje y lo revisamos.";
  }
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
      // Texto EXACTO del aviso que se encola al decidir (Centro de mensajes › Tareas lo muestra en el
      // modal de confirmación). En el rechazo, {{motivo}} lo completa el front con lo que escribe la persona.
      // cadena: si el cliente es una cadena con lista propia, el front avisa antes de aprobar (Pablo, 01/10).
      const cadenas = await cadenasListaPropia((data ?? []).filter((r: Record<string, unknown>) => r.empresa !== "CH")
        .map((r: Record<string, unknown>) => r.cod_cliente));
      const pendientes = (data ?? []).map((r: Record<string, unknown>) => ({
        ...r,
        aviso_aprobar: avisoAlSolicitante("approve", String(r.tipo ?? "registro"), String(r.business_name ?? ""), "", String(r.empresa ?? "LK")),
        aviso_rechazar: avisoAlSolicitante("reject", String(r.tipo ?? "registro"), "", "{{motivo}}", String(r.empresa ?? "LK")),
        // sql/114 sólo conoce códigos de LK: en una solicitud de Chef el mismo número es otro cliente.
        cadena: r.empresa === "CH" ? null : cadenas.get(Number(r.cod_cliente)) ?? null,
      }));
      return json({ ok: true, pendientes });
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
        const { data: req } = await supabase.from("bot_registration_requests").select("empresa").eq("id", requestId).maybeSingle();
        const { error: eOut } = await supabase.from("wa_outbox").insert({
          phone: row.telefono,
          body: avisoAlSolicitante(decision, String(row.tipo ?? "registro"), String(row.business_name ?? ""), motivo, String(req?.empresa ?? "LK")),
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
