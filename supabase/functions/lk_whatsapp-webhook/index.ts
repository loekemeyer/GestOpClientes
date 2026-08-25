// lk_whatsapp-webhook — Webhook principal del bot WhatsApp Loekemeyer
// Edge Function en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
//
// GET  → verificación Meta
// POST → mensaje entrante de WhatsApp

import { supabase, getSetting } from "../_shared/supabase.ts";
import {
  sendText,
  markRead,
  extractMessage,
  phoneVariants,
} from "../_shared/wa-api.ts";
import {
  detectIntent,
  conversationalReply,
} from "../_shared/claude.ts";

// ─── Config ─────────────────────────────────────────────────────────

interface Config {
  waPhoneId: string;
  waToken: string;
  waVerifyToken: string;
  anthropicKey: string;
}

async function loadConfig(): Promise<Config> {
  const [waPhoneId, waToken, waVerifyToken, anthropicKey] = await Promise.all([
    getSetting("LK_WA_PHONE_ID"),
    getSetting("LK_WA_TOKEN"),
    getSetting("LK_WA_VERIFY_TOKEN"),
    getSetting("ANTHROPIC_API_KEY"),
  ]);

  if (!waPhoneId || !waToken || !waVerifyToken || !anthropicKey) {
    throw new Error(
      "Faltan secrets en app_settings: " +
        [
          !waPhoneId && "LK_WA_PHONE_ID",
          !waToken && "LK_WA_TOKEN",
          !waVerifyToken && "LK_WA_VERIFY_TOKEN",
          !anthropicKey && "ANTHROPIC_API_KEY",
        ]
          .filter(Boolean)
          .join(", "),
    );
  }

  return { waPhoneId, waToken, waVerifyToken, anthropicKey };
}

// ─── Customer lookup ────────────────────────────────────────────────

interface Customer {
  id: string;
  cod_cliente: number;
  business_name: string;
  cuit: string | null;
  whatsapp: string;
  debt: number;
  dto_vol: number;
  vend: string | null;
}

/** Busca un customer por teléfono WhatsApp, probando múltiples formatos */
async function findCustomerByPhone(phone: string): Promise<Customer | null> {
  const variants = phoneVariants(phone);

  const { data, error } = await supabase
    .from("customers")
    .select("id, cod_cliente, business_name, cuit, whatsapp, debt, dto_vol, vend")
    .in("whatsapp", variants)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Error buscando customer:", error.message);
    return null;
  }

  return data;
}

/** Busca un customer por código o CUIT (para vinculación) */
async function findCustomerByCodeOrCuit(
  input: string,
): Promise<Customer | null> {
  const clean = input.trim();

  // Intentar por cod_cliente (numérico)
  if (/^\d{1,6}$/.test(clean)) {
    const { data } = await supabase
      .from("customers")
      .select("id, cod_cliente, business_name, cuit, whatsapp, debt, dto_vol, vend")
      .eq("cod_cliente", parseInt(clean))
      .maybeSingle();
    if (data) return data;
  }

  // Intentar por CUIT (11 dígitos, con o sin guiones)
  const cuitDigits = clean.replace(/\D/g, "");
  if (cuitDigits.length === 11) {
    const { data } = await supabase
      .from("customers")
      .select("id, cod_cliente, business_name, cuit, whatsapp, debt, dto_vol, vend")
      .eq("cuit", cuitDigits)
      .maybeSingle();
    if (data) return data;
  }

  return null;
}

/** Vincula un teléfono WhatsApp a un customer */
async function linkPhone(customerId: string, phone: string): Promise<void> {
  await supabase
    .from("customers")
    .update({ whatsapp: phone })
    .eq("id", customerId);
}

// ─── Consulta de pedidos ────────────────────────────────────────────

interface OrderSummary {
  id: number;
  created_at: string;
  total: number;
  status: string;
  tracking_status: string | null;
  fecha_entrega: string | null;
}

async function getRecentOrders(customerId: string): Promise<OrderSummary[]> {
  // Pedidos de los últimos 90 días
  const since = new Date();
  since.setDate(since.getDate() - 90);

  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, created_at, total, status, customer_code")
    .eq("customer_id", customerId)
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(5);

  if (error || !orders?.length) return [];

  // Buscar tracking para estos pedidos
  const npNumbers = orders.map((o) => String(o.id));
  const { data: tracking } = await supabase
    .from("order_tracking")
    .select("np_number, status, fecha_entrega")
    .in("np_number", npNumbers);

  const trackMap = new Map(
    (tracking ?? []).map((t) => [t.np_number, t]),
  );

  return orders.map((o) => {
    const t = trackMap.get(String(o.id));
    return {
      id: o.id,
      created_at: o.created_at,
      total: o.total,
      status: o.status,
      tracking_status: t?.status ?? null,
      fecha_entrega: t?.fecha_entrega ?? null,
    };
  });
}

