// lk_whatsapp-webhook — Webhook principal del bot WhatsApp Loekemeyer
// Edge Function en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
//
// GET  → verificación Meta
// POST → mensaje entrante de WhatsApp | action:flush (outbox)
//
// Usa RPCs bot_* para todo acceso a datos (no queries directos).
// Claude tool-use para conversación inteligente.

import { supabase, getSetting } from "../_shared/supabase.ts";
import {
  sendText,
  sendImage,
  sendDocument,
  sendTemplate,
  markRead,
  extractMessage,
  downloadMediaFromMeta,
} from "./wa-api.ts";
import {
  runConversation,
  saveMessage,
  type MediaAction,
} from "../_shared/bot-conversation.ts";
import { handleFaq } from "../_shared/faq.ts";

// ─── Config (app_settings → fallback Deno.env) ─────────────────────
// Prioridad: app_settings → env var. app_settings es la fuente de verdad —
// se puede rotar el token desde SQL/dashboard sin tocar secrets de Supabase
// ni redeployar. La env var queda como fallback para bootstrapping o si
// alguien limpia app_settings por error.
//
// Ojo: si tenés env var vieja + app_settings actualizado, este orden usa el
// app_settings (correcto). El orden inverso te dejaría con el token viejo
// funcionando y el nuevo ignorado.

interface Config {
  waPhoneId: string;
  waToken: string;
  waVerifyToken: string;
  anthropicKey: string;
}

async function loadConfig(): Promise<Config> {
  const waPhoneId = (await getSetting("LK_WA_PHONE_ID")) ?? Deno.env.get("LK_WA_PHONE_ID") ?? "";
  const waToken = (await getSetting("LK_WA_TOKEN")) ?? Deno.env.get("LK_WA_TOKEN") ?? "";
  const waVerifyToken = (await getSetting("LK_WA_VERIFY_TOKEN")) ?? Deno.env.get("LK_WA_VERIFY_TOKEN") ?? "";
  const anthropicKey = (await getSetting("ANTHROPIC_API_KEY")) ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";

  if (!waPhoneId || !waToken || !waVerifyToken || !anthropicKey) {
    const missing = [
      !waPhoneId && "LK_WA_PHONE_ID",
      !waToken && "LK_WA_TOKEN",
      !waVerifyToken && "LK_WA_VERIFY_TOKEN",
      !anthropicKey && "ANTHROPIC_API_KEY",
    ].filter(Boolean);
    throw new Error("Faltan credenciales (ni app_settings ni env var): " + missing.join(", "));
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

/**
 * Extrae un CUIT válido del texto, independiente del formato que use el
 * cliente ("20-12345678-9", "20/12345678/9", "cuit20123456789", "cuit: 20
 * 12345678 9", etc.). Se limpian TODOS los no-dígitos y se recorren ventanas
 * de 11 dígitos exigiendo dígito verificador (módulo 11) correcto — evita
 * falsos positivos con teléfonos de 10-11 dígitos o CUITs mal tipeados.
 */
function validaCuit(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false;
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cuit[i]) * mult[i];
  const mod = 11 - (sum % 11);
  const dv = mod === 11 ? 0 : mod === 10 ? 9 : mod;
  return dv === Number(cuit[10]);
}

function extractCuit(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  if (digits.length < 11) return null;
  // Ventana móvil de 11 dígitos: el primer candidato que pase módulo 11 gana.
  for (let i = 0; i + 11 <= digits.length; i++) {
    const cand = digits.slice(i, i + 11);
    if (validaCuit(cand)) return cand;
  }
  return null;
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

// ─── Saludo por plantilla (primer contacto tras N horas de silencio) ─
// Consulta `bot_historial_chat` para decidir si es el primer mensaje del
// cliente en la ventana. Si sí, se antepone un saludo fijo con el nombre.
async function esPrimerContacto(phone: string, umbralHoras: number): Promise<boolean> {
  const since = new Date(Date.now() - umbralHoras * 3600_000).toISOString();
  const { count } = await supabase
    .from("bot_historial_chat")
    .select("id", { count: "exact", head: true })
    .eq("telefono", phone)
    .eq("rol", "user")
    .gte("creado_en", since);
  // 0 → nadie escribió en la ventana; 1 → solo el mensaje que acabamos de
  // guardar. Los dos casos son "primer contacto".
  return (count ?? 0) <= 1;
}

/** Wrapping opcional del reply con saludo cuando hay primer contacto. */
async function conSaludoSiCorresponde(
  reply: string,
  phone: string,
  businessName: string,
): Promise<string> {
  const raw = await getSetting("wa_saludo_umbral_horas");
  const umbral = Number(raw) || 6;
  if (umbral <= 0) return reply; // saludo desactivado
  const primero = await esPrimerContacto(phone, umbral);
  if (!primero) return reply;
  return `¡Hola ${businessName}! 👋\n\n${reply}`;
}

// ─── Adjuntos ────────────────────────────────────────────────────────
// Dos modos según el feature flag `app_settings.wa_comprobantes_activo`:
//
//   0 (default, apagado) → placeholder: "no enviar adjuntos por ahora".
//   1 (encendido)        → flujo de comprobantes:
//                          1. Baja el archivo de Meta (2-step API)
//                          2. Sube al bucket `wa-comprobantes`
//                          3. Inserta fila en `wa_comprobantes` (status pending)
//                          4. Dispara `lk_parse-comprobante` en background
//                          5. Responde placeholder "muchas gracias, un vendedor
//                             lo revisa" (matching auto y respuesta según
//                             extracto llegan en el próximo iterado)
//                          6. Encola alerta humana con el id del comprobante
//
// Respeta kill switch y whitelist en ambos modos.

const MSG_ADJUNTO_APAGADO =
  "Por favor, no enviar ningún archivo adjunto a este número de momento. 🙏\n\n" +
  "Si necesitás hacer una consulta o pasarnos información, escribinos por texto y te ayudamos.";

const MSG_ADJUNTO_GRACIAS =
  "¡Muchas gracias! 🙌\n\nRecibimos tu adjunto. Un vendedor lo va a revisar y te confirmamos a la brevedad.";

// Sólo estos MIME pasan al pipeline de comprobantes. El resto (audio, video,
// sticker) siempre responde "no enviar adjuntos" incluso con flag encendida.
const COMPROBANTE_MIMES = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf",
]);

