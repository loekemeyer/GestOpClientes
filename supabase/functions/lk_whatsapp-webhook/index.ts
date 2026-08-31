// lk_whatsapp-webhook — Webhook principal del bot WhatsApp Loekemeyer
// Edge Function en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
//
// GET  → verificación Meta
// POST → mensaje entrante de WhatsApp | action:flush (outbox)
//
// Usa RPCs bot_* para todo acceso a datos (no queries directos).
// Claude tool-use para conversación inteligente.

import { supabase } from "../_shared/supabase.ts";
import {
  sendText,
  sendImage,
  sendDocument,
  sendTemplate,
  markRead,
  extractMessage,
} from "./wa-api.ts";
import {
  runConversation,
  saveMessage,
  type MediaAction,
} from "./claude.ts";

// ─── Config (secrets desde Deno.env) ───────────────────────────────

interface Config {
  waPhoneId: string;
  waToken: string;
  waVerifyToken: string;
  anthropicKey: string;
}

function loadConfig(): Config {
  const waPhoneId = Deno.env.get("LK_WA_PHONE_ID") ?? "";
  const waToken = Deno.env.get("LK_WA_TOKEN") ?? "";
  const waVerifyToken = Deno.env.get("LK_WA_VERIFY_TOKEN") ?? "";
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

  if (!waPhoneId || !waToken || !waVerifyToken || !anthropicKey) {
    const missing = [
      !waPhoneId && "LK_WA_PHONE_ID",
      !waToken && "LK_WA_TOKEN",
      !waVerifyToken && "LK_WA_VERIFY_TOKEN",
      !anthropicKey && "ANTHROPIC_API_KEY",
    ].filter(Boolean);
    throw new Error("Faltan env vars: " + missing.join(", "));
  }

  return { waPhoneId, waToken, waVerifyToken, anthropicKey };
}

// ─── Customer lookup (via RPC bot_cliente_por_whatsapp) ────────────

interface CustomerContext {
  customer_id: string;
  cod_cliente: number;
  business_name: string;
  dto_vol: number;
}

async function getCustomerContext(phone: string): Promise<CustomerContext | null> {
  const { data, error } = await supabase.rpc("bot_cliente_por_whatsapp", {
    p_telefono: phone,
  });

  if (error) {
    console.error("Error en bot_cliente_por_whatsapp:", error.message);
    return null;
  }

  if (!data?.length) return null;

  const row = data[0];
  return {
    customer_id: row.customer_id ?? row.id,
    cod_cliente: row.cod_cliente,
    business_name: row.business_name,
    dto_vol: row.dto_vol ?? 0,
  };
}

// ─── Modo conversación (bot / humano) ──────────────────────────────

async function getConversationMode(phone: string): Promise<string> {
  const { data, error } = await supabase.rpc("bot_conv_get_modo", {
    p_telefono: phone,
  });
  if (error) {
    console.error("Error en bot_conv_get_modo:", error.message);
    return "bot";
  }
  return data ?? "bot";
}

// ─── Registro / vinculación ────────────────────────────────────────

interface RegisterResult {
  request_id: number;
  status: string;
  business_name: string | null;
  cod_cliente: number | null;
  primary_phone: string | null;
}

async function tryRegister(phone: string, cuit: string): Promise<RegisterResult | null> {
  const { data, error } = await supabase.rpc("bot_register_request_v2", {
    p_telefono: phone,
    p_cuit: cuit,
  });

  if (error) {
    console.error("Error en bot_register_request_v2:", error.message);
    return null;
  }

  if (!data?.length) return null;
  return data[0];
}

/** Extrae CUIT del texto (11 dígitos, con o sin guiones) */
function extractCuit(text: string): string | null {
  const cleaned = text.replace(/[\s\-\.]/g, "");
  const match = cleaned.match(/\b(\d{10,11})\b/);
  return match ? match[1] : null;
}

