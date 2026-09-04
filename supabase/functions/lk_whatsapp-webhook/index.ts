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

// ─── Alta de cliente nuevo (no-cliente sin CUIT en sistema) ────────
// Toma de datos paso a paso, 0 tokens (determinístico, sin IA). Se dispara
// cuando un no-cliente acepta registrarse (o su CUIT no está en el sistema).
// El estado vive en `wa_prospect_leads` (status='pending' + alta_step). Al
// terminar: se deja el "cable" para el vendedor (fila en wa_alertas_humano,
// SIN enchufar a ninguna notificación push todavía) y se le avisa al cliente
// que la solicitud va a revisión.

const ALTA_INTRO =
  `¡Genial! Te tomo los datos para registrarte. 📋\n\n` +
  `Te voy a ir preguntando de a uno. Si querés cortar, escribí *cancelar*.\n\n` +
  `¿Cuál es tu *razón social*?`;

// Orden de campos. Si en el disparo ya teníamos el CUIT (cuit_not_found), no se
// vuelve a pedir; si el alta arranca sin CUIT, se pide primero.
const ALTA_STEPS: { field: string; prompt: string }[] = [
  { field: "razon_social",      prompt: "📋 ¿Cuál es tu *razón social*?" },
  { field: "nombre_contacto",   prompt: "👤 ¿*Nombre de contacto*? (nombre y apellido)" },
  { field: "telefono",          prompt: "📱 ¿*Teléfono* de contacto? (con característica, ej: 11 2345-6789)" },
  { field: "mail",              prompt: "📧 ¿*Mail*? (ej: nombre@dominio.com)" },
  { field: "direccion",         prompt: "📍 ¿*Dirección*? (calle y número)" },
  { field: "localidad",         prompt: "📍 ¿*Localidad*?" },
  { field: "expreso_nombre",    prompt: "🚚 ¿Con qué *expreso / transporte* trabajan? (nombre)" },
  { field: "expreso_direccion", prompt: "🚚 ¿*Dirección del expreso*?" },
  { field: "expreso_telefono",  prompt: "🚚 ¿*Teléfono del expreso*? (con característica)" },
  { field: "tipo_comercio",     prompt: "🏪 ¿*Tipo de comercio*? (ej: bazar, mayorista, distribuidor)" },
  { field: "dimension_comercio", prompt: "🏪 ¿*Dimensión del local*? (ej: 4x8 = 32 m²)" },
  { field: "tiene_venta_web",   prompt: "🌐 ¿Tenés *venta web / página*? Si sí, pasame el link; si no, poné *no*." },
  { field: "ya_vende_lk",       prompt: "📦 ¿Ya vendés *mercadería Loekemeyer*? (sí / no)" },
];

const STEP_A_QUIEN = "📦 ¿A quién le comprás Loekemeyer actualmente?";
const STEP_COMO_CONOCE = "📢 ¿De dónde nos conocés? (ej: recomendación, redes, feria)";

const MSG_ALTA_COMPLETA =
  `✅ ¡Listo! Ya tengo todos tus datos.\n\n` +
  `La solicitud irá a revisión y nos pondremos en contacto con vos cuando sea aprobada. ¡Gracias! 🙌`;

const MSG_ALTA_CANCELADA =
  `Listo, cancelé el registro. Si querés retomarlo más adelante, escribime *registrarme*. 👋`;

// Dispara el alta (aceptar el registro / "soy nuevo").
const RE_ALTA_START =
  /\b(soy nuevo|nuevo cliente|quiero ser cliente|darme de alta|registrar(me|te)?|registro|dar de alta|alta|si\s*,?\s*(dale|quiero|registrame)|dale|quiero registrarme|primera vez)\b/i;
// Cortar el alta en curso.
const RE_ALTA_CANCEL = /\b(cancelar|cancelá|salir|dejar|olvidalo|no quiero|parar|basta)\b/i;

/** Valida el dato del campo actual. Devuelve mensaje de error o null si OK. */
function validarAltaCampo(field: string, text: string): string | null {
  const t = text.trim();
  if (!t) return "Se me quedó vacío 🤔 ¿Me lo repetís?";
  if (field === "mail") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
      return "Ese mail no parece válido 🤔 Debería ser algo tipo *nombre@dominio.com*. ¿Me lo pasás de nuevo?";
    }
  }
  if (field === "telefono" || field === "expreso_telefono") {
    if (t.replace(/\D/g, "").length < 8) {
      return "Ese teléfono parece corto 🤔 Pasámelo con característica (ej: *11 2345-6789*).";
    }
  }
  return null;
}

