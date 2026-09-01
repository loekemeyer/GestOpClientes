// whatsapp-webhook — STUB (v152, 2026-09-01).
//
// Este webhook LEGACY se stubeó para que dejara de responder mensajes al mismo
// número de WhatsApp que atiende ahora `lk_whatsapp-webhook`. Ver README.md
// en este directorio para el análisis completo, el backup de v151, y las
// instrucciones para restaurar la conectividad si algún día se decide
// reactivar este bot.
//
// Comportamiento del stub:
//  - GET  → responde el `hub.challenge` (mantiene la verificación de Meta viva).
//  - POST con header `x-internal-resume` → 503 + JSON de error visible.
//  - POST (Meta webhook) → 200 OK y descarta el payload.
//  - cualquier otro método → 405.
//
// verify_jwt = false (igual que la v151).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const VERIFY_TOKEN = Deno.env.get("VERIFY_TOKEN") ?? "";

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (req.method === "POST") {
    if (req.headers.get("x-internal-resume")) {
      console.warn("[whatsapp-webhook stub] x-internal-resume rechazado (webhook legacy stubeado)");
      return new Response(
        JSON.stringify({
          error: "webhook legacy stubeado",
          detail:
            "whatsapp-webhook v151 fue reemplazado por stub. Ver GestOpClientes/legacy/whatsapp-webhook-v151/README.md",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    // Meta webhook — responder 200 rápido y descartar. No procesamos nada.
    return new Response("ok", { status: 200 });
  }

  return new Response("method not allowed", { status: 405 });
});