/** Maneja el flujo de registro para teléfonos no identificados */
async function handleRegistration(
  phone: string,
  text: string,
  contactName: string | undefined,
  cfg: Config,
): Promise<void> {
  const cuit = extractCuit(text);

  if (!cuit) {
    const reply =
      `¡Hola${contactName ? " " + contactName : ""}! 👋\n\n` +
      `Soy el asistente de *Loekemeyer*. ` +
      `Para poder ayudarte, necesito identificarte.\n\n` +
      `¿Me pasás tu *CUIT*? (con o sin guiones)`;
    await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);
    return;
  }

  const result = await tryRegister(phone, cuit);

  if (!result) {
    await sendText(
      cfg.waPhoneId, cfg.waToken, phone,
      "Hubo un error al procesar tu solicitud. Intentá de nuevo o contactá a ventas: ventas@loekemeyer.com",
    );
    return;
  }

  switch (result.status) {
    case "already_registered": {
      const reply =
        `¡Hola ${result.business_name}! 👋\n\n` +
        `Ya estás registrado. ¿En qué te puedo ayudar?\n\n` +
        `📦 Estado de pedidos\n` +
        `🔍 Buscar productos\n` +
        `🚚 Consultar entregas\n` +
        `💬 Cualquier consulta`;
      await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);
      break;
    }

    case "auto_associated": {
      const reply =
        `¡Hola ${result.business_name}! 👋\n\n` +
        `Ya quedaste vinculado a este número.\n` +
        `Podés consultarme por:\n\n` +
        `📦 Estado de tus pedidos\n` +
        `🔍 Buscar productos\n` +
        `🚚 Consultar entregas\n` +
        `💬 Cualquier otra consulta`;
      await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);
      break;
    }

    case "cuit_not_found": {
      await sendText(
        cfg.waPhoneId, cfg.waToken, phone,
        `No encontré un cliente con ese CUIT. 🤔\n\n` +
        `Verificá el número e intentá de nuevo, o contactá a ventas:\n` +
        `📧 ventas@loekemeyer.com\n` +
        `📱 1131181021`,
      );
      break;
    }

    case "pending_primary": {
      await sendText(
        cfg.waPhoneId, cfg.waToken, phone,
        `Encontré la cuenta de *${result.business_name}*. 👍\n\n` +
        `Como ya hay un teléfono principal registrado, tu solicitud queda pendiente de aprobación.\n\n` +
        `Te vamos a avisar cuando se apruebe. 🙏`,
      );
      break;
    }

    default: {
      await sendText(
        cfg.waPhoneId, cfg.waToken, phone,
        `Tu solicitud está en estado: ${result.status}. Contactá a ventas si necesitás ayuda.`,
      );
    }
  }
}

// ─── Envío de media (resultado de tools) ───────────────────────────

async function sendMediaActions(
  media: MediaAction[],
  phone: string,
  cfg: Config,
): Promise<void> {
  for (const m of media) {
    try {
      if (m.type === "image") {
        await sendImage(cfg.waPhoneId, cfg.waToken, phone, m.url, m.caption);
      } else if (m.type === "document") {
        await sendDocument(
          cfg.waPhoneId, cfg.waToken, phone,
          m.url, m.filename ?? "archivo.pdf", m.caption,
        );
      }
    } catch (e) {
      console.error("Error enviando media:", e);
    }
  }
}

// ─── Flush outbox (enviar mensajes pendientes) ─────────────────────