function formatOrderList(orders: OrderSummary[]): string {
  if (!orders.length) {
    return "No tenés pedidos recientes (últimos 90 días).";
  }

  const statusEmoji: Record<string, string> = {
    programado: "📦",
    recibido: "📋",
    entregado: "✅",
  };

  const lines = orders.map((o, i) => {
    const date = new Date(o.created_at).toLocaleDateString("es-AR");
    const total = Number(o.total).toLocaleString("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    });

    let estado = "⏳ Pendiente";
    if (o.tracking_status) {
      const emoji = statusEmoji[o.tracking_status] ?? "📌";
      const label = o.tracking_status.charAt(0).toUpperCase() + o.tracking_status.slice(1);
      estado = `${emoji} ${label}`;
      if (o.fecha_entrega && o.tracking_status === "programado") {
        const fe = new Date(o.fecha_entrega + "T12:00:00").toLocaleDateString("es-AR");
        estado += ` para ${fe}`;
      }
    }

    return `${i + 1}️⃣ NP-${o.id} (${date}) — ${total}\n     ${estado}`;
  });

  return `Tus pedidos recientes:\n\n${lines.join("\n\n")}\n\n¿Necesitás más detalle de alguno?`;
}

// ─── Log de conversaciones ──────────────────────────────────────────

async function logConversation(
  phone: string,
  direction: "in" | "out",
  body: string,
  customerId: string | null,
  intent: string | null,
  waMsgId: string | null,
): Promise<void> {
  // Solo loguear si existe la tabla (no romper si aún no se corrió la migración)
  try {
    await supabase.from("wa_conversations").insert({
      phone,
      direction,
      body: body.slice(0, 4000),
      customer_id: customerId,
      intent,
      wa_msg_id: waMsgId,
    });
  } catch {
    // Tabla puede no existir aún — no romper
  }
}

// ─── Handler principal ──────────────────────────────────────────────

async function handleMessage(
  phone: string,
  text: string,
  msgId: string,
  contactName: string | undefined,
  cfg: Config,
): Promise<void> {
  // 1. Marcar como leído
  markRead(cfg.waPhoneId, cfg.waToken, msgId).catch(() => {});

  // 2. Buscar customer
  const customer = await findCustomerByPhone(phone);

  if (!customer) {
    // ── Flujo de vinculación ──
    // Intentar interpretar el mensaje como código/CUIT
    const match = await findCustomerByCodeOrCuit(text);

    if (match) {
      // Vincular y saludar
      await linkPhone(match.id, phone);
      const reply =
        `¡Hola ${match.business_name}! 👋\n\n` +
        `Ya quedaste vinculado a este número.\n` +
        `Podés consultarme por:\n\n` +
        `📦 Estado de tus pedidos\n` +
        `🛒 Hacer un pedido nuevo\n` +
        `💬 Cualquier otra consulta`;
      await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);
      await logConversation(phone, "in", text, match.id, "vinculacion", msgId);
      await logConversation(phone, "out", reply, match.id, null, null);
    } else {
      // Pedir identificación
      const reply =
        `¡Hola${contactName ? " " + contactName : ""}! 👋\n\n` +
        `Soy el asistente de *Loekemeyer*. ` +
        `Para poder ayudarte, necesito identificarte.\n\n` +
        `¿Me pasás tu *código de cliente* o tu *CUIT*?`;
      await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);
      await logConversation(phone, "in", text, null, "no_identificado", msgId);
      await logConversation(phone, "out", reply, null, null, null);
    }
    return;
  }

  // 3. Cliente identificado — detectar intent
  const { intent, detail } = await detectIntent(text, cfg.anthropicKey);

  await logConversation(phone, "in", text, customer.id, intent, msgId);

  let reply: string;

  switch (intent) {
    case "consulta_pedido": {
      const orders = await getRecentOrders(customer.id);
      reply = formatOrderList(orders);
      break;
    }

    case "nuevo_pedido": {
      // TODO: implementar flujo de nuevo pedido (Paso 5 del plan)
      reply =
        `🛒 ¡Genial! Para hacer un pedido, por ahora usá nuestra web:\n\n` +
        `🌐 loekemeyer.com\n\n` +
        `Pronto vas a poder pedir directamente por acá. 😊`;
      break;
    }

    case "consulta_producto": {
      // TODO: búsqueda de productos
      reply =
        `Para consultar productos y precios, visitá nuestro catálogo en:\n\n` +
        `🌐 loekemeyer.com\n\n` +
        `O contactá a ventas: 📧 ventas@loekemeyer.com`;
      break;
    }

    case "saludo": {
      reply =
        `¡Hola ${customer.business_name}! 👋\n\n` +
        `¿En qué te puedo ayudar?\n\n` +
        `📦 Consultá el estado de tus pedidos\n` +
        `🛒 Hacé un pedido nuevo\n` +
        `💬 O preguntame lo que necesites`;
      break;
    }

    case "ayuda": {
      reply =
        `Puedo ayudarte con:\n\n` +
        `📦 *Estado de pedidos* — \"¿Cómo va mi pedido?\"\n` +
        `🛒 *Hacer un pedido* — \"Quiero pedir\"\n` +
        `💬 *Consultas generales* — Escribime tu pregunta\n\n` +
        `¿Qué necesitás?`;
      break;
    }

    default: {
      // Respuesta conversacional con Claude Sonnet
      reply = await conversationalReply(
        text,
        customer.business_name,
        cfg.anthropicKey,
      );
      break;
    }
  }

  await sendText(cfg.waPhoneId, cfg.waToken, phone, reply);
  await logConversation(phone, "out", reply, customer.id, null, null);
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
        const cfg = await loadConfig();
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

  // ── POST: Mensaje entrante ──
  if (req.method === "POST") {
    // Siempre responder 200 a Meta (no perder webhook)
    try {
      const body = await req.json();

      // TODO: action=flush para wa_outbox (Paso 4)

      const msg = extractMessage(body);
      if (!msg) {
        // Status update u otro evento no procesable
        return new Response("OK", { status: 200 });
      }

      // Solo procesar mensajes de texto por ahora
      if (msg.type !== "text" || !msg.text.trim()) {
        return new Response("OK", { status: 200 });
      }

      const cfg = await loadConfig();

      // Procesar en background para no bloquear la respuesta a Meta
      // EdgeRuntime.waitUntil no está disponible en Supabase,
      // así que procesamos antes de responder (Meta tolera hasta 20s)
      await handleMessage(msg.from, msg.text, msg.msgId, msg.name, cfg);
    } catch (e) {
      console.error("Error procesando mensaje:", e);
    }

    // Siempre 200
    return new Response("OK", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
});
