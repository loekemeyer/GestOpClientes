import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { supabase, getSetting } from "../_shared/supabase.ts";
import { canonPhone } from "../_shared/wa-api.ts";
import { detectIntent, conversationalReply } from "../_shared/claude.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();

    // ── Stats endpoint (admin cost panel) ──
    if (body.action === "stats") {
      return await handleStats(body.since);
    }

    // ── Config get (rate limit settings) ──
    if (body.action === "config_get") {
      return await handleConfigGet();
    }

    // ── Config save (rate limit settings) ──
    if (body.action === "config_save") {
      return await handleConfigSave(body);
    }

    // ── Blacklist list ──
    if (body.action === "blacklist_list") {
      return await handleBlacklistList();
    }

    // ── Blacklist add ──
    if (body.action === "blacklist_add") {
      return await handleBlacklistAdd(body.phone, body.reason);
    }

    // ── Blacklist remove ──
    if (body.action === "blacklist_remove") {
      return await handleBlacklistRemove(body.id);
    }

    // ── Chat endpoint ──
    const { phone, text, noAI, skipRateLimit } = body;
    if (!phone || !text) {
      return json({ error: "phone y text requeridos" }, 400);
    }

    const testPhone = canonPhone(phone);

    // ── Blacklist check ──
    const { data: blEntry } = await supabase
      .from("wa_blacklist")
      .select("id")
      .eq("phone", testPhone)
      .maybeSingle();
    if (blEntry) {
      return json({ reply: "🚫 Este número está en la blacklist y no puede usar el bot.", blocked: true });
    }

    // ── Rate limit check (skip si toggle activo en test) ──
    if (!skipRateLimit) {
      const rlEnabled = await getSetting("wa_rate_limit_enabled");
      if (rlEnabled && Number(rlEnabled) === 1) {
        const rlLimit = Number(await getSetting("wa_rate_limit_per_hour")) || 20;
        const { data: blocked } = await supabase
          .rpc("wa_check_rate_limit", { p_phone: testPhone, p_limit: rlLimit });
        if (blocked === true) {
          return json({ reply: `⏳ Límite de mensajes alcanzado (${rlLimit}/hora). Intentá más tarde.`, rateLimited: true });
        }
      }
    }

    // Paso 0: identificar cliente por teléfono
    let customerRow: { id: string; cod_cliente: number; business_name: string } | null = null;

    const { data: identified } = await supabase
      .rpc("wa_identify_customer", { p_phone: phone });
    const iRow = identified?.[0];
    if (iRow) {
      customerRow = {
        id: iRow.customer_id,
        cod_cliente: Number(iRow.cod_cliente),
        business_name: iRow.customer_name,
      };
    } else {
      const { data: legacy } = await supabase
        .rpc("bot_cliente_por_whatsapp", { p_telefono: testPhone });
      customerRow = legacy?.[0] ?? null;
    }

    let reply: string;
    let detectedIntent: string | null = null;

    // ── Paso 1: FAQ trigram ANTES de gastar tokens (0 tokens) ──
    const faqResult = await handleFaq(text, customerRow);
    if (faqResult) {
      detectedIntent = faqResult.intent;
      reply = faqResult.reply;

      const customerId = customerRow?.id ?? null;
      supabase.from("wa_conversations").insert([
        { phone, direction: "in",  body: text,  msg_type: "text", customer_id: customerId, intent: detectedIntent },
        { phone, direction: "out", body: reply, msg_type: "text", customer_id: customerId, intent: detectedIntent },
      ]).then(() => {}).catch((e: unknown) => console.error("conv log err:", e));

      return json({ reply, customer: customerRow?.business_name ?? null, faqHit: true });
    }

    // ── Modo sin IA: solo FAQ, ya intentamos arriba ──
    if (noAI) {
      const noAiReply = "🤷 No encontré una respuesta automática para eso. Activá el Agente IA para respuestas más completas.";
      supabase.from("wa_conversations").insert([
        { phone, direction: "in",  body: text,  msg_type: "text", customer_id: customerRow?.id ?? null, intent: "no_match" },
        { phone, direction: "out", body: noAiReply, msg_type: "text", customer_id: customerRow?.id ?? null, intent: "no_match" },
      ]).then(() => {}).catch((e: unknown) => console.error("conv log err:", e));
      return json({ reply: noAiReply, customer: customerRow?.business_name ?? null, noAI: true });
    }

    // ── Paso 2: IA (requiere API key) ──
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")
      ?? Deno.env.get("CLAUDE_API_KEY")
      ?? (await getSetting("anthropic_api_key"))
      ?? "";

    if (!anthropicKey) {
      return json({ reply: "⚠️ API Key de Claude no configurada. Configurala en Supabase secrets como ANTHROPIC_API_KEY o CLAUDE_API_KEY." });
    }

    if (!customerRow) {
      detectedIntent = "linking";
      reply = await handleLinking(testPhone, text, anthropicKey);
    } else {
      const { intent } = await detectIntent(anthropicKey, text);
      detectedIntent = intent;

      switch (intent) {
        case "consulta_pedido":
          reply = await handleOrderQuery(customerRow);
          break;
        case "nuevo_pedido":
          reply = await handleNewOrder(testPhone, customerRow, text, anthropicKey);
          break;
        case "retiro":
          reply = await handlePickup(customerRow);
          break;
        case "cancelar":
          reply = await handleCancel(testPhone);
          break;
        case "ayuda":
          reply = menuText(customerRow.business_name);
          break;
        case "opt_out":
          reply = "⚠️ Opt-out deshabilitado en modo test.";
          break;
        default:
          reply = await handleGeneral(customerRow, text, anthropicKey);
      }
    }

    // Log conversación (fire and forget, no bloquea respuesta)
    const customerId = customerRow?.id ?? null;
    supabase.from("wa_conversations").insert([
      { phone, direction: "in",  body: text,  msg_type: "text", customer_id: customerId, intent: detectedIntent },
      { phone, direction: "out", body: reply, msg_type: "text", customer_id: customerId, intent: detectedIntent },
    ]).then(() => {}).catch((e: unknown) => console.error("conv log err:", e));

    return json({ reply, customer: customerRow?.business_name ?? null });
  } catch (err) {
    console.error("chat-test error:", err);
    return json({ reply: `❌ Error: ${err.message}` });
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function menuText(nombre?: string): string {
  const saludo = nombre ? `Hola ${nombre}!` : "¡Hola!";
  return `${saludo} Podés preguntarme por:
📦 Estado de tus pedidos
🛒 Hacer un pedido nuevo
🚚 Saber si podés pasar a retirar
💬 Cualquier otra consulta`;
}

// ── Config & Blacklist handlers ──

async function handleConfigGet() {
  const perHour = await getSetting("wa_rate_limit_per_hour");
  const enabled = await getSetting("wa_rate_limit_enabled");
  return json({
    rate_limit_per_hour: Number(perHour) || 20,
    rate_limit_enabled: Number(enabled) === 1,
  });
}

async function handleConfigSave(body: Record<string, unknown>) {
  const updates: Promise<unknown>[] = [];

  if (body.rate_limit_per_hour !== undefined) {
    updates.push(
      supabase.from("app_settings")
        .upsert({ key: "wa_rate_limit_per_hour", value: Number(body.rate_limit_per_hour) }, { onConflict: "key" })
    );
  }
  if (body.rate_limit_enabled !== undefined) {
    updates.push(
      supabase.from("app_settings")
        .upsert({ key: "wa_rate_limit_enabled", value: body.rate_limit_enabled ? 1 : 0 }, { onConflict: "key" })
    );
  }

  await Promise.all(updates);
  return json({ ok: true });
}

async function handleBlacklistList() {
  const { data: items, error } = await supabase
    .from("wa_blacklist")
    .select("id, phone, reason, created_at, created_by")
    .order("created_at", { ascending: false });

  if (error) return json({ error: error.message }, 500);

  // Enriquecer con nombre de cliente si existe
  const enriched = await Promise.all(
    (items ?? []).map(async (item) => {
      let customer_name: string | null = null;
      const { data: identified } = await supabase
        .rpc("wa_identify_customer", { p_phone: item.phone });
      if (identified?.[0]) {
        customer_name = identified[0].customer_name;
      }
      return { ...item, customer_name };
    })
  );

  return json({ items: enriched });
}

async function handleBlacklistAdd(phone?: string, reason?: string) {
  if (!phone) return json({ error: "phone requerido" }, 400);

  const canonical = canonPhone(phone);

  // Verificar si ya existe
  const { data: existing } = await supabase
    .from("wa_blacklist")
    .select("id")
    .eq("phone", canonical)
    .maybeSingle();
  if (existing) return json({ error: "Ya está en la blacklist" }, 409);

  // Buscar nombre de cliente
  let customer_name: string | null = null;
  const { data: identified } = await supabase
    .rpc("wa_identify_customer", { p_phone: canonical });
  if (identified?.[0]) {
    customer_name = identified[0].customer_name;
  }

  const { error } = await supabase
    .from("wa_blacklist")
    .insert({ phone: canonical, reason: reason || null, created_by: "admin" });

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, customer_name });
}