async function flushOutbox(cfg: Config): Promise<{ sent: number; failed: number }> {
  const { data: batch, error } = await supabase.rpc("bot_flush_outbox", {
    p_limit: 20,
  });

  if (error || !batch?.length) {
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const msg of batch) {
    try {
      if (msg.template_name) {
        // Enviar template aprobado por Meta
        const params: string[] = [];
        if (msg.template_params) {
          const vals = Object.values(msg.template_params);
          for (const v of vals) params.push(String(v));
        }
        await sendTemplate(
          cfg.waPhoneId, cfg.waToken, msg.phone,
          msg.template_name, "es_AR", params,
        );
      } else if (msg.body) {
        // Enviar texto libre (dentro de ventana 24h)
        await sendText(cfg.waPhoneId, cfg.waToken, msg.phone, msg.body);
      } else {
        await supabase.rpc("bot_outbox_mark", {
          p_id: msg.id, p_status: "failed", p_error: "Sin body ni template",
        });
        failed++;
        continue;
      }

      // Marcar como enviado
      await supabase.rpc("bot_outbox_mark", {
        p_id: msg.id, p_status: "sent",
      });
      sent++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`Outbox ${msg.id} falló:`, errMsg);
      await supabase.rpc("bot_outbox_mark", {
        p_id: msg.id, p_status: "failed", p_error: errMsg.slice(0, 500),
      });
      failed++;
    }
  }

  return { sent, failed };
}

// ─── Handler principal ──────────────────────────────────────────────

async function handleMessage(
  phone: string,
  text: string,
  msgId: string,
  contactName: string | undefined,
  cfg: Config,
): Promise<void> {
  // 1. Marcar como leído (fire-and-forget)
  markRead(cfg.waPhoneId, cfg.waToken, msgId).catch(() => {});

  // 2. Chequear modo (bot / humano)
  const modo = await getConversationMode(phone);
  if (modo === "humano") {
    await saveMessage(phone, "user", text);
    return;
  }

  // 3. Buscar cliente por teléfono
  const customer = await getCustomerContext(phone);

  if (!customer) {
    await handleRegistration(phone, text, contactName, cfg);
    return;
  }

  // 4. Cliente identificado — guardar mensaje entrante
  await saveMessage(phone, "user", text);

  // 5. Ejecutar conversación con Claude (tool-use loop)
  const result = await runConversation(
    text,
    phone,
    customer.business_name,
    customer.cod_cliente,
    customer.dto_vol,
    cfg.anthropicKey,
  );

  // 6. Enviar media (fotos, catálogo) antes del texto
  if (result.media.length) {
    await sendMediaActions(result.media, phone, cfg);
  }

  // 7. Enviar respuesta de texto
  await sendText(cfg.waPhoneId, cfg.waToken, phone, result.reply);

  // 8. Guardar respuesta en historial
  await saveMessage(phone, "assistant", result.reply);
}

// ─── Edge Function entry point ──────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ── GET: Verificación Meta ──
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && challenge) {
      try {
        const cfg = loadConfig();
        if (token === cfg.waVerifyToken) {
          return new Response(challenge, { status: 200 });
        }
      } catch (e) {
        console.error("Error en verificación:", e);
      }
      return new Response("Forbidden", { status: 403 });
    }

    return new Response("OK", { status: 200 });
  }

  // ── POST: Mensaje entrante o acción interna ──
  if (req.method === "POST") {
    try {
      const body = await req.json();

      // ── Acción interna: flush outbox (llamada desde pg_cron) ──
      if (body?.action === "flush") {
        const cfg = loadConfig();
        const result = await flushOutbox(cfg);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // ── Webhook de Meta: mensaje entrante ──
      const msg = extractMessage(body);
      if (!msg) {
        return new Response("OK", { status: 200 });
      }

      // Solo procesar mensajes de texto por ahora
      if (msg.type !== "text" || !msg.text.trim()) {
        return new Response("OK", { status: 200 });
      }

      const cfg = loadConfig();

      // Procesar (Meta tolera hasta 20s de respuesta)
      await handleMessage(msg.from, msg.text, msg.msgId, msg.name, cfg);
    } catch (e) {
      console.error("Error procesando mensaje:", e);
    }

    // Siempre responder 200 a Meta (no perder webhook)
    return new Response("OK", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
});
