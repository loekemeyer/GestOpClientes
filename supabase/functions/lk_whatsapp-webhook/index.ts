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
  WaApiError,
} from "../_shared/wa-api.ts";
import {
  runConversation,
  saveMessage,
  type MediaAction,
} from "../_shared/bot-conversation.ts";
import { handleFaq } from "../_shared/faq.ts";
import { notificarHumano } from "../_shared/alertas.ts";
import { verificarFirmaMeta } from "../_shared/webhook-firma.ts";

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
  // Token de envío de WhatsApp. Prioriza el secret del Vault `WHATSAPP_ACCESS_TOKEN` (el mismo
  // que ya usan lk_factura-check / lk_templates), y deja `LK_WA_TOKEN` (app_settings/env) como
  // respaldo. Objetivo: sacar el token de `app_settings` y tener UNA sola fuente en el Vault
  // (2026-09-10, seguridad). Rotarlo pasa a ser sólo actualizar ese secret.
  const waToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN")
    ?? (await getSetting("LK_WA_TOKEN")) ?? Deno.env.get("LK_WA_TOKEN") ?? "";
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

// ─── Customer lookup ───────────────────────────────────────────────
//
// Dos fuentes, en cascada — el MISMO orden que `lk_chat-test`, para que la
// consola de prueba y producción identifiquen igual (antes divergían y por eso
// en el test andaba y en WhatsApp no):
//
//   1. `wa_identify_customer` → `wa_clientes_telefono`, el padrón que baja del
//      ERP (610 teléfonos). Normaliza las variantes 54 / 9 / 15, así que
//      matchea el `from` de Meta contra el formato con el que está cargado.
//      Cobertura medida el 2026-09-07: resuelve 547 de los 610, 0 ambiguos
//      (los 63 restantes son fijos, no líneas de WhatsApp).
//   2. `bot_cliente_por_whatsapp` → `bot_customer_whatsapps`, la vinculación
//      explícita que se pide por WhatsApp y aprueba un humano. Hoy tiene 0
//      filas: por eso el webhook, que consultaba SOLO ésta, no identificaba a
//      NADIE y todo mensaje caía a la rama de no-cliente.
//
// El orden es a pedido del dueño (2026-09-07): que el bot reconozca ya a los
// teléfonos del ERP. Cuando `bot_customer_whatsapps` se empiece a poblar sigue
// sirviendo, como override de lo que diga el padrón.

interface CustomerContext {
  customer_id: string;
  cod_cliente: number;
  business_name: string;
  dto_vol: number;
}

/** El descuento por volumen no lo devuelve `wa_identify_customer`. */
async function getDtoVol(customerId: string): Promise<number> {
  const { data } = await supabase
    .from("customers").select("dto_vol").eq("id", customerId).maybeSingle();
  return Number(data?.dto_vol ?? 0);
}