async function getPendingLead(phone: string) {
  const { data } = await supabase
    .from("wa_prospect_leads")
    .select("id, cuit, razon_social, nombre_contacto, telefono, mail, direccion, localidad, expreso_nombre, expreso_direccion, expreso_telefono, tipo_comercio, dimension_comercio, tiene_venta_web, ya_vende_lk, a_quien_compra, como_conoce_marca, alta_step, raw_messages")
    .eq("phone", phone)
    .eq("status", "pending")
    .maybeSingle();
  return data;
}

/** Avisa al vendedor de un alta completa. CABLE SIN ENCHUFAR: solo deja la
 *  fila en wa_alertas_humano; todavía no hay push/notificación conectada. */
async function notificarAltaVendedor(phone: string, lead: Record<string, unknown>): Promise<void> {
  try {
    await supabase.from("wa_alertas_humano").insert({
      tipo: "alta_cliente_nuevo",
      phone,
      contexto: {
        lead_id: lead.id ?? null,
        cuit: lead.cuit ?? null,
        razon_social: lead.razon_social ?? null,
        nombre_contacto: lead.nombre_contacto ?? null,
        localidad: lead.localidad ?? null,
        motivo: "solicitud_alta_completa",
      },
    });
  } catch (e) {
    console.error("notificarAltaVendedor falló:", e);
  }
}