async function handleBlacklistRemove(id?: number) {
  if (!id) return json({ error: "id requerido" }, 400);

  const { error } = await supabase
    .from("wa_blacklist")
    .delete()
    .eq("id", id);

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

// ── Stats handler ──

async function handleStats(since?: string) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  // Semana empieza el lunes
  const day = now.getUTCDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  const ws = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset));
  const weekStart = ws.toISOString();

  const { data: monthRows } = await supabase
    .from("bot_token_usage")
    .select("input_tokens, output_tokens, estimated_cost_usd, created_at")
    .gte("created_at", monthStart);

  // deno-lint-ignore no-explicit-any
  const aggregate = (rows: any[] | null) => {
    if (!rows?.length) return { cost: 0, input_tokens: 0, output_tokens: 0, calls: 0 };
    return {
      cost: rows.reduce((s, r) => s + Number(r.estimated_cost_usd), 0),
      input_tokens: rows.reduce((s, r) => s + (r.input_tokens ?? 0), 0),
      output_tokens: rows.reduce((s, r) => s + (r.output_tokens ?? 0), 0),
      calls: rows.length,
    };
  };

  const allMonth = monthRows ?? [];
  const weekRows = allMonth.filter(r => r.created_at >= weekStart);
  const sessionRows = since ? allMonth.filter(r => r.created_at >= since) : null;

  return json({
    month: aggregate(allMonth),
    week: aggregate(weekRows),
    session: sessionRows ? aggregate(sessionRows) : { cost: 0, input_tokens: 0, output_tokens: 0, calls: 0 },
  });
}

