// _shared/faq.ts — Pre-check de FAQs (respuestas AUTO/SEMIAUTO/HUMANO)
// que corre antes de tocar el LLM. Consume la tabla `wa_faq` vía la RPC
// `wa_faq_match` y elige entre `bot_response` (cliente identificado) e
// `institutional_response` (sin cliente, tono institucional).
//
// El agente conversacional (`runConversation`) queda como último recurso:
// solo se invoca si acá no hay match útil.

import { supabase } from "./supabase.ts";

// deno-lint-ignore no-explicit-any
export type Customer = { id: string; cod_cliente: number; business_name: string; dto_vol?: number } | null | undefined;

export interface FaqResult {
  reply: string;
  intent: string;
  automation_level: "full_auto" | "semi_auto" | "needs_human" | "inteligencia" | string;
  faq_id?: number;
}

const STATUS_MAP: Record<string, string> = {
  pendiente: "📝 recibido, en proceso de preparación",
  recibido:  "📦 recibido, siendo preparado",
  programado:"🚚 programado para despacho",
  entregado: "✅ entregado",
};

/**
 * Reemplaza tokens {{token}} de una plantilla de wa_faq con datos reales.
 * Estándar: {{snake_case}} (ver sql/051_wa_faq_editable_templates.sql y la
 * tabla wa_faq_lookup_tokens). Un token sin valor se reemplaza por "".
 * El front edita el texto alrededor de los tokens; el backend completa los datos.
 */
export function renderTemplate(
  tpl: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return String(tpl).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * Corre el pre-check de FAQ. Devuelve null si:
 *   - no hay match (score bajo o vacío)
 *   - la FAQ requiere cliente identificado y no hay uno → deja pasar al
 *     flujo de identificación / al agente
 *   - la respuesta compuesta queda vacía
 */
export async function handleFaq(text: string, customer: Customer): Promise<FaqResult | null> {
  const { data: matches, error } = await supabase.rpc("wa_faq_match", { p_text: text });
  if (error || !matches?.length) return null;

  const top = matches[0];
  // Score bajo → no es un match real, dejar que la IA responda
  if (top.match_score < 0.3) return null;

  // Escalación humana: preestablecida en la FAQ (categoría HUMANO)
  if (top.automation_level === "needs_human") {
    const topic = top.subcategory || "tu consulta";
    // Plantilla editable desde el front (wa_faq.bot_response). Si está vacía,
    // se usa el mensaje genérico de escalación.
    const tpl = String(top.bot_response ?? "").trim();
    const reply = tpl
      ? renderTemplate(tpl, { nombre_cliente: customer?.business_name, tema: topic, topic })
      : `📋 *${topic}* necesita atención de un vendedor. Te van a contactar a la brevedad.\n\nTambién podés escribirnos a ventas@loekemeyer.com`;
    // Punto de cableado (a futuro): acá iría `notificarHumano({ tipo: "escalation", ... })`
    // de _shared/alertas.ts para avisar al vendedor. Se deja SIN conectar a propósito.
    return {
      reply,
      intent: "escalation",
      automation_level: "needs_human",
      faq_id: top.faq_id,
    };
  }

  // SEMIAUTO con lookup a Supabase (0 tokens). Requiere cliente.
  if (top.requires_db_lookup && customer) {
    const lookupReply = await handleFaqLookup(top.db_lookup_type, customer, text, top);
    if (lookupReply) {
      return {
        reply: lookupReply,
        intent: top.db_lookup_type || "faq_lookup",
        automation_level: "semi_auto",
        faq_id: top.faq_id,
      };
    }
    // Si el lookup no aplica, caemos a respuesta estática de más abajo
  }

  // ── Elección cliente / no-cliente ──────────────────────────────────────
  // Cliente identificado    → prioriza bot_response (personalizado)
  // Sin cliente             → prioriza institutional_response (institucional)
  // En ambos casos, fallback al otro campo si el preferido está vacío.
  const isCliente = !!customer;
  const primary = isCliente
    ? (top.bot_response ?? top.institutional_response)
    : (top.institutional_response ?? top.bot_response);
  if (!primary || !String(primary).trim()) return null;

  // web_first_response se antepone solo si el cliente está identificado
  // (para no-clientes carece de sentido — no pueden entrar a la web logueados).
  let reply = "";
  if (isCliente && top.web_first_response) reply += top.web_first_response + "\n\n";
  reply += primary;

  // Resolver cualquier token {{...}} de la plantilla en la rama estática.
  // Acá no hay lookup: los tokens sin dato disponible se quitan (→ "") para no
  // filtrar {{fecha}} literal a un cliente. {{nombre_cliente}} sí se completa.
  reply = renderTemplate(reply, { nombre_cliente: customer?.business_name });

  return {
    reply: reply.trim(),
    intent: "faq",
    automation_level: top.automation_level,
    faq_id: top.faq_id,
  };
}

// ── SEMIAUTO handlers (0 tokens, con datos reales de Supabase) ──────────
async function handleFaqLookup(
  lookupType: string,
  customer: NonNullable<Customer>,
  message: string,
  // deno-lint-ignore no-explicit-any
  faq?: any,
): Promise<string | null> {
  switch (lookupType) {
    case "order_status":       return lookupOrderStatus(customer);
    case "customer_discount":  return lookupCustomerDiscount(customer, faq);
    case "product_price":      return lookupProductPrice(customer, message);
    case "product_stock":      return lookupProductStock(customer, message);
    case "order_modify":       return lookupOrderModify(customer);
    default:                   return null;
  }
}

async function lookupOrderStatus(customer: NonNullable<Customer>): Promise<string> {
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
    if (t?.fecha_entrega && rawStatus === "programado") line += ` para el ${t.fecha_entrega}`;
    if (t?.fecha_entrega && rawStatus === "entregado")  line += ` el ${t.fecha_entrega}`;
    return line;
  });
  return `${customer.business_name}, acá está el estado de tus pedidos:\n\n${lines.join("\n")}\n\n¿Necesitás más detalle de alguno?`;
}