/** Enruta la respuesta del cliente al campo del alta que corresponda. */
async function handleAltaStep(
  phone: string,
  text: string,
  // deno-lint-ignore no-explicit-any
  lead: any,
  send: (reply: string) => Promise<void>,
): Promise<void> {
  if (RE_ALTA_CANCEL.test(text)) {
    await supabase.from("wa_prospect_leads")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", lead.id);
    await send(MSG_ALTA_CANCELADA);
    return;
  }

  const step: number = lead.alta_step ?? 0;
  const messages = Array.isArray(lead.raw_messages) ? [...lead.raw_messages] : [];
  messages.push({ role: "user", content: text, ts: new Date().toISOString() });

  // ── Pasos base ────────────────────────────────────────────────────
  if (step < ALTA_STEPS.length) {
    const currentField = ALTA_STEPS[step].field;

    const err = validarAltaCampo(currentField, text);
    if (err) {
      // Dato mal formado → re-preguntar el MISMO campo, no avanzar.
      await send(err);
      return;
    }

    let value: unknown = text.trim();
    if (currentField === "ya_vende_lk") {
      value = /^(si|sí|s|yes|y|1|true|dale)\b/i.test(text.trim());
    }

    const nextStep = step + 1;
    await supabase.from("wa_prospect_leads")
      .update({
        [currentField]: value,
        alta_step: nextStep,
        raw_messages: messages,
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead.id);

    if (nextStep >= ALTA_STEPS.length) {
      const yaVende = currentField === "ya_vende_lk" ? value : lead.ya_vende_lk;
      await send(yaVende === true ? STEP_A_QUIEN : STEP_COMO_CONOCE);
      return;
    }
    await send(ALTA_STEPS[nextStep].prompt);
    return;
  }

  // ── Paso extra según ya_vende_lk ─────────────────────────────────────
  const needsExtra = lead.ya_vende_lk === true ? "a_quien_compra" : "como_conoce_marca";
  if (!lead[needsExtra]) {
    await supabase.from("wa_prospect_leads")
      .update({
        [needsExtra]: text.trim(),
        status: "complete",
        raw_messages: messages,
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead.id);

    await notificarAltaVendedor(phone, { ...lead, [needsExtra]: text.trim() });
    await send(MSG_ALTA_COMPLETA);
    return;
  }

  // Ya estaba completo (mensaje tardío) — no re-notificar.
  await send("Tu solicitud ya está registrada y en revisión ✅ Te avisamos cuando se apruebe.");
}

/** Crea el lead (status='pending', alta_step=0). No envía nada: el caller
 *  decide el copy de arranque. `cuit` opcional (viene de cuit_not_found). */
async function crearLead(phone: string, text: string, cuit: string | null): Promise<void> {
  await supabase.from("wa_prospect_leads").insert({
    phone,
    cuit,
    alta_step: 0,
    status: "pending",
    raw_messages: [{ role: "user", content: text, ts: new Date().toISOString() }],
  });
}

/** Maneja el flujo de registro para teléfonos no identificados */
async function handleRegistration(
  phone: string,
  text: string,
  contactName: string | undefined,
  cfg: Config,
): Promise<void> {
  // Guardamos el mensaje entrante y cada respuesta en el historial, para que
  // el flujo de identificación (CUIT) sea visible en Conversaciones y se pueda
  // debuggear qué mandó el cliente y qué contestó el bot.
  await saveMessage(phone, "user", text);
  const send = async (reply: string): Promise<void> => {
    await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);
    await saveMessage(phone, "assistant", reply);
  };

  const cuit = extractCuit(text);

  if (!cuit) {
    // Si el cliente tipeó ~11 dígitos pero no pasan la validación (módulo 11),
    // es un CUIT mal copiado: avisamos en vez de repetir el saludo genérico.
    // Un CUIT válido en cualquier mensaje siguiente lo toma extractCuit y avanza
    // (el flujo es stateless: cada mensaje de no-cliente reintenta el registro).
    const digitos = text.replace(/\D/g, "").length;
    if (digitos >= 11) {
      await send(
        `Ese CUIT no parece válido 🤔\n\n` +
        `Verificá que tenga *11 dígitos* y esté bien copiado (con o sin guiones), y probá de nuevo.\n\n` +
        `Si no lo tenés a mano, escribinos a ventas@loekemeyer.com`,
      );
      return;
    }
    // Aceptó registrarse (o dijo "soy nuevo") sin pasar CUIT → arrancar alta.
    if (RE_ALTA_START.test(text)) {
      await crearLead(phone, text, null);
      await send(ALTA_INTRO);
      return;
    }
    await send(
      `Todavía no te tengo registrado como cliente. ` +
      `¿Me pasás tu *CUIT* así te registro y podés ver precios y hacer pedidos? (con o sin guiones)\n\n` +
      `Si todavía no sos cliente, decime *registrarme* y te tomo los datos.`,
    );
    return;
  }

  const result = await tryRegister(phone, cuit);

  if (!result) {
    await send(
      "Hubo un error al procesar tu solicitud. Intentá de nuevo o contactá a ventas: ventas@loekemeyer.com",
    );
    return;
  }

  switch (result.status) {
    case "already_registered": {
      await send(
        `¡Hola ${result.business_name}! 👋\n\n` +
        `Ya estás registrado. ¿En qué te puedo ayudar?\n\n` +
        `📦 Estado de pedidos\n` +
        `🔍 Buscar productos\n` +
        `🚚 Consultar entregas\n` +
        `💬 Cualquier consulta`,
      );
      break;
    }

    case "auto_associated": {
      await send(
        `¡Hola ${result.business_name}! 👋\n\n` +
        `Ya quedaste vinculado a este número.\n` +
        `Podés consultarme por:\n\n` +
        `📦 Estado de tus pedidos\n` +
        `🔍 Buscar productos\n` +
        `🚚 Consultar entregas\n` +
        `💬 Cualquier otra consulta`,
      );
      break;
    }

    case "cuit_not_found": {
      // No está en el sistema → arrancar la toma de datos. El CUIT ya validado
      // (módulo 11) queda guardado en el lead. Un solo mensaje: ofrecer + 1er campo.
      await crearLead(phone, text, cuit);
      await send(
        `No te encontré como cliente con ese CUIT. 🤔\n\n` +
        `Si querés te tomo los datos para registrarte —así podés ver precios y hacer pedidos. ` +
        `Te pregunto de a uno (para cortar, escribí *cancelar*):\n\n` +
        `📋 ¿Cuál es tu *razón social*?`,
      );
      break;
    }

    case "pending_primary": {
      await send(
        `Encontré la cuenta de *${result.business_name}*. 👍\n\n` +
        `Como ya hay un teléfono principal registrado, tu solicitud queda pendiente de aprobación.\n\n` +
        `Te vamos a avisar cuando se apruebe. 🙏`,
      );
      break;
    }

    default: {
      await send(
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

// ─── Statuses de Meta (delivery reports) ───────────────────────────
// Idempotente por (wamid, status). Cloud API v20+ manda estos events dentro
// del mismo webhook, en value.statuses[]. Formato:
//   {
//     id: 'wamid.HBg…',
//     status: 'sent' | 'delivered' | 'read' | 'failed',
//     timestamp: '1700000000',
//     recipient_id: '5491125608669',
//     conversation: { id, expiration_timestamp, origin: {type} },
//     pricing: { billable, pricing_model, category, type },
//     errors: [{ code, title, message, error_data:{details} }]  // solo en failed
//   }
// deno-lint-ignore no-explicit-any
async function ingestStatuses(body: any): Promise<void> {
  const changes = body?.entry?.[0]?.changes ?? [];
  for (const change of changes) {
    if (change?.field !== "messages") continue;
    const statuses = change?.value?.statuses ?? [];
    for (const s of statuses) {
      if (!s?.id || !s?.status) continue;
      const tsSec = Number(s.timestamp);
      const ts = Number.isFinite(tsSec) ? new Date(tsSec * 1000).toISOString() : new Date().toISOString();
      const convExpSec = Number(s?.conversation?.expiration_timestamp);
      const convExp = Number.isFinite(convExpSec) ? new Date(convExpSec * 1000).toISOString() : null;
      try {
        await supabase.from("wa_message_status").upsert({
          wamid: s.id,
          recipient_id: s.recipient_id ?? null,
          status: s.status,
          ts,
          conversation_id: s?.conversation?.id ?? null,
          conv_expiration: convExp,
          origin_type: s?.conversation?.origin?.type ?? null,
          pricing_category: s?.pricing?.category ?? null,
          pricing_type: s?.pricing?.type ?? null,
          errors: s?.errors ?? null,
          raw: s,
        }, { onConflict: "wamid,status", ignoreDuplicates: true });
      } catch (e) {
        console.error("[wa_message_status] insert falló:", e);
      }
    }
  }
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

  // 2. Modo humano → no procesamos, solo guardamos para trazabilidad. El bot
  //    retoma cuando el modo vuelve a "bot" (hoy: vencimiento fijo en
  //    lk_conversaciones, `auto_retomar_bot`).
  //    ── CABLE (sin enchufar) — cierre por inactividad ──────────────────────
  //    TODO: bajar el vencimiento de 8h a ~30-40 min de inactividad. Cuando el
  //    chat lleva ese tiempo sin mensajes, avisar al vendedor ("¿cerramos esta
  //    conversación?") o darle un botón "Cerrar chat" en el Panel; al cerrar,
  //    modo vuelve a "bot" y el bot retoma si el cliente reinicia contacto.
  //    Requiere: cron/edge de barrido (idle sweep) + acción de UI. NO conectado.
  const modo = await getConversationMode(phone);
  if (modo === "humano") {
    await saveMessage(phone, "user", text);
    return;
  }

  // 3. Identificar cliente por teléfono
  const customer = await getCustomerContext(phone);

  // 3b. Alta en curso (no-cliente): si ya arrancó la toma de datos, cada
  //     mensaje es la respuesta al campo que toca. La interceptamos ACÁ, antes
  //     del FAQ, para que un saludo/keyword no le robe la respuesta al alta.
  if (!customer) {
    const lead = await getPendingLead(phone);
    if (lead) {
      await saveMessage(phone, "user", text);
      const send = async (reply: string): Promise<void> => {
        await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);
        await saveMessage(phone, "assistant", reply);
      };
      await handleAltaStep(phone, text, lead, send);
      return;
    }
  }

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

      // ── Statuses de Meta (delivery: sent/delivered/read/failed) ──
      // Cloud API v20+ los rutea junto al campo `messages`, dentro de
      // entry[].changes[].value.statuses[]. Los loggeamos en wa_message_status
      // para poder debuggear entregas silenciosas y saber si un template
      // fue delivered/read/failed post-envío.
      await ingestStatuses(body).catch((e) =>
        console.error("[statuses] falló:", e instanceof Error ? e.message : e),
      );

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