// ── Handlers (misma lógica que webhook, sin enviar a WA) ──

// ── Alta de cliente nuevo: pasos secuenciales, 0 tokens ──

const ALTA_INTRO = `¡Genial! Te voy a dar de alta como cliente.\n\n📋 ¿Cuál es tu *razón social*?`;

// Orden de campos a pedir (CUIT ya lo tenemos del paso de identificación)
const ALTA_STEPS: { field: string; prompt: string }[] = [
  { field: "razon_social",     prompt: "📋 ¿Cuál es tu *razón social*?" },
  { field: "nombre_contacto",  prompt: "👤 ¿*Nombre de contacto*?" },
  { field: "telefono",         prompt: "📱 ¿*Teléfono* de contacto?" },
  { field: "mail",             prompt: "📧 ¿*Mail*?" },
  { field: "direccion",        prompt: "📍 ¿*Dirección*?" },
  { field: "localidad",        prompt: "📍 ¿*Localidad*?" },
  { field: "expreso_nombre",   prompt: "🚚 ¿Con qué *expreso* trabajan? (nombre)" },
  { field: "expreso_direccion", prompt: "🚚 ¿*Dirección del expreso*?" },
  { field: "expreso_telefono", prompt: "🚚 ¿*Teléfono del expreso*?" },
  { field: "tipo_comercio",    prompt: "🏪 ¿*Tipo de comercio*? (Ej: Bazar, mayorista, distribuidor)" },
  { field: "dimension_comercio", prompt: "🏪 ¿*Dimensión del comercio*? (Ej: 4x8=32m²)" },
  { field: "tiene_venta_web",  prompt: "🌐 ¿Tiene *venta web / página*?" },
  { field: "ya_vende_lk",      prompt: "📦 ¿Ya vendés *mercadería Loekemeyer*? (Sí/No)" },
];

// Paso extra según respuesta de ya_vende_lk
const STEP_A_QUIEN = "📦 ¿A quién le comprás actualmente?";
const STEP_COMO_CONOCE = "📢 ¿De dónde conocés la marca?";