async function getCustomerContext(phone: string): Promise<CustomerContext | null> {
  // 1. Padrón del ERP (normaliza variantes de prefijo)
  const { data: ident, error: identErr } = await supabase.rpc("wa_identify_customer", {
    p_phone: phone,
  });
  if (identErr) console.error("Error en wa_identify_customer:", identErr.message);

  const iRow = ident?.[0];
  if (iRow?.customer_id) {
    return {
      customer_id: iRow.customer_id,
      cod_cliente: Number(iRow.cod_cliente),
      business_name: iRow.customer_name,
      dto_vol: await getDtoVol(iRow.customer_id),
    };
  }

  // 2. Vinculación explícita
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
//
// Punto 11 de la auditoría del 07/09: esto matcheaba `alta`, `registro` y —lo peor— `dale`
// sueltos. Al pedido de CUIT alguien contesta "dale, ya te lo paso" y arrancaba el alta;
// el CUIT del mensaje siguiente se guardaba como `razon_social`, y como `ALTA_STEPS` no
// tiene paso de CUIT, ese lead quedaba SIN CUIT para siempre.
//
// Ahora son frases explícitas. `dale`/`sí` solos ya no alcanzan: tienen que venir pegados a
// la intención ("dale, registrame"). Y si el mensaje trae un CUIT, `handleRegistration` ya
// cortó antes de llegar acá.
const RE_ALTA_START =
  /\b(soy nuevo|no soy cliente|nuevo cliente|quiero ser cliente|(darme|dar) de alta|registrame|registrarme|registrarte|quiero registrarme|quiero el registro|primera vez que (compro|les compro|escribo))\b/i;
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

/**
 * v14.13 — punto 11c de la auditoría del 07/09. Antes esto usaba `.maybeSingle()`, que con DOS
 * filas `pending` del mismo teléfono devuelve `null` y un error PGRST116 que nadie miraba. El
 * resultado era el peor posible: el paso que intercepta el alta no se activaba nunca y el bot
 * contestaba "pasame tu CUIT" **en loop para siempre**, sin forma de salir.
 *
 * Ahora se toma el más reciente (`order` + `limit(1)`), así dos filas no rompen nada, y el
 * error se loguea en vez de tragarse. El índice único parcial de `sql/059` impide que se
 * vuelvan a crear dos, pero esto tiene que aguantar las que ya existan.
 */
/**
 * v14.13 — punto 11a: además, un alta abierta **vence**. Sin vencimiento, quien abandonaba
 * en el campo 4 y volvía dos semanas después con un "hola, me pasás la lista?" tenía ese
 * saludo guardado como mail o como dirección: el paso del alta se come cualquier mensaje.
 * El único escape era `RE_ALTA_CANCEL`, que nadie sabe que existe.
 *
 * A las `ALTA_TTL_HORAS` sin tocar, el alta se marca `expired` y el flujo arranca de cero
 * (el índice único parcial de sql/059 es sobre `status='pending'`, así que expirarla libera
 * el teléfono para un alta nueva).
 */
const ALTA_TTL_HORAS = 48;

async function getPendingLead(phone: string) {
  const { data, error } = await supabase
    .from("wa_prospect_leads")
    .select("id, cuit, razon_social, nombre_contacto, telefono, mail, direccion, localidad, expreso_nombre, expreso_direccion, expreso_telefono, tipo_comercio, dimension_comercio, tiene_venta_web, ya_vende_lk, a_quien_compra, como_conoce_marca, alta_step, raw_messages, updated_at")
    .eq("phone", phone)
    .eq("status", "pending")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) console.error(`[alta] getPendingLead(${phone}) falló:`, error.message);
  const lead = (data && data[0]) || null;
  if (!lead) return null;

  const tocado = lead.updated_at ? Date.parse(String(lead.updated_at)) : NaN;
  if (Number.isFinite(tocado) && Date.now() - tocado > ALTA_TTL_HORAS * 3600_000) {
    const { error: e2 } = await supabase
      .from("wa_prospect_leads")
      .update({ status: "expired" })
      .eq("id", lead.id)
      .eq("status", "pending");
    if (e2) {
      // No se pudo expirar: mejor seguir con el alta vieja que perder los datos ya cargados.
      console.error(`[alta] no pude expirar el lead ${lead.id}:`, e2.message);
      return lead;
    }
    console.log(`[alta] lead ${lead.id} de ${phone} vencido (>${ALTA_TTL_HORAS} h sin actividad).`);
    return null;
  }
  return lead;
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
/**
 * v14.13 — idempotente. Antes insertaba sin mirar si el teléfono ya tenía un alta abierta, que
 * es exactamente cómo se llegaba a las dos filas `pending` que dejaban el alta en loop.
 */
async function crearLead(phone: string, text: string, cuit: string | null): Promise<void> {
  const abierto = await getPendingLead(phone);
  if (abierto) {
    console.log(`[alta] ${phone} ya tenía un alta abierta (lead ${abierto.id}); no se crea otra.`);
    return;
  }
  const { error } = await supabase.from("wa_prospect_leads").insert({
    phone,
    cuit,
    alta_step: 0,
    status: "pending",
    raw_messages: [{ role: "user", content: text, ts: new Date().toISOString() }],
  });
  // 23505 = chocó con el índice único parcial de sql/059: otra entrega del mismo mensaje
  // ganó la carrera. No es un error: el alta ya existe.
  if (error && error.code !== "23505") {
    console.error(`[alta] no se pudo crear el lead de ${phone}:`, error.message);
  }
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
    await enviarTexto(cfg, phone, reply);
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

/**
 * ¿Meta rechazó por idioma? El código 132001 es "Template name does not exist in the
 * translation": la plantilla existe, pero no en el idioma que le pedimos. Se mira el
 * `code` de `WaApiError` y, por las dudas, el texto (si algún día llega envuelto).
 */
function esErrorDeIdioma(e: unknown): boolean {
  if (e instanceof WaApiError && e.code === 132001) return true;
  return /132001|does not exist in the translation/i.test(e instanceof Error ? e.message : String(e));
}

async function flushOutbox(cfg: Config): Promise<{ sent: number; failed: number }> {
  const { data: batch, error } = await supabase.rpc("bot_flush_outbox", {
    p_limit: 20,
  });

  if (error || !batch?.length) {
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  // Idioma de las plantillas, configurable desde el Panel sin tocar código.
  const tplLang = (await getSetting("wa_template_lang")) || "es_AR";
  const tplLangAlt = (await getSetting("wa_template_lang_fallback")) || "es";

  for (const msg of batch) {
    try {
      if (msg.template_name) {
        // Enviar template aprobado por Meta
        const params: string[] = [];
        if (msg.template_params) {
          const vals = Object.values(msg.template_params);
          for (const v of vals) params.push(String(v));
        }
        // Punto 31 de la auditoría del 07/09: el idioma estaba clavado en "es_AR" y
        // `pedido_recordatorio_25` viene fallando con **#132001 "Template name does not
        // exist in the translation"**, que es literalmente "existe la plantilla pero no en
        // ese idioma". Ninguna plantilla se envió nunca con es_AR desde acá (las 12 salidas
        // son texto libre; la única con template es `hello_world`, en_US).
        //
        // Ahora: el idioma sale de `app_settings.wa_template_lang` (default es_AR) y, si
        // Meta contesta 132001, se reintenta UNA vez con el idioma de respaldo
        // (`wa_template_lang_fallback`, default "es"). No es adivinar: 132001 identifica
        // exactamente ese caso, y un solo reintento no puede volverse un loop.
        // El modulo compartido recibe los `components` de Meta ya armados (la copia local
        // que se borro los armaba adentro). Sin parametros no se manda `components`: Meta
        // rechaza un array vacio en una plantilla que no tiene variables.
        const comps = params.length
          ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }]
          : undefined;
        try {
          await sendTemplate(cfg.waPhoneId, cfg.waToken, msg.phone, msg.template_name, tplLang, comps);
        } catch (e) {
          if (!esErrorDeIdioma(e)) throw e;
          console.warn(`[outbox] ${msg.template_name} no existe en ${tplLang}; reintento en ${tplLangAlt}.`);
          await sendTemplate(cfg.waPhoneId, cfg.waToken, msg.phone, msg.template_name, tplLangAlt, comps);
        }
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
    await avisarDescartePorWhitelist(phone, {
      motivo: "whitelist_gate", origen: "adjunto", tipo_adjunto: msg.type, contact_name: msg.name ?? null,
    });
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
      await enviarTexto(cfg, phone, MSG_ADJUNTO_APAGADO);
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
      await enviarTexto(cfg, phone, MSG_ADJUNTO_APAGADO);
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
    await enviarTexto(cfg, phone, MSG_ADJUNTO_GRACIAS);
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
  // Es el SERVICE ROLE, no la anon key: se llamaba `anonKey` y eso confundía a cualquiera que
  // leyera esto (lo marcó la auditoría del 07/09). Y ahora además es lo que usa
  // `lk_parse-comprobante` para reconocer que la llamada es interna nuestra.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
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
/**
 * v14.13 — punto 16 de la auditoría del 07/09. Los dos gates de whitelist insertaban una fila en
 * `wa_alertas_humano` **por cada mensaje descartado**: un número fuera de la lista que escribe
 * veinte veces deja veinte alertas idénticas, y la tabla crece sin techo. Lo que se quiere saber
 * es *qué números intentaron*, no cuántas veces — así que se guarda una por teléfono y por día.
 *
 * v2 (2026-09-09) — el techo por día no alcanzaba: seguían entrando como `tipo='otro'` y
 * `estado='pendiente'`, o sea a la MISMA cola que un comprobante que falló. Medido el 09/09:
 * 633 alertas pendientes, **631 de ellas `whitelist_gate`** (99,7%), de 73 teléfonos de los que
 * **uno solo es cliente**. 534 salieron de un único evento el 03/09 15:22 — una encuesta mandada
 * desde esa línea que contestaron 54 personas ("35/40min", "2 hs", "A"/"B"): tráfico ajeno al bot.
 * Con eso, la cola de "atender a mano" era 99% ruido y lo poco real quedaba enterrado.
 *
 * Ahora se separa por QUIÉN escribió, que es lo único que cambia si hay que hacer algo:
 *
 *   · teléfono que resuelve a un cliente → `estado='pendiente'`. Un cliente real escribió y el
 *     bot no le contestó por la whitelist: eso sí lo tiene que ver alguien.
 *   · cualquier otro                     → `estado='descartado'`. Queda registrado (para saber
 *     qué números intentaron) pero no ensucia la cola.
 *
 * Y va con `tipo='whitelist_gate'` en vez de `'otro'`, para poder filtrarlo sin leer el jsonb.
 * `descartado` ya estaba en el CHECK de `estado` (sql/044), así que no hace falta tocar la tabla.
 */
async function avisarDescartePorWhitelist(phone: string, contexto: Record<string, unknown>): Promise<void> {
  try {
    const desde = new Date(); desde.setUTCHours(0, 0, 0, 0);
    const { count } = await supabase
      .from("wa_alertas_humano")
      .select("id", { count: "exact", head: true })
      .eq("phone", phone)
      .eq("contexto->>motivo", "whitelist_gate")
      .gte("created_at", desde.toISOString());
    if ((count ?? 0) > 0) return;   // ya quedó registrado hoy

    // Si falla la identificación, se asume que NO es cliente: mejor un aviso de menos en la cola
    // que volver a llenarla de ruido. La fila queda igual, con el teléfono, para poder revisarla.
    let cliente: CustomerContext | null = null;
    try { cliente = await getCustomerContext(phone); } catch { /* no identificado */ }

    await supabase.from("wa_alertas_humano").insert({
      tipo: "whitelist_gate",
      phone,
      customer_id: cliente?.customer_id ?? null,
      estado: cliente ? "pendiente" : "descartado",
      contexto: { ...contexto, es_cliente: !!cliente, cod_cliente: cliente?.cod_cliente ?? null },
    });
  } catch { /* fire-and-forget: no puede frenar el descarte */ }
}

async function estaEnWhitelist(phone: string): Promise<boolean> {
  const { data } = await supabase
    .from("wa_envio_contactos")
    .select("phone")
    .eq("phone", phone)
    .maybeSingle();
  return !!data;
}

/** Fila de `wa_blacklist` del número, o null si no está. `avisado_at` marca si ya se le
 *  mandó el aviso de "fuera de servicio" (para avisar UNA vez y después silencio). (sql/012) */
async function blacklistRow(phone: string): Promise<{ avisado_at: string | null } | null> {
  const { data, error } = await supabase
    .from("wa_blacklist")
    .select("phone, avisado_at")
    .eq("phone", phone)
    .maybeSingle();
  // Ante un error de lectura NO bloqueamos: es preferible atender de más que dejar
  // mudo a un cliente legítimo porque falló una consulta.
  if (error) { console.error("[blacklist] no pude consultar:", error.message); return null; }
  return data ? { avisado_at: (data.avisado_at as string | null) ?? null } : null;
}

/**
 * Tope de CONSULTAS AL AGENTE (IA) por hora y por teléfono (`wa_check_rate_limit`, sql/012).
 * Se llama sólo en el paso 6 (justo antes de `runConversation`), así que el contador de
 * `wa_rate_limit` cuenta únicamente los mensajes que llegan al agente — no las FAQ/AUTO ni
 * los flujos deterministas. Apagado por defecto: sólo corre si `wa_rate_limit_enabled = 1`.
 *
 * Devuelve null si puede seguir. Si pasó el tope devuelve `{ avisar }`, donde
 * `avisar` es true SÓLO en el primer mensaje por encima del tope: si no, cada
 * mensaje de más dispara otro aviso y el tope termina generando más tráfico del
 * que corta. Se mira `bot_historial_chat` para saber en cuál está.
 */
async function pasoElTope(phone: string): Promise<{ avisar: boolean } | null> {
  const habilitado = Number((await getSetting("wa_rate_limit_enabled")) ?? "0") === 1;
  if (!habilitado) return null;
  const limite = Number(await getSetting("wa_rate_limit_per_hour")) || 20;
  const { data: bloqueado, error } = await supabase
    .rpc("wa_check_rate_limit", { p_phone: phone, p_limit: limite });
  if (error) { console.error("[rate-limit] no pude consultar:", error.message); return null; }
  if (bloqueado !== true) return null;
  // El contador lo lleva la RPC en `wa_rate_limit`, por hora de reloj (date_trunc), y ya
  // sumó el mensaje de ahora. El primero que pasa el tope es el que deja el contador en
  // `limite + 1`: sólo ese avisa. No se recalcula por otro lado para no tener dos ventanas
  // distintas diciendo cosas distintas.
  const { data: fila } = await supabase
    .from("wa_rate_limit")
    .select("msg_count")
    .eq("phone", phone)
    .order("window_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  return { avisar: Number(fila?.msg_count ?? 0) === limite + 1 };
}


/**
 * Envío de texto que NO tumba el webhook. Devuelve true si Meta lo aceptó.
 *
 * Hace falta desde que el webhook usa `_shared/wa-api.ts` (2026-09-08), cuyo `waPost` LANZA
 * cuando Meta rechaza — que es lo correcto, pero acá hay que atajarlo: si una excepción sube
 * hasta el handler, el webhook devuelve 500 y **Meta reintenta el mismo mensaje**, con lo cual
 * el cliente recibe la respuesta dos veces o entra en loop. Peor que el problema original.
 *
 * Además, devolver el resultado permite NO guardar en el historial una respuesta que el
 * cliente nunca recibió (eso es exactamente lo que pasaba antes, cuando `waPost` se tragaba
 * el error: quedaba escrito "el bot contestó X" y el cliente no había visto nada).
 */
async function enviarTexto(cfg: Config, phone: string, texto: string): Promise<boolean> {
  try {
    await sendText(cfg.waPhoneId, cfg.waToken, phone, texto);
    return true;
  } catch (e) {
    const code = e instanceof WaApiError ? ` (code ${e.code})` : "";
    console.error(`[enviarTexto] Meta rechazó el mensaje a ${phone}${code}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// ─── Reporte de gerencia a pedido (idea 6600) ───────────────────────
//
// El reporte "💰 HOY" (plata del día + mes a la fecha) ya existe y sale por Telegram todos
// los días a las 20:00 ART — cron 36 `reporte-hoy-plata-telegram` → `rep_enviar_hoy()` →
// `rep_texto_hoy(fecha)`. Esto le da la MISMA fuente por WhatsApp, sin duplicar el texto.

/** Fecha de hoy en Argentina (UTC-3 fijo), con corrimiento opcional en días. */
function fechaArgentina(offsetDias = 0): string {
  const ms = Date.now() - 3 * 60 * 60 * 1000 + offsetDias * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * ¿Este teléfono puede pedir el reporte? Sale de `app_settings.wa_gerencia_phones`, un array
 * JSON de teléfonos en el formato de Meta (`["5491162521635"]`).
 *
 * **Arranca vacío a propósito: sin esa clave cargada, NADIE puede.** Estar en la whitelist
 * (`wa_envio_contactos`) no alcanza — esa lista es para que el bot conteste y el día que se
 * abra a clientes los va a incluir. La plata de la empresa necesita su propia lista.
 */
async function esGerencia(phone: string): Promise<boolean> {
  try {
    const raw = await getSetting("wa_gerencia_phones");
    if (!raw) return false;
    const lista = JSON.parse(raw);
    if (!Array.isArray(lista)) return false;
    const d = phone.replace(/\D/g, "");
    return lista.some((p: unknown) => {
      const q = String(p).replace(/\D/g, "");
      // Comparación por los últimos 8 dígitos: evita que un 54/9/15 de más lo haga fallar.
      return q.length >= 8 && d.length >= 8 && q.slice(-8) === d.slice(-8);
    });
  } catch { return false; }
}

/** "hoy", "plata", "reporte", "ventas" — con o sin acentos, y "… de ayer". */
function esComandoReporteHoy(text: string): boolean {
  const t = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // saca acentos
    .toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  // La cabeza temporal ("hoy" / "ayer") va sola; el calificativo de día sólo cuelga de un
  // sustantivo ("reporte de ayer"). Así "hoy ayer" no matchea nada.
  return /^((plata|reporte|ventas|numeros)( de)?( hoy| ayer)?|hoy|ayer)$/.test(t);
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
    await avisarDescartePorWhitelist(phone, {
      motivo: "whitelist_gate", texto_recibido: text.slice(0, 200), contact_name: contactName ?? null,
    });
    return;
  }

  // 0b. Blacklist. Punto 10 de la auditoría del 07/09: `wa_blacklist` y
  //     `wa_check_rate_limit` (sql/012, con su setting `wa_rate_limit_enabled`) existían
  //     sólo en `lk_chat-test`, o sea en el simulador del Panel. En el webhook real —el
  //     que atiende a los clientes— no había ni un hit: un número blacklisteado seguía
  //     siendo atendido y no había tope de mensajes por número.
  //     Se descarta. Pedido del dueño (2026-09-09): al PRIMER mensaje después de entrar a
  //     la blacklist se le responde una vez y después, silencio. `avisado_at` marca ese
  //     "ya avisé". Queda la fila en `wa_alertas_humano` para saber que escribió.
  {
    const bl = await blacklistRow(phone);
    if (bl) {
      console.warn(`[blacklist] mensaje de ${phone} descartado.`);
      if (!bl.avisado_at) {
        // Editable desde el Panel (app_settings.wa_blacklist_msg); fallback al default.
        const aviso = (await getSetting("wa_blacklist_msg"))?.trim() || `Estamos momentáneamente fuera de servicio.`;
        await enviarTexto(cfg, phone, aviso);
        await saveMessage(phone, "user", text);
        await saveMessage(phone, "assistant", aviso);
        await supabase.from("wa_blacklist")
          .update({ avisado_at: new Date().toISOString() }).eq("phone", phone);
      }
      await notificarHumano({
        tipo: "otro",
        phone,
        contexto: { motivo: "blacklist", texto_recibido: text.slice(0, 200) },
      });
      return;
    }
  }

  // NOTA: el rate limit NO va acá. Cuenta SÓLO las consultas que llegan al agente (IA),
  // así que su gate vive en el paso 6, justo antes de `runConversation` (más abajo). Las
  // FAQ/AUTO y los flujos deterministas (alta, identificación) no gastan cupo.

  // 1. Marcar como leído (fire-and-forget)
  markRead(cfg.waPhoneId, cfg.waToken, msgId).catch(() => {});

  // 1b. Reporte de gerencia a pedido (idea 6600). Va ACÁ, antes del modo humano y del
  //     FAQ/LLM: es una consulta interna, no gasta tokens y no tiene que competir con
  //     ninguna FAQ.
  //
  //     Por qué "a pedido" y no un push a las 20:00 como el de Telegram: WhatsApp sólo
  //     deja mandar texto libre DENTRO de la ventana de 24 h que abre el propio usuario
  //     al escribir. Un mensaje que sale sin que nadie haya escrito necesita una PLANTILLA
  //     aprobada por Meta, y las 6 que hay (`wa_tpl_*`) son todas de pedidos. Así que el
  //     push queda esperando esa aprobación, pero esto ya funciona hoy: el dueño escribe
  //     "hoy" y le llega el mismo texto que manda el cron 36.
  if (await esGerencia(phone) && esComandoReporteHoy(text)) {
    const ayer = text.toLowerCase().includes("ayer");
    const { data: rep, error: repErr } = await supabase.rpc("rep_texto_hoy", {
      p_fecha: fechaArgentina(ayer ? -1 : 0),
    });
    const salida = repErr || !rep
      ? "No pude armar el reporte ahora. Probá en un rato."
      : String(rep);
    if (repErr) console.error("[gerencia] rep_texto_hoy falló:", repErr.message);
    await enviarTexto(cfg, phone, salida);
    return;
  }

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
        await enviarTexto(cfg, phone, reply);
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
    // `faq.yaSaluda` = la respuesta ya arranca con "Hola…" (la FAQ del saludo inicial).
    // Sin ese chequeo el cliente recibía el saludo dos veces seguidas.
    const reply = customer && !faq.yaSaluda
      ? await conSaludoSiCorresponde(faq.reply, phone, customer.business_name)
      : faq.reply;
    await enviarTexto(cfg, phone, reply);
    await saveMessage(phone, "assistant", reply);
    // Punto 21 de la auditoría del 07/09: las FAQ `needs_human` le prometen al cliente
    // que "te va a contactar un asesor a la brevedad" y NADIE se enteraba — el aviso
    // estaba escrito como comentario y sin conectar. Era una promesa falsa en producción.
    // Va después de responder, y con `await` sin `try`: `notificarHumano` nunca lanza.
    if (faq.automation_level === "needs_human") {
      await notificarHumano({
        tipo: "escalation",
        phone,
        customerId: customer?.customer_id ?? null,
        contexto: {
          faq_id: faq.faq_id ?? null,
          tema: faq.topic ?? null,
          texto_recibido: text.slice(0, 200),
          razon_social: customer?.business_name ?? null,
        },
      });
    }
    return;
  }

  // 5. Sin cliente y sin FAQ → flujo de identificación (CUIT)
  if (!customer) {
    await handleRegistration(phone, text, contactName, cfg);
    return;
  }

  // 6. Cliente identificado, FAQ no matcheó → agente conversacional
  await saveMessage(phone, "user", text);

  // 6a. Rate limit (SÓLO consultas al agente/IA, cualquier modelo). El contador de
  //     `wa_rate_limit` sólo se incrementa acá, así que el tope `wa_rate_limit_per_hour`
  //     es "N consultas de IA por hora por número". Si lo pasó, no llamamos al agente
  //     (ahorra tokens) y se avisa UNA vez por hora (ver `pasoElTope`).
  const rateLimited = await pasoElTope(phone);
  if (rateLimited) {
    if (rateLimited.avisar) {
      // Editable desde el Panel (app_settings.wa_rate_limit_msg); fallback al default.
      const aviso = (await getSetting("wa_rate_limit_msg"))?.trim() || `Estamos con problemas en este momento, probá contactarte de vuelta en una hora.`;
      await enviarTexto(cfg, phone, aviso);
      await saveMessage(phone, "assistant", aviso);
    }
    return;
  }

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
  await enviarTexto(cfg, phone, reply);

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
      // Punto 16 de la auditoría del 07/09: acá se leía SÓLO la env var, mientras
      // `loadConfig` (:48) prioriza `app_settings`. O sea que rotar el verify token
      // desde el Panel dejaba la verificación de Meta devolviendo 403 sin más síntoma
      // que este log. Se usa el mismo orden que loadConfig.
      const expected = (await getSetting("LK_WA_VERIFY_TOKEN")) ?? Deno.env.get("LK_WA_VERIFY_TOKEN") ?? "";
      if (expected && token === expected) {
        return new Response(challenge, { status: 200 });
      }
      console.warn(`[verify] token mismatch. Got: ${token?.slice(0, 8)}…  Configurado: ${!!expected}`);
      return new Response("Forbidden", { status: 403 });
    }

    return new Response("OK", { status: 200 });
  }

  // ── POST: Mensaje entrante o acción interna ──
  if (req.method === "POST") {
    try {
      // El cuerpo se lee CRUDO: la firma de Meta es un HMAC del texto exacto que llegó, así
      // que parsear y re-serializar rompería la verificación (cambia espacios y orden).
      const rawBody = await req.text();

      // deno-lint-ignore no-explicit-any
      let body: any;
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        console.warn("[webhook] body no es JSON válido");
        return new Response("OK", { status: 200 });
      }

      // TODO POST tiene que venir firmado por Meta (X-Hub-Signature-256). La vieja "acción
      // interna" `{"action":"flush"}` con `LK_INTERNAL_SECRET` se RETIRÓ (2026-09-10): era código
      // muerto — el flush del outbox lo hace el cron `wa_outbox_flush` → edge `lk_outbox-flush`,
      // no este webhook (verificado: 0 crons/repos la llamaban). Dejarla abierta era una puerta
      // pública sin uso. Ahora un POST que no sea un webhook legítimo de Meta se corta acá.
      const firma = await verificarFirmaMeta(rawBody, req.headers.get("x-hub-signature-256"));
      if (!firma.ok) {
        // Payload que dice ser de Meta y no lo es. Se corta acá, sin procesar.
        console.warn(`[firma] POST rechazado: ${firma.motivo}`);
        return new Response("Forbidden", { status: 403 });
      }
      if (firma.modo === "sin_secreto") {
        // Falta cargar META_APP_SECRET (ver webhook-firma.ts). Hoy YA está cargado.
        console.warn("[firma] META_APP_SECRET sin cargar — el POST NO se está verificando.");
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

      // ── Candado de idempotencia (sql/057) ──
      // Meta REINTENTA el webhook si no ve el 200 a tiempo. Sin esto el mismo mensaje se
      // contesta dos veces y, si era la confirmación de un pedido, el pedido se duplica.
      // El insert es atómico: si la fila ya estaba, es un reintento y se corta acá.
      if (msg.msgId) {
        const { error: dup } = await supabase
          .from("wa_inbound_seen")
          .insert({ wamid: msg.msgId, phone: msg.from });
        if (dup) {
          // 23505 = unique_violation → ya lo procesamos. Cualquier otro error NO frena el
          // mensaje: preferimos contestar dos veces antes que no contestar nunca.
          if (dup.code === "23505") {
            console.log(`[idem] wamid repetido, se ignora: ${msg.msgId}`);
            return new Response("OK", { status: 200 });
          }
          console.error("[idem] no se pudo registrar el wamid, se sigue igual:", dup.message);
        }
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
