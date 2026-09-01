import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { supabase, getSetting } from "../_shared/supabase.ts";
import { canonPhone } from "../_shared/wa-api.ts";
import { runConversation } from "../_shared/bot-conversation.ts";
import { handleFaq } from "../_shared/faq.ts";

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
    let customerRow: { id: string; cod_cliente: number; business_name: string; dto_vol: number } | null = null;

    const { data: identified } = await supabase
      .rpc("wa_identify_customer", { p_phone: phone });
    const iRow = identified?.[0];
    if (iRow) {
      // wa_identify_customer no devuelve dto_vol; lo consultamos aparte para
      // pasarle el mismo contexto que el webhook real a `runConversation`.
      const { data: c } = await supabase
        .from("customers")
        .select("dto_vol")
        .eq("id", iRow.customer_id)
        .maybeSingle();
      customerRow = {
        id: iRow.customer_id,
        cod_cliente: Number(iRow.cod_cliente),
        business_name: iRow.customer_name,
        dto_vol: Number(c?.dto_vol ?? 0),
      };
    } else {
      const { data: legacy } = await supabase
        .rpc("bot_cliente_por_whatsapp", { p_telefono: testPhone });
      const l = legacy?.[0] ?? null;
      customerRow = l ? {
        id: l.id ?? l.customer_id,
        cod_cliente: Number(l.cod_cliente),
        business_name: l.business_name,
        dto_vol: Number(l.dto_vol ?? 0),
      } : null;
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

    let convAlert: { kind: "timeout" | "llm_error"; text: string } | null = null;
    if (!customerRow) {
      detectedIntent = "linking";
      reply = await handleLinking(testPhone, text, anthropicKey);
    } else {
      // Unificado con el webhook real: usa el mismo runConversation
      // (tool-use loop) que atiende WhatsApp en producción. Esto elimina la
      // divergencia de flujo entre test y prod. Las media (fotos, PDFs) se
      // adjuntan como links al final del reply para simular el envío.
      detectedIntent = "bot";
      const conv = await runConversation(
        text,
        testPhone,
        customerRow.business_name,
        customerRow.cod_cliente,
        customerRow.dto_vol,
        anthropicKey,
      );
      // Timeout / error del LLM → en producción NO se envía nada al
      // cliente (se avisa a un humano). Acá levantamos una alerta visible
      // en el chat de test para que el operador entienda qué habría
      // pasado en prod.
      if (conv.timeout || conv.llmError) {
        convAlert = {
          kind: conv.timeout ? "timeout" : "llm_error",
          text: conv.reply,
        };
        detectedIntent = conv.timeout ? "llm_timeout" : "llm_error";
        reply = conv.reply;
      } else {
        reply = conv.reply;
        if (conv.media.length) {
          const mediaLines = conv.media.map((m) => {
            const label = m.caption ?? m.filename ?? m.type;
            return `📎 ${label}\n${m.url}`;
          });
          reply = reply + "\n\n" + mediaLines.join("\n\n");
        }
      }
    }

    // Log conversación (fire and forget, no bloquea respuesta)
    const customerId = customerRow?.id ?? null;
    supabase.from("wa_conversations").insert([
      { phone, direction: "in",  body: text,  msg_type: "text", customer_id: customerId, intent: detectedIntent },
      { phone, direction: "out", body: reply, msg_type: "text", customer_id: customerId, intent: detectedIntent },
    ]).then(() => {}).catch((e: unknown) => console.error("conv log err:", e));

    return json({
      reply,
      customer: customerRow?.business_name ?? null,
      // La UI del dashboard puede mostrar un banner de alerta cuando el
      // bot habría timeouteado en prod (no se envía nada al cliente real).
      ...(convAlert ? { alert: convAlert } : {}),
    });
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
    .select("model, input_tokens, output_tokens, estimated_cost_usd, created_at")
    .gte("created_at", monthStart);

  // Cargamos el flag is_free_tier por modelo para renderizar el badge en
  // el dashboard aunque no haya llamadas registradas todavía.
  const { data: modelsCfg } = await supabase
    .from("wa_agente_modelos")
    .select("model_id, proveedor, is_free_tier");
  // deno-lint-ignore no-explicit-any
  const freeMap = new Map<string, boolean>((modelsCfg ?? []).map((m: any) => [m.model_id, !!m.is_free_tier]));
  // deno-lint-ignore no-explicit-any
  const providerMap = new Map<string, string>((modelsCfg ?? []).map((m: any) => [m.model_id, m.proveedor]));

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

  // deno-lint-ignore no-explicit-any
  const aggregateByModel = (rows: any[] | null) => {
    if (!rows?.length) return [];
    // deno-lint-ignore no-explicit-any
    const byModel: Record<string, any[]> = {};
    for (const r of rows) {
      const m = r.model ?? "desconocido";
      (byModel[m] ||= []).push(r);
    }
    return Object.entries(byModel)
      .map(([model, rs]) => ({
        model,
        provider: providerMap.get(model) ?? null,
        is_free_tier: freeMap.get(model) ?? false,
        ...aggregate(rs),
      }))
      .sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  };

  const allMonth = monthRows ?? [];
  const weekRows = allMonth.filter(r => r.created_at >= weekStart);
  const sessionRows = since ? allMonth.filter(r => r.created_at >= since) : null;

  return json({
    month: aggregate(allMonth),
    week: aggregate(weekRows),
    session: sessionRows ? aggregate(sessionRows) : { cost: 0, input_tokens: 0, output_tokens: 0, calls: 0 },
    by_model: {
      month:   aggregateByModel(allMonth),
      week:    aggregateByModel(weekRows),
      session: sessionRows ? aggregateByModel(sessionRows) : [],
    },
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

