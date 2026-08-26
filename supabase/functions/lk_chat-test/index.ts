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

    // ── Chat endpoint ──
    const { phone, text } = body;
    if (!phone || !text) {
      return json({ error: "phone y text requeridos" }, 400);
    }

    const testPhone = canonPhone(phone);
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")
      ?? Deno.env.get("CLAUDE_API_KEY")
      ?? (await getSetting("anthropic_api_key"))
      ?? "";

    if (!anthropicKey) {
      return json({ reply: "⚠️ API Key de Claude no configurada. Configurala en Supabase secrets como ANTHROPIC_API_KEY o CLAUDE_API_KEY." });
    }

    // Buscar cliente vinculado
    const { data: cliente } = await supabase
      .rpc("bot_cliente_por_whatsapp", { p_telefono: testPhone });
    const customerRow = cliente?.[0] ?? null;

    let reply: string;

    if (!customerRow) {
      reply = await handleLinking(testPhone, text, anthropicKey);
    } else {
      const { intent } = await detectIntent(anthropicKey, text);

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

async function handleLinking(phone: string, text: string, apiKey: string): Promise<string> {
  const cleaned = text.replace(/[^0-9]/g, "");
  if (!cleaned) {
    return "¡Hola! Soy el asistente de Loekemeyer. Para poder ayudarte, necesito identificarte. ¿Me pasás tu código de cliente o tu CUIT?";
  }

  let query = supabase
    .from("customers")
    .select("id, cod_cliente, business_name")
    .eq("cod_cliente", parseInt(cleaned))
    .maybeSingle();
  let { data: customer } = await query;

  if (!customer && cleaned.length >= 10) {
    const res = await supabase
      .from("customers")
      .select("id, cod_cliente, business_name")
      .eq("cuit", cleaned)
      .maybeSingle();
    customer = res.data;
  }

  if (!customer) {
    return "No encontré ese código o CUIT. Verificá e intentá de nuevo, o contactanos a ventas@loekemeyer.com";
  }

  // En modo test, vincular temporalmente
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
    const { data: products } = await supabase
      .from("products")
      .select("id, cod, description, list_price, uxb")
      .eq("active", true)
      .or(`description.ilike.%${item.query}%,cod.ilike.%${item.query}%`)
      .limit(3);

    if (!products?.length) { notFound.push(item.query); continue; }

    if (products.length > 1) {
      const opts = products.map((p, i) => `${i + 1}) ${p.description} (${p.cod})`).join("\n");
      notFound.push(`"${item.query}" — encontré varios:\n${opts}\n¿Cuál?`);
      continue;
    }

    const p = products[0];
    currentItems.push({
      product_id: p.id,
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