async function handleLinking(phone: string, text: string, apiKey: string): Promise<string> {
  // ── ¿Ya tiene un lead en curso? → siguiente paso del alta ──
  const { data: existingLead } = await supabase
    .from("wa_prospect_leads")
    .select("id, razon_social, nombre_contacto, telefono, mail, direccion, localidad, expreso_nombre, expreso_direccion, expreso_telefono, tipo_comercio, dimension_comercio, tiene_venta_web, ya_vende_lk, a_quien_compra, como_conoce_marca, alta_step, raw_messages")
    .eq("phone", phone)
    .eq("status", "pending")
    .maybeSingle();

  if (existingLead) {
    return await handleAltaStep(phone, text, existingLead);
  }

  // ── Dice "soy nuevo" / "no soy cliente" → crear lead y empezar alta ──
  if (/\b(soy nuevo|no soy cliente|nuevo cliente|quiero ser cliente|darme de alta|primera vez)\b/i.test(text)) {
    await supabase.from("wa_prospect_leads").insert({
      phone,
      alta_step: 0,
      raw_messages: [{ role: "user", content: text, ts: new Date().toISOString() }],
    });
    return ALTA_INTRO;
  }

  const cleaned = text.replace(/[^0-9]/g, "");
  if (!cleaned) {
    return "¡Hola! Soy el asistente de Loekemeyer. Para poder ayudarte, necesito identificarte. ¿Me pasás tu CUIT o código de cliente?\n\nSi todavía no sos cliente, decime *soy nuevo* y te ayudo con el alta.";
  }

  // ── Buscar por código de cliente ──
  let customer = null;
  const { data: byCod } = await supabase
    .from("customers")
    .select("id, cod_cliente, business_name")
    .eq("cod_cliente", parseInt(cleaned))
    .maybeSingle();
  customer = byCod;

  // ── Buscar por CUIT si tiene 10+ dígitos ──
  if (!customer && cleaned.length >= 10) {
    const { data: byCuit } = await supabase
      .from("customers")
      .select("id, cod_cliente, business_name")
      .eq("cuit", cleaned)
      .maybeSingle();
    customer = byCuit;
  }

  // ── Cliente encontrado → vincular ──
  if (customer) {
    await supabase.from("bot_customer_whatsapps").upsert({
      customer_id: customer.id,
      whatsapp: phone,
      is_primary: true,
      empresa: "LK",
      cod_cliente: customer.cod_cliente,
      permiso_ver_pedidos: true,
    }, { onConflict: "whatsapp" });
    return `¡Hola ${customer.business_name}! Ya quedaste vinculado.\n${menuText()}`;
  }

  // ── CUIT no encontrado → cliente nuevo, arrancar alta ──
  if (cleaned.length >= 10) {
    await supabase.from("wa_prospect_leads").insert({
      phone,
      cuit: cleaned,
      alta_step: 0,
      raw_messages: [{ role: "user", content: text, ts: new Date().toISOString() }],
    });
    return `No encontré ese CUIT en nuestro sistema. ¡Pero no hay problema, te damos de alta!\n\n${ALTA_INTRO}`;
  }

  // ── Código corto no encontrado ──
  return "No encontré ese código. ¿Me pasás tu CUIT? Si todavía no sos cliente, decime *soy nuevo* y te ayudo con el alta.";
}

// ── Alta paso a paso: cada respuesta va al campo que toca ──

