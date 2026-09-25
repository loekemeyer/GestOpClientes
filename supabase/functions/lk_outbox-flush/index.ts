// lk_outbox-flush — despacha wa_outbox por WhatsApp (Meta Graph API). Reemplaza el flush del
// webhook nuevo, que moría por buscar credenciales con nombres LK_WA_* inexistentes. Acá usa
// las del proyecto (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID), con fallback a LK_WA_*.
// Lo llama pg_cron. verify_jwt=false. Usa bot_flush_outbox / bot_outbox_mark (RPCs existentes).
// Tras enviar OK, también loggea en bot_historial_chat (rol=assistant) para que el mensaje
// aparezca en el módulo de Conversaciones.
// D007 (2026-09-25): además de la llave de bot_flush_outbox, el envío pasa por
// _shared/wa-guard.ts. Fuente versionada desde acá (antes v11 sólo en el proyecto); el resto es v11.
import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? Deno.env.get("LK_WA_PHONE_ID") ?? "";
const WA_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? Deno.env.get("LK_WA_TOKEN") ?? "";
const GRAPH = "https://graph.facebook.com/v21.0";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

function json(o: unknown, s: number) {
  return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
}
function canon(raw: string): string { return String(raw || "").replace(/\D/g, ""); }
// deno-lint-ignore no-explicit-any
async function waSend(payload: Record<string, any>) {
  const r = await fetch(`${GRAPH}/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const d = await r.json();
  return { ok: r.ok, d };
}
// deno-lint-ignore no-explicit-any
function rederTemplate(name: string, params: Record<string, any> | null): string {
  const arr = params ? Object.values(params).map((v) => String(v)) : [];
  return `[Plantilla: ${name}]` + (arr.length ? " " + arr.map((p, i) => `{${i + 1}}=${p}`).join(" · ") : "");
}

Deno.serve(async () => {
  if (!WA_PHONE_ID || !WA_TOKEN) return json({ ok: false, error: "faltan credenciales WA (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)" }, 501);

  const { data: batch, error } = await sb.rpc("bot_flush_outbox", { p_limit: 20 });
  if (error) return json({ ok: false, error: error.message }, 500);

  let sent = 0, failed = 0;
  // deno-lint-ignore no-explicit-any
  const errors: any[] = [];
  for (const m of (batch || [])) {
    // deno-lint-ignore no-explicit-any
    let payload: Record<string, any>;
    let historyText = "";
    if (m.template_name) {
      const lang = m.template_name === "hello_world" ? "en_US" : "es_AR";
      const params = m.template_params ? Object.values(m.template_params).map((v) => String(v)) : [];
      payload = {
        messaging_product: "whatsapp", to: m.phone, type: "template",
        template: {
          name: m.template_name, language: { code: lang },
          components: params.length ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] : [],
        },
      };
      historyText = rederTemplate(m.template_name, m.template_params);
    } else if (m.body) {
      payload = { messaging_product: "whatsapp", to: m.phone, type: "text", text: { body: String(m.body).slice(0, 4000) } };
      historyText = String(m.body);
    } else {
      await sb.rpc("bot_outbox_mark", { p_id: m.id, p_status: "failed", p_error: "sin body ni template" });
      failed++; continue;
    }
    const r = await waSend(payload);
    if (r.ok) {
      await sb.rpc("bot_outbox_mark", { p_id: m.id, p_status: "sent" });
      // Loggear el envío saliente en el historial para que aparezca en Conversaciones.
      try {
        await sb.rpc("bot_guardar_mensaje", { p_telefono: canon(m.phone), p_rol: "assistant", p_contenido: historyText });
      } catch (_) { /* no bloquear el flush si falla el log */ }
      sent++;
    } else {
      await sb.rpc("bot_outbox_mark", { p_id: m.id, p_status: "failed", p_error: JSON.stringify(r.d).slice(0, 500) });
      failed++; if (errors.length < 3) errors.push(r.d);
    }
  }
  return json({ ok: true, sent, failed, errors }, 200);
});