interface AdjuntoMsg {
  from: string;
  msgId: string;
  type: string;
  name?: string;
  mediaId?: string;
  mediaMime?: string;
  mediaFilename?: string;
  caption?: string;
}

async function handleAdjunto(msg: AdjuntoMsg, cfg: Config): Promise<void> {
  const phone = msg.from;

  // Kill switch / whitelist (mismo gate que handleMessage)
  const raw = await getSetting("wa_bot_solo_whitelist");
  const soloWhitelist = Number(raw ?? "1") === 1;
  if (soloWhitelist && !(await estaEnWhitelist(phone))) {
    console.warn(`[whitelist-gate] adjunto de ${phone} descartado.`);
    try {
      await supabase.from("wa_alertas_humano").insert({
        tipo: "otro",
        phone,
        contexto: {
          motivo: "whitelist_gate",
          origen: "adjunto",
          tipo_adjunto: msg.type,
          contact_name: msg.name ?? null,
        },
      });
    } catch { /* fire-and-forget */ }
    return;
  }

  // Feature flag: 0 = placeholder / 1 = flujo de comprobantes
  const flagRaw = await getSetting("wa_comprobantes_activo");
  const activo = Number(flagRaw ?? "0") === 1;

  // Marcar leído (fire-and-forget)
  markRead(cfg.waPhoneId, cfg.waToken, msg.msgId).catch(() => {});

  // Loggear entrada en historial (aparece en Conversaciones)
  const historialLabel = msg.caption
    ? `[ADJUNTO ${msg.type.toUpperCase()}] ${msg.caption}`
    : `[ADJUNTO ${msg.type.toUpperCase()}]`;
  try {
    await supabase.rpc("bot_guardar_mensaje", {
      p_telefono: phone, p_rol: "user", p_contenido: historialLabel,
    });
  } catch (e) { console.error("adjunto: log inbound falló", e); }

  if (!activo) {
    // ── Modo APAGADO: placeholder + alerta ───────────────────────────
    try {
      await sendText(cfg.waPhoneId, cfg.waToken, phone, MSG_ADJUNTO_APAGADO);
      await supabase.rpc("bot_guardar_mensaje", {
        p_telefono: phone, p_rol: "assistant", p_contenido: MSG_ADJUNTO_APAGADO,
      });
    } catch (e) { console.error("adjunto: reply apagado falló", e); }
    try {
      await supabase.from("wa_alertas_humano").insert({
        tipo: "adjunto_no_soportado",
        phone,
        contexto: {
          tipo_adjunto: msg.type,
          wamid: msg.msgId,
          contact_name: msg.name ?? null,
          caption: msg.caption ?? null,
        },
      });
    } catch { /* fire-and-forget */ }
    return;
  }

  // ── Modo ENCENDIDO: flujo de comprobantes ─────────────────────────
  // Tipos no soportados por el pipeline (audio/video/sticker) → placeholder apagado
  const mime = msg.mediaMime ?? "";
  if (msg.type === "audio" || msg.type === "video" || msg.type === "sticker" ||
      (msg.type === "document" && !COMPROBANTE_MIMES.has(mime))) {
    try {
      await sendText(cfg.waPhoneId, cfg.waToken, phone, MSG_ADJUNTO_APAGADO);
      await supabase.rpc("bot_guardar_mensaje", {
        p_telefono: phone, p_rol: "assistant", p_contenido: MSG_ADJUNTO_APAGADO,
      });
    } catch (e) { console.error("adjunto: reply no soportado falló", e); }
    return;
  }

  if (!msg.mediaId) {
    console.error("[adjunto] flujo activo pero payload sin mediaId", msg);
    try {
      await supabase.from("wa_alertas_humano").insert({
        tipo: "comprobante_error",
        phone,
        contexto: { motivo: "sin_media_id", wamid: msg.msgId, tipo_adjunto: msg.type },
      });
    } catch { /* fire-and-forget */ }
    return;
  }

  // Identificar cliente (opcional; el matcheo posterior lo puede resolver también)
  const customer = await getCustomerContext(phone);
  const codCliente = customer?.cod_cliente ? String(customer.cod_cliente) : null;

  // 1. Bajar de Meta
  let download;
  try {
    download = await downloadMediaFromMeta(msg.mediaId, cfg.waToken);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[adjunto] download Meta falló:", errMsg);
    try {
      await supabase.from("wa_alertas_humano").insert({
        tipo: "comprobante_error",
        phone,
        contexto: { motivo: "download_meta", error: errMsg, wamid: msg.msgId },
      });
    } catch { /* fire-and-forget */ }
    return;
  }

  // 2. Subir al bucket. Path: {cod|phone}/{YYYY-MM}/{wamid}.{ext}
  const ext = extFromMime(download.mime) || extFromFilename(msg.mediaFilename) || "bin";
  const yyyyMm = new Date().toISOString().slice(0, 7);
  const carpeta = codCliente ?? phone;
  const storagePath = `${carpeta}/${yyyyMm}/${msg.msgId}.${ext}`;

  const upload = await supabase.storage.from("wa-comprobantes").upload(
    storagePath, download.bytes,
    { contentType: download.mime, upsert: true },
  );
  if (upload.error) {
    console.error("[adjunto] upload bucket falló:", upload.error.message);
    try {
      await supabase.from("wa_alertas_humano").insert({
        tipo: "comprobante_error",
        phone,
        contexto: { motivo: "upload_bucket", error: upload.error.message, wamid: msg.msgId },
      });
    } catch { /* fire-and-forget */ }
    return;
  }

  // 3. Insertar fila en wa_comprobantes
  const { data: inserted, error: insErr } = await supabase.from("wa_comprobantes").insert({
    wamid: msg.msgId,
    phone,
    cod_cliente: codCliente,
    caption: msg.caption ?? null,
    storage_path: storagePath,
    mime_type: download.mime,
    size_bytes: download.fileSize,
    status: "pending",
  }).select("id").maybeSingle();

  if (insErr) {
    console.error("[adjunto] insert wa_comprobantes falló:", insErr.message);
    // Igual seguimos con placeholder y alerta.
  }
  const comprobanteId = inserted?.id ?? null;

  // 4. Disparar parser en background (no bloqueamos la respuesta al cliente)
  if (comprobanteId) {
    triggerParser(comprobanteId).catch((e) =>
      console.error("[adjunto] trigger parser falló:", e instanceof Error ? e.message : e),
    );
  }

  // 5. Placeholder "muchas gracias"
  try {
    await sendText(cfg.waPhoneId, cfg.waToken, phone, MSG_ADJUNTO_GRACIAS);
    await supabase.rpc("bot_guardar_mensaje", {
      p_telefono: phone, p_rol: "assistant", p_contenido: MSG_ADJUNTO_GRACIAS,
    });
  } catch (e) { console.error("adjunto: reply gracias falló", e); }

  // 6. Alerta humana con el id del comprobante (el badge del menú lo cuenta)
  try {
    await supabase.from("wa_alertas_humano").insert({
      tipo: "comprobante_recibido",
      phone,
      customer_id: customer?.customer_id ?? null,
      contexto: {
        comprobante_id: comprobanteId,
        wamid: msg.msgId,
        tipo_adjunto: msg.type,
        mime: download.mime,
        caption: msg.caption ?? null,
        contact_name: msg.name ?? null,
      },
    });
  } catch { /* fire-and-forget */ }
}

