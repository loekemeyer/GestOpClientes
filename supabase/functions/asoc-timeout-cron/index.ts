// Edge Function: asoc-timeout-cron
// =============================================================================
// Disparada por pg_cron una vez por hora. Mueve solicitudes de asociacion
// (status=pending_primary) que llevan > 24h sin respuesta del titular a
// status=timeout_to_inbox y le manda el template asociacion_timeout_v1 al
// solicitante.
//
// Seguridad: header x-notify-secret = BOT_NOTIFY_SECRET.
// D007 (2026-09-25): el envío pasa por _shared/wa-guard.ts. Fuente versionada desde acá (antes v39
// sólo en el proyecto). El resto del código es el de v39 sin cambios.

import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFY_SECRET = Deno.env.get("BOT_NOTIFY_SECRET") ?? "";
const WA_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

async function waSendTemplate(
  to: string,
  templateName: string,
  bodyParams: string[],
): Promise<boolean> {
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: "es_AR" },
      components: [
        {
          type: "body",
          parameters: bodyParams.map((p) => ({ type: "text", text: p })),
        },
      ],
    },
  };
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    console.error("WA tpl failed", templateName, res.status, await res.text());
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (req.headers.get("x-notify-secret") !== NOTIFY_SECRET || !NOTIFY_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  // Buscar solicitudes pending_primary con > 24h sin respuesta
  const { data: rows, error } = await supabase
    .from("bot_registration_requests")
    .select("id, telefono, business_name, notified_primary_at")
    .eq("status", "pending_primary")
    .lt("notified_primary_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .limit(50);

  if (error) {
    console.error("query err", error);
    return new Response(JSON.stringify({ ok: false, error: String(error.message) }), { status: 500 });
  }

  const pending = rows ?? [];
  let processed = 0;
  let notified = 0;
  let failed = 0;

  for (const r of pending) {
    // Marcar como timeout_to_inbox.
    const { error: upErr } = await supabase
      .from("bot_registration_requests")
      .update({
        status: "timeout_to_inbox",
        accion_motivo: "timeout 24h sin respuesta del titular",
      })
      .eq("id", r.id)
      .eq("status", "pending_primary"); // guard contra concurrencia
    if (upErr) {
      console.error("update err id", r.id, upErr);
      failed++;
      continue;
    }
    processed++;

    // Avisar al solicitante con template
    if (r.telefono) {
      const ok = await waSendTemplate(
        r.telefono,
        "asociacion_timeout_v1",
        [r.business_name ?? "su cuenta"],
      );
      if (ok) notified++;
    }
  }

  return new Response(
    JSON.stringify({ ok: true, processed, notified, failed }),
    { headers: { "Content-Type": "application/json" } },
  );
});