// deno-lint-ignore no-explicit-any
async function handleAltaStep(phone: string, text: string, lead: any): Promise<string> {
  const step: number = lead.alta_step ?? 0;
  const messages = Array.isArray(lead.raw_messages) ? [...lead.raw_messages] : [];
  messages.push({ role: "user", content: text, ts: new Date().toISOString() });

  // Guardar respuesta en el campo correspondiente al paso actual
  if (step < ALTA_STEPS.length) {
    const currentField = ALTA_STEPS[step].field;
    let value: unknown = text.trim();

    // ya_vende_lk → convertir a boolean
    if (currentField === "ya_vende_lk") {
      value = /^(si|sí|s|yes|y|1|true)\b/i.test(text.trim());
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

    // ── ¿Terminamos los pasos base? ──
    if (nextStep >= ALTA_STEPS.length) {
      // Preguntar paso extra según ya_vende_lk
      const yaVende = currentField === "ya_vende_lk" ? value : lead.ya_vende_lk;
      if (yaVende === true) {
        return STEP_A_QUIEN;
      }
      return STEP_COMO_CONOCE;
    }

    return ALTA_STEPS[nextStep].prompt;
  }

  // ── Paso extra: a_quien_compra o como_conoce_marca ──
  const yaVende = lead.ya_vende_lk;
  const needsExtra = yaVende === true ? "a_quien_compra" : "como_conoce_marca";

  if (!lead[needsExtra]) {
    await supabase.from("wa_prospect_leads")
      .update({
        [needsExtra]: text.trim(),
        status: "complete",
        raw_messages: messages,
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead.id);

    return `✅ ¡Listo! Ya tenemos todos tus datos. Tu solicitud de alta fue registrada y va a ser revisada por el equipo de ventas.\n\nTe vamos a contactar cuando esté aprobada. ¡Gracias! 🙌`;
  }

  // Ya completó todo — mensaje genérico
  return "Tu solicitud de alta ya fue registrada ✅ Un vendedor se va a poner en contacto con vos.";
}

async function handleOrderQuery(
  customer: { id: string; cod_cliente: number; business_name: string },
): Promise<string> {
  const { data: orders } = await supabase
    .from("orders")
    .select("id, created_at, total, status")
    .eq("customer_id", customer.id)
    .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(5);

  if (!orders?.length) return "No tenés pedidos recientes (últimos 90 días).";

  const orderIds = orders.map((o) => String(o.id));
  const { data: tracking } = await supabase
    .from("order_tracking")
    .select("np_number, status, fecha_entrega")
    .in("np_number", orderIds);

  const trackingMap = new Map((tracking ?? []).map((t) => [t.np_number, t]));

  const lines = orders.map((o, i) => {
    const t = trackingMap.get(String(o.id));
    const fecha = new Date(o.created_at).toLocaleDateString("es-AR");
    const total = `$${Number(o.total).toLocaleString("es-AR")}`;
    let estado = o.status;
    if (t) {
      estado = t.status;
      if (t.fecha_entrega) estado += ` para ${t.fecha_entrega}`;
    }
    const emoji = t?.status === "entregado" ? "✅" : "📦";
    return `${i + 1}️⃣ NP-${o.id} (${fecha}) — ${total} — ${emoji} ${estado}`;
  });

  return `Tus pedidos recientes:\n${lines.join("\n")}\n\n¿Necesitás más detalle de alguno?`;
}

async function handleNewOrder(
  phone: string,
  customer: { id: string; cod_cliente: number; business_name: string },
  text: string,
  apiKey: string,
): Promise<string> {
  let { data: draft } = await supabase
    .from("wa_order_draft")
    .select("*")
    .eq("phone", phone)
    .in("status", ["building", "confirming"])
    .maybeSingle();

  if (!draft) {
    await supabase.from("wa_order_draft").insert({
      phone,
      customer_id: customer.id,
      items: [],
      status: "building",
    });
    draft = { items: [], status: "building" };
  }

  if (draft.status === "confirming" && /^(si|sí|confirmo|dale|ok)\b/i.test(text.trim())) {
    return await submitDraft(phone, customer);
  }

  if (/^(listo|eso es todo|nada más|nada mas)\b/i.test(text.trim())) {
    return await showDraftSummary(phone, customer);
  }

  const parseSystem = `Extraé productos y cantidades en cajas del mensaje. Respondé SOLO JSON:
[{"query": "nombre o código del producto", "cajas": número}]
Si no hay productos claros, respondé [].`;

  const parsed = await conversationalReply(apiKey, parseSystem, [
    { role: "user", content: text },
  ]);

  let items: { query: string; cajas: number }[];
  try {
    items = JSON.parse(parsed);
  } catch {
    return "No entendí los productos. Decime el nombre y la cantidad en cajas, ej: *12 cajas de cuchillo asado*";
  }

  if (!items.length) return "Dale, decime qué necesitás (producto y cantidad en cajas).";

  const added: string[] = [];
  const notFound: string[] = [];
  const currentItems = Array.isArray(draft.items) ? [...draft.items] : [];

  for (const item of items) {
    // Búsqueda inteligente: aliases → trigrama → ILIKE (sin gastar tokens)
    const { data: products } = await supabase
      .rpc("wa_product_match", { p_query: item.query, p_limit: 3 });

    if (!products?.length) { notFound.push(item.query); continue; }

    if (products.length > 1) {
      const opts = products.map((p, i) => `${i + 1}) ${p.description} (${p.cod})`).join("\n");
      notFound.push(`"${item.query}" — encontré varios:\n${opts}\n¿Cuál?`);
      continue;
    }

    const p = products[0];
    currentItems.push({
      product_id: p.product_id,
      cod: p.cod,
      description: p.description,
      cajas: item.cajas,
      uxb: p.uxb,
      unit_price: p.list_price,
    });
    added.push(`• ${item.cajas} cajas ${p.description} (×${p.uxb} u/caja) — $${(item.cajas * p.uxb * Number(p.list_price)).toLocaleString("es-AR")}`);
  }

  await supabase
    .from("wa_order_draft")
    .update({ items: currentItems, status: "building" })
    .eq("phone", phone)
    .in("status", ["building", "confirming"]);

  let reply = "";
  if (added.length) reply += `Agregué:\n${added.join("\n")}`;
  if (notFound.length) reply += `\n\n⚠️ ${notFound.join("\n")}`;
  reply += "\n\n¿Algo más? (o decí *listo*)";
  return reply;
}

async function showDraftSummary(phone: string, customer: { id: string }): Promise<string> {
  const { data: draft } = await supabase
    .from("wa_order_draft")
    .select("items")
    .eq("phone", phone)
    .eq("status", "building")
    .maybeSingle();

  if (!draft?.items?.length) return "No tenés productos en el pedido. Decime qué necesitás.";

  // deno-lint-ignore no-explicit-any
  const items = draft.items as any[];
  let subtotal = 0;
  const lines = items.map((it) => {
    const lineTotal = it.cajas * it.uxb * Number(it.unit_price);
    subtotal += lineTotal;
    return `• ${it.cajas} cajas ${it.description} — $${lineTotal.toLocaleString("es-AR")}`;
  });

  const dtoAmount = subtotal * 0.02;
  const total = subtotal - dtoAmount;

  await supabase
    .from("wa_order_draft")
    .update({ status: "confirming" })
    .eq("phone", phone)
    .eq("status", "building");

  return `Resumen de tu pedido:\n${lines.join("\n")}\n\nSubtotal: $${subtotal.toLocaleString("es-AR")}\nDto web 2%: -$${dtoAmount.toLocaleString("es-AR")}\nTotal: $${total.toLocaleString("es-AR")}\n\n¿Confirmo? (Sí/No)`;
}

async function submitDraft(
  phone: string,
  customer: { id: string; cod_cliente: number; business_name: string },
): Promise<string> {
  const { data: draft } = await supabase
    .from("wa_order_draft")
    .select("items")
    .eq("phone", phone)
    .eq("status", "confirming")
    .maybeSingle();

  if (!draft?.items?.length) return "No hay pedido para confirmar.";

  // deno-lint-ignore no-explicit-any
  const items = (draft.items as any[]).map((it) => ({
    product_id: it.product_id,
    cajas: it.cajas,
    uxb: it.uxb,
    is_loke: false,
  }));

  const { data: orderId, error } = await supabase.rpc("bot_submit_order", {
    p_telefono: phone,
    p_items: items,
    p_payment_method: "transferencia",
  });

  if (error) {
    console.error("submit error:", error);
    return "Hubo un error al confirmar. Intentá de nuevo o contactá a ventas.";
  }

  await supabase
    .from("wa_order_draft")
    .update({ status: "submitted" })
    .eq("phone", phone)
    .eq("status", "confirming");

  return `✅ Pedido NP-${orderId} confirmado. Te aviso cuando lo programemos.`;
}

async function handlePickup(customer: { id: string; business_name: string }): Promise<string> {
  const { data: tracking } = await supabase
    .from("order_tracking")
    .select("np_number, status, fecha_entrega")
    .eq("cod_cliente", customer.id)
    .eq("status", "programado")
    .order("fecha_entrega", { ascending: true })
    .limit(1);

  if (tracking?.length) {
    const t = tracking[0];
    return `Tu pedido NP-${t.np_number} está programado para ${t.fecha_entrega}.\nSi querés retirarlo antes, contactá a ventas para coordinar.`;
  }
  return "No tenés pedidos programados para entrega. Si querés hacer uno, decime.";
}

async function handleCancel(phone: string): Promise<string> {
  const { data: draft } = await supabase
    .from("wa_order_draft")
    .select("id")
    .eq("phone", phone)
    .in("status", ["building", "confirming"])
    .maybeSingle();

  if (draft) {
    await supabase
      .from("wa_order_draft")
      .update({ status: "expired" })
      .eq("id", draft.id);
    return "Pedido en borrador cancelado. Si necesitás algo más, decime.";
  }
  return "No tenés un pedido en curso para cancelar.";
}

// ── FAQ handler — respuestas automáticas sin gastar tokens ──

async function handleFaq(
  text: string,
  customer?: { id: string; cod_cliente: number; business_name: string } | null,
): Promise<{ reply: string; intent: string } | null> {
  const { data: matches, error } = await supabase
    .rpc("wa_faq_match", { p_text: text });

  if (error || !matches?.length) return null;

  const top = matches[0];

  // Score bajo → no es un match real, dejar que IA responda
  if (top.match_score < 0.3) return null;

  // ── Escalación: needs_human → derivar a vendedor ──
  if (top.automation_level === "needs_human") {
    const topic = top.fallback_label || top.subcategory || "tu consulta";
    return {
      reply: `📋 *${topic}* necesita atención de un vendedor. Te van a contactar a la brevedad.\n\nTambién podés escribirnos a ventas@loekemeyer.com`,
      intent: "escalation",
    };
  }

  // ── DB lookup: consultas que requieren datos reales (0 tokens) ──
  if (top.requires_db_lookup && customer) {
    const lookupReply = await handleFaqLookup(top.db_lookup_type, customer, text);
    if (lookupReply) return { reply: lookupReply, intent: top.db_lookup_type || "faq_lookup" };
    // Si lookup falla, caer a respuesta estática
  }

  // ── Usuario no vinculado: FAQs que requieren cliente → dejar que handleLinking se encargue ──
  if (!customer) {
    return null;
  }

  // ── full_auto / semi_auto → respuesta directa ──
  let reply = "";
  if (top.web_first_response) reply += top.web_first_response + "\n\n";
  if (top.bot_response) reply += top.bot_response;
  if (!reply.trim()) return null;

  return { reply: reply.trim(), intent: "faq" };
}

// ── FAQ DB Lookups — respuestas con datos reales, 0 tokens ──

const STATUS_MAP: Record<string, string> = {
  pendiente: "📝 recibido, en proceso de preparación",
  recibido: "📦 recibido, siendo preparado",
  programado: "🚚 programado para despacho",
  entregado: "✅ entregado",
};

async function handleFaqLookup(
  lookupType: string,
  customer: { id: string; cod_cliente: number; business_name: string },
  message: string,
): Promise<string | null> {
  switch (lookupType) {
    case "order_status":
      return await lookupOrderStatus(customer);
    case "customer_discount":
      return await lookupCustomerDiscount(customer);
    case "product_price":
      return await lookupProductPrice(customer, message);
    case "product_stock":
      return await lookupProductStock(customer, message);
    case "order_modify":
      return await lookupOrderModify(customer);
    default:
      return null;
  }
}

async function lookupOrderStatus(
  customer: { id: string; cod_cliente: number; business_name: string },
): Promise<string> {
  const { data: orders } = await supabase
    .from("orders")
    .select("id, created_at, total, status")
    .eq("customer_id", customer.id)
    .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(5);

  if (!orders?.length) {
    return `${customer.business_name}, no tenés pedidos recientes (últimos 90 días). Si querés hacer uno, decime.`;
  }

  const orderIds = orders.map((o) => String(o.id));
  const { data: tracking } = await supabase
    .from("order_tracking")
    .select("np_number, status, fecha_entrega")
    .in("np_number", orderIds);

  const trackingMap = new Map((tracking ?? []).map((t) => [t.np_number, t]));

  const lines = orders.map((o, i) => {
    const t = trackingMap.get(String(o.id));
    const fecha = new Date(o.created_at).toLocaleDateString("es-AR");
    const rawStatus = t?.status ?? o.status;
    const statusText = STATUS_MAP[rawStatus] || rawStatus;
    let line = `${i + 1}️⃣ NP-${o.id} (${fecha}) — ${statusText}`;
    if (t?.fecha_entrega && rawStatus === "programado") {
      line += ` para el ${t.fecha_entrega}`;
    }
    if (t?.fecha_entrega && rawStatus === "entregado") {
      line += ` el ${t.fecha_entrega}`;
    }
    return line;
  });

  return `${customer.business_name}, acá está el estado de tus pedidos:\n\n${lines.join("\n")}\n\n¿Necesitás más detalle de alguno?`;
}

async function lookupCustomerDiscount(
  customer: { id: string; cod_cliente: number; business_name: string },
): Promise<string | null> {
  const { data: row } = await supabase
    .from("customers")
    .select("discount")
    .eq("id", customer.id)
    .maybeSingle();

  const volumeDiscount = row?.discount ?? 0;

  return `${customer.business_name}, tus descuentos son:\n📦 *Por volumen*: ${volumeDiscount}%\n💻 *Por compra web*: 2% adicional\n💰 *Por pago*:\n  • Contado (0-14 días): 25%\n  • 30 días: 20%\n  • 60 días: 10%\n  • 90 días: 5%\n\nEstos se aplican sobre el precio base de la web. 💡`;
}

async function lookupProductPrice(
  customer: { id: string; cod_cliente: number; business_name: string },
  message: string,
): Promise<string | null> {
  // Usar wa_product_match para buscar el producto por descripción/código en el mensaje
  const { data: products } = await supabase
    .rpc("wa_product_match", { p_query: message, p_limit: 1 });

  if (!products?.length) {
    return `No encontré el artículo que mencionás. Decime el código o el nombre más completo.`;
  }

  const p = products[0];
  const basePrice = Number(p.list_price);
  const iva = basePrice * 0.21; // IVA 21%
  const withIva = basePrice + iva;

  // Descuentos aplicables
  const volumeDiscount = 0; // Obtener del customer si es posible
  const webDiscount = 0.02; // 2% por compra web
  const finalPrice = withIva * (1 - volumeDiscount - webDiscount);

  return `${customer.business_name}, el artículo *${p.description}* (${p.cod}):\n💰 Precio sin IVA: $${basePrice.toLocaleString("es-AR")}\n📊 IVA 21%: $${iva.toLocaleString("es-AR")}\n✅ Total con IVA: $${withIva.toLocaleString("es-AR")}\n\n🏷️ Tu precio con descuentos (volumen + web 2%): $${finalPrice.toLocaleString("es-AR")}\n\n*(Los descuentos por pago se aplican en el carrito)*`;
}

async function lookupProductStock(
  customer: { id: string; cod_cliente: number; business_name: string },
  message: string,
): Promise<string | null> {
  // Usar wa_product_match para buscar el producto
  const { data: products } = await supabase
    .rpc("wa_product_match", { p_query: message, p_limit: 1 });

  if (!products?.length) {
    return `No encontré el artículo que mencionás. Decime el código o el nombre más completo.`;
  }

  const p = products[0];
  const stock = p.stock ?? 0;

  if (stock <= 0) {
    return `El artículo *${p.description}* (${p.cod}) está sin stock en este momento. Podés ponerte en contacto con ventas para consultar por disponibilidad.`;
  }

  if (stock < 10) {
    return `El artículo *${p.description}* (${p.cod}) tiene *${stock} unidades* disponibles (stock limitado).\n\n¿Querés hacer un pedido?`;
  }

  return `El artículo *${p.description}* (${p.cod}) tiene *stock disponible* ✅\n\n¿Querés hacer un pedido?`;
}

async function lookupOrderModify(
  customer: { id: string; cod_cliente: number; business_name: string },
): Promise<string | null> {
  const { data: orders } = await supabase
    .from("orders")
    .select("id, status, created_at")
    .eq("customer_id", customer.id)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  if (!orders?.length) {
    return `No tenés pedidos recientes que modificar. ¿Quieres hacer uno nuevo?`;
  }

  const latest = orders[0];
  const canModify = ["pendiente", "recibido"].includes(latest.status || "");

  if (!canModify) {
    return `Tu último pedido (NP-${latest.id}) está en estado "${latest.status}" y no se puede modificar.\n\nDerivamos tu solicitud a un vendedor para que evalúe opciones.`;
  }

  return `Tu pedido NP-${latest.id} aún puede modificarse. ¿Qué cambios necesitás?\n📝 Indicame:\n• Artículos que quieres agregar/quitar\n• Cantidades\n\nUn vendedor va a confirmar los cambios.`;
}

async function handleGeneral(
  customer: { id: string; business_name: string },
  text: string,
  apiKey: string,
): Promise<string> {
  const system = `Sos el asistente virtual de Loekemeyer Hnos, una empresa mayorista de artículos de cocina y bazar.
Estás hablando con ${customer.business_name} por WhatsApp.
Respondé de forma breve, amable y profesional. Si no sabés algo, sugirí contactar a ventas.
No inventes información sobre pedidos ni precios.`;

  return conversationalReply(apiKey, system, [
    { role: "user", content: text },
  ]);
}