function extFromMime(mime: string): string | null {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("pdf")) return "pdf";
  return null;
}
function extFromFilename(name?: string): string | null {
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

/**
 * Dispara `lk_parse-comprobante` con action=parse. Fire-and-forget: no espera
 * la respuesta, así el webhook contesta a Meta rápido. El resultado queda en
 * la fila `wa_comprobantes` que ya fue insertada.
 */
async function triggerParser(comprobanteId: string): Promise<void> {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/lk_parse-comprobante`;
  const anonKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ action: "parse", comprobante_id: comprobanteId }),
  });
  if (!res.ok) {
    console.error(`[triggerParser] ${res.status}:`, (await res.text()).slice(0, 300));
  }
}

// ─── Kill switch por whitelist ─────────────────────────────────────
// Mientras la app está en modo "testing/rollout controlado", el bot solo
// responde a números en `wa_envio_contactos`. Cuando se decida activar
// para todos los clientes, poner `app_settings.wa_bot_solo_whitelist = 0`.
async function estaEnWhitelist(phone: string): Promise<boolean> {
  const { data } = await supabase
    .from("wa_envio_contactos")
    .select("phone")
    .eq("phone", phone)
    .maybeSingle();
  return !!data;
}

// ─── Handler principal ──────────────────────────────────────────────

async function handleMessage(
  phone: string,
  text: string,
  msgId: string,
  contactName: string | undefined,
  cfg: Config,
): Promise<void> {
  // 0. Kill switch: si el toggle está prendido, solo procesamos números
  //    de la whitelist (wa_envio_contactos). Cualquier otro se descarta
  //    silenciosamente — no marcamos leído para no confundir a Meta, no
  //    respondemos, no guardamos historial. Log en wa_alertas_humano
  //    para saber qué números intentaron.
  const raw = await getSetting("wa_bot_solo_whitelist");
  const soloWhitelist = Number(raw ?? "1") === 1;
  if (soloWhitelist && !(await estaEnWhitelist(phone))) {
    console.warn(`[whitelist-gate] mensaje de ${phone} descartado (no está en wa_envio_contactos).`);
    try {
      await supabase.from("wa_alertas_humano").insert({
        tipo: "otro",
        phone,
        contexto: { motivo: "whitelist_gate", texto_recibido: text.slice(0, 200), contact_name: contactName ?? null },
      });
    } catch { /* fire-and-forget */ }
    return;
  }

  // 1. Marcar como leído (fire-and-forget)
  markRead(cfg.waPhoneId, cfg.waToken, msgId).catch(() => {});

  // 2. Modo humano → no procesamos, solo guardamos para trazabilidad
  const modo = await getConversationMode(phone);
  if (modo === "humano") {
    await saveMessage(phone, "user", text);
    return;
  }

  // 3. Identificar cliente por teléfono
  const customer = await getCustomerContext(phone);

  // 4. FAQ pre-check (0 tokens). Bifurca cliente vs no-cliente. Corta
  //    acá si hay match "sólido" (AUTO / SEMIAUTO / HUMANO preestablecida).
  //    La conversación con el agente es el último recurso.
  const faqCustomer = customer ? {
    id: customer.customer_id,
    cod_cliente: customer.cod_cliente,
    business_name: customer.business_name,
    dto_vol: customer.dto_vol,
  } : null;
  const faq = await handleFaq(text, faqCustomer);
  if (faq) {
    await saveMessage(phone, "user", text);
    const reply = customer
      ? await conSaludoSiCorresponde(faq.reply, phone, customer.business_name)
      : faq.reply;
    await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);
    await saveMessage(phone, "assistant", reply);
    return;
  }

  // 5. Sin cliente y sin FAQ → flujo de identificación (CUIT)
  if (!customer) {
    await handleRegistration(phone, text, contactName, cfg);
    return;
  }

  // 6. Cliente identificado, FAQ no matcheó → agente conversacional
  await saveMessage(phone, "user", text);

  const result = await runConversation(
    text,
    phone,
    customer.business_name,
    customer.cod_cliente,
    customer.dto_vol,
    cfg.anthropicKey,
  );

  // 6b. Si el LLM se cayó (timeout / error irrecuperable), NO enviamos
  // nada al cliente. `runConversation` ya avisó a un humano vía
  // `wa_alertas_humano`; el vendedor toma la conversación desde ahí.
  if (result.timeout || result.llmError) {
    console.warn(`[webhook] LLM ${result.timeout ? "timeout" : "error"} — no se envía respuesta al cliente ${phone}. Alerta encolada.`);
    return;
  }

  // 7. Enviar media (fotos, catálogo) antes del texto
  if (result.media.length) {
    await sendMediaActions(result.media, phone, cfg);
  }

  // 8. Enviar respuesta de texto (con saludo si es primer contacto)
  const reply = await conSaludoSiCorresponde(result.reply, phone, customer.business_name);
  await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);

  // 9. Guardar respuesta en historial
  await saveMessage(phone, "assistant", reply);
}

// ─── Edge Function entry point ──────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ── GET: Verificación Meta ──
  // Meta manda hub.mode + hub.verify_token + hub.challenge. Solo necesitamos
  // el verify_token; no hace falta que estén las otras env vars (útil cuando
  // se está dando de alta un número nuevo antes de setear LK_WA_TOKEN etc.).
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && challenge) {
      const expected = Deno.env.get("LK_WA_VERIFY_TOKEN") ?? "";
      if (expected && token === expected) {
        return new Response(challenge, { status: 200 });
      }
      console.warn(`[verify] token mismatch. Got: ${token?.slice(0, 8)}…  Env set: ${!!expected}`);
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
        const cfg = await loadConfig();
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

      const cfg = await loadConfig();

      // Adjuntos (imagen, documento, audio, video, sticker): por ahora
      // NO los descargamos ni parseamos — solo respondemos placeholder pidiendo
      // que no se envíen. El flujo de comprobantes se activa en un paso posterior
      // (ver tabla wa_comprobantes y bucket wa-comprobantes).
      const TIPOS_ADJUNTO = ["image", "document", "audio", "video", "sticker"];
      if (TIPOS_ADJUNTO.includes(msg.type)) {
        await handleAdjunto(msg, cfg);
        return new Response("OK", { status: 200 });
      }

      // Solo procesar mensajes de texto por ahora
      if (msg.type !== "text" || !msg.text.trim()) {
        return new Response("OK", { status: 200 });
      }

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