// deno-lint-ignore no-explicit-any
async function lookupCustomerDiscount(customer: NonNullable<Customer>, faq?: any): Promise<string | null> {
  const { data: row } = await supabase
    .from("customers").select("discount").eq("id", customer.id).maybeSingle();
  const volumeDiscount = row?.discount ?? 0;
  // Plantilla editable desde el front: si trae el token {{descuento_volumen}}
  // se renderiza con los datos reales; si no, se usa el texto por defecto.
  const tpl = String(faq?.bot_response ?? "").trim();
  if (tpl.includes("{{descuento_volumen}}")) {
    return renderTemplate(tpl, {
      nombre_cliente: customer.business_name,
      descuento_volumen: volumeDiscount,
    });
  }
  return `${customer.business_name}, tus descuentos son:\n📦 *Por volumen*: ${volumeDiscount}%\n💻 *Por compra web*: 2% adicional\n💰 *Por pago*:\n  • Contado (0-14 días): 25%\n  • 30 días: 20%\n  • 60 días: 10%\n  • 90 días: 5%\n\nEstos se aplican sobre el precio base de la web. 💡`;
}

async function lookupProductPrice(customer: NonNullable<Customer>, message: string): Promise<string | null> {
  const { data: products } = await supabase.rpc("wa_product_match", { p_query: message, p_limit: 1 });
  if (!products?.length) return `No encontré el artículo que mencionás. Decime el código o el nombre más completo.`;
  const p = products[0];
  const basePrice = Number(p.list_price);
  const iva = basePrice * 0.21;
  const withIva = basePrice + iva;
  const webDiscount = 0.02;
  const finalPrice = withIva * (1 - webDiscount);
  return `${customer.business_name}, el artículo *${p.description}* (${p.cod}):\n💰 Precio sin IVA: $${basePrice.toLocaleString("es-AR")}\n📊 IVA 21%: $${iva.toLocaleString("es-AR")}\n✅ Total con IVA: $${withIva.toLocaleString("es-AR")}\n\n🏷️ Tu precio con descuento web (2%): $${finalPrice.toLocaleString("es-AR")}\n\n*(Los descuentos por pago se aplican en el carrito)*`;
}

async function lookupProductStock(_customer: NonNullable<Customer>, message: string): Promise<string | null> {
  const { data: products } = await supabase.rpc("wa_product_match", { p_query: message, p_limit: 1 });
  if (!products?.length) return `No encontré el artículo que mencionás. Decime el código o el nombre más completo.`;
  const p = products[0];
  const stock = p.stock ?? 0;
  if (stock <= 0)  return `El artículo *${p.description}* (${p.cod}) está sin stock en este momento. Podés ponerte en contacto con ventas para consultar por disponibilidad.`;
  if (stock < 10) return `El artículo *${p.description}* (${p.cod}) tiene *${stock} unidades* disponibles (stock limitado).\n\n¿Querés hacer un pedido?`;
  return `El artículo *${p.description}* (${p.cod}) tiene *stock disponible* ✅\n\n¿Querés hacer un pedido?`;
}

async function lookupOrderModify(customer: NonNullable<Customer>): Promise<string | null> {
  const { data: orders } = await supabase
    .from("orders")
    .select("id, status, created_at")
    .eq("customer_id", customer.id)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  if (!orders?.length) return `No tenés pedidos recientes que modificar. ¿Quieres hacer uno nuevo?`;
  const latest = orders[0];
  const canModify = ["pendiente", "recibido"].includes(latest.status || "");
  if (!canModify) return `Tu último pedido (NP-${latest.id}) está en estado "${latest.status}" y no se puede modificar.\n\nDerivamos tu solicitud a un vendedor para que evalúe opciones.`;
  return `Tu pedido NP-${latest.id} aún puede modificarse. ¿Qué cambios necesitás?\n📝 Indicame:\n• Artículos que quieres agregar/quitar\n• Cantidades\n\nUn vendedor va a confirmar los cambios.`;
}
