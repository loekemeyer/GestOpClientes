// Edge Function: inbox-register
// Endpoints simples para que el inbox-web liste y decida solicitudes de
// registro pendientes.
//
// Auth: header Authorization: Bearer <INBOX_PASSWORD> — el mismo login que
// usa el resto del inbox. Asi el agente no tiene que ingresar otro secret.
//
// Endpoints:
//   POST {action:"list"}          → devuelve pendientes
//   POST {action:"decide", request_id, decision: "approve"|"reject", agente, motivo?}
//                                 → ejecuta la decision y notifica al cliente.
// D007 (2026-09-25): el envío pasa por _shared/wa-guard.ts. Fuente versionada desde acá (antes v43
// sólo en el proyecto). El resto del código es el de v43 sin cambios.

import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INBOX_PASSWORD = Deno.env.get("INBOX_PASSWORD") ?? "";
const WA_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isAuthed(req: Request): boolean {
  if (!INBOX_PASSWORD) return false;
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1].trim() === INBOX_PASSWORD;
}

async function waSendText(to: string, body: string): Promise<boolean> {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    },
  );
  if (!res.ok) {
    console.error("WA send failed", res.status, await res.text());
    return false;
  }
  return true;
}

async function rpcGuardarMensaje(telefono: string, contenido: string) {
  await supabase.rpc("bot_guardar_mensaje", {
    p_telefono: telefono,
    p_rol: "assistant",
    p_contenido: contenido,
  });
}

// Reinyecta un mensaje al webhook para que el bot RETOME la conversacion donde
// quedo (mismo pipeline que un mensaje real: whitelist + historial + tools).
// Lo usamos al aprobar una solicitud, en vez de mostrar un menu.
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/whatsapp-webhook`;
async function resumeConversation(telefono: string, texto: string): Promise<void> {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-resume": SERVICE_ROLE,
      },
      body: JSON.stringify({ resume_from: telefono, resume_text: texto }),
    });
    if (!res.ok) {
      console.error("resume webhook failed", res.status, await res.text());
    }
  } catch (e) {
    console.error("resume webhook error", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders });
  }
  if (!isAuthed(req)) {
    return new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: {
    action?: string;
    request_id?: number;
    decision?: "approve" | "reject";
    agente?: string;
    motivo?: string;
  };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad json" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const action = body?.action;

  if (action === "list") {
    const { data, error } = await supabase.rpc("bot_register_pending");
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: String(error.message ?? error) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, pending: data ?? [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (action === "decide") {
    const requestId = Number(body.request_id);
    const decision = body.decision;
    const agente = String(body.agente ?? "").trim() || "admin";
    const motivo = String(body.motivo ?? "").trim();
    if (!requestId || (decision !== "approve" && decision !== "reject")) {
      return new Response(JSON.stringify({ ok: false, error: "params invalidos" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data, error } = await supabase.rpc("bot_register_decide", {
      p_request_id: requestId,
      p_decision: decision,
      p_agente: agente,
      p_motivo: motivo || null,
    });
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: String(error.message ?? error) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const row = (Array.isArray(data) && data[0]) ? data[0] : null;
    if (!row || !row.ok) {
      return new Response(JSON.stringify({ ok: false, status: row?.status ?? "error" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Notificar al cliente por WhatsApp.
    const telefono = String(row.telefono ?? "");
    const businessName = String(row.business_name ?? "");
    const tipo = String(row.tipo ?? "registro");
    let msg = "";
    if (decision === "approve") {
      if (tipo === "pedidos_access") {
        msg = [
          `✅ *Acceso aprobado*`,
          `Administración comprobó y registró su número.`,
        ].join("\n");
      } else {
        msg = [
          `✅ *Cuenta asociada*`,
          ``,
          `Hola ${businessName}, ya asociamos su WhatsApp a su cuenta de Loekemeyer Hnos.`,
          ``,
          `Puede consultar sus pedidos, descuentos y fechas de entrega.`,
          `¿En qué lo podemos ayudar?`,
        ].join("\n");
      }
    } else {
      if (tipo === "pedidos_access") {
        msg = [
          `Su solicitud de acceso a Ver Pedidos fue rechazada${motivo ? ` (motivo: ${motivo})` : ""}.`,
          ``,
          `Si cree que es un error, contáctenos.`,
        ].join("\n");
      } else {
        msg = [
          `Su solicitud de registro fue rechazada por nuestro equipo${motivo ? ` (motivo: ${motivo})` : ""}.`,
          ``,
          `Si cree que es un error, comuníquese con ventas@loekemeyer.com o WhatsApp 11 3118 1021.`,
        ].join("\n");
      }
    }
    if (telefono) {
      const sent = await waSendText(telefono, msg);
      if (sent) await rpcGuardarMensaje(telefono, msg);

      // Si aprobado → RETOMAR la conversación donde quedó (NO mostrar menú).
      // 'pedidos_access' siempre se origina cuando el cliente pidió ver sus
      // pedidos, así que reinyectamos esa intención al webhook y el bot la
      // resuelve con todo su pipeline (muestra el historial de pedidos).
      if (decision === "approve" && tipo === "pedidos_access") {
        await resumeConversation(telefono, "ver el historial de mis pedidos");
      }
    }

    return new Response(JSON.stringify({ ok: true, status: row.status, telefono, business_name: businessName }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: false, error: "action desconocida" }), {
    status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
