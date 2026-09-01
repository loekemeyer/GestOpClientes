import { supabase } from "./supabase.ts";
import { llmCall } from "./llm.ts";

// Aliases sin fecha (hints para detectIntent / conversationalReply). Cuando la
// chain de wa_agente_modelos está poblada, `llmCall` la usa y estos hints
// quedan solo como fallback duro (env ANTHROPIC_API_KEY).
const MODEL_HAIKU = "claude-haiku-4-5";
const MODEL_SONNET = "claude-sonnet-4-6";

/**
 * Llama a un LLM. Backward-compatible: recibe apiKey + model y los usa como
 * pin (sin chain). El resto del flujo (timeout, log de tokens) va por
 * `llmCall`. Los nuevos consumidores deberían llamar a `llmCall` directamente.
 */
export async function claudeMessage(opts: {
  apiKey: string;
  model: string;
  system?: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const res = await llmCall({
    system: opts.system,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    pinned: { provider: "anthropic", model: opts.model, apiKey: opts.apiKey },
  });
  return res.text;
}

/** Detecta intent (modelo barato). Devuelve JSON parseado. */
export async function detectIntent(
  apiKey: string,
  userMessage: string,
): Promise<{ intent: string; details: string }> {
  const system = `Sos un clasificador de intents para un bot WhatsApp de una empresa mayorista de artículos de cocina.
Dado el mensaje del cliente, respondé SOLO con JSON válido:
{"intent": "consulta_pedido" | "nuevo_pedido" | "retiro" | "cancelar" | "consulta_factura" | "ayuda" | "opt_out" | "faq" | "otro", "details": "breve contexto"}

Reglas:
- "consulta_pedido": pregunta por estado, seguimiento, envío de un pedido
- "nuevo_pedido": quiere hacer un pedido, pedir productos, agregar items
- "retiro": pregunta si puede pasar a retirar
- "consulta_factura": pide una factura, comprobante, nota de crédito, nota de débito, remito, o cualquier documento fiscal. Ej: "mandame la factura", "necesito la factura", "factura numero X", "nota de credito"
- "cancelar": quiere cancelar pedido en curso
- "ayuda": pide ayuda o menú de opciones
- "opt_out": no quiere recibir más mensajes
- "faq": preguntas generales sobre la empresa (horarios, formas de pago, envíos, mínimos, devoluciones, catálogo, precios, descuentos, zonas de entrega)
- "otro": cualquier otra cosa que no encaje arriba`;

  // Consumimos la chain (wa_agente_modelos). Si está vacía o falla todo,
  // `llmCall` cae al env ANTHROPIC_API_KEY con Sonnet como último recurso.
  // El parámetro `apiKey` queda por retrocompatibilidad: si no hay chain ni
  // env, lo usamos como pin final con Haiku.
  try {
    const res = await llmCall({
      system,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 150,
      temperature: 0,
    });
    try {
      return JSON.parse(res.text);
    } catch {
      return { intent: "otro", details: res.text };
    }
  } catch (_e) {
    if (!apiKey) throw _e;
    const text = await claudeMessage({
      apiKey,
      model: MODEL_HAIKU,
      system,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 150,
      temperature: 0,
    });
    try {
      return JSON.parse(text);
    } catch {
      return { intent: "otro", details: text };
    }
  }
}

/** Respuesta conversacional. Consume la chain; cae a Sonnet si no hay. */
export async function conversationalReply(
  apiKey: string,
  system: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  try {
    const res = await llmCall({
      system,
      messages,
      maxTokens: 800,
      temperature: 0.3,
    });
    return res.text;
  } catch (_e) {
    if (!apiKey) throw _e;
    return claudeMessage({
      apiKey,
      model: MODEL_SONNET,
      system,
      messages,
      maxTokens: 800,
      temperature: 0.3,
    });
  }
}

/** Busca FAQ por keywords. Devuelve respuesta o null si no hay match. */
export async function matchFAQ(userMessage: string): Promise<{ id: number; response: string } | null> {
  // Keywords por FAQ - basado en análisis de 1,739 consultas reales
  const faqKeywords: Record<number, string[]> = {
    11: ["precio", "precios", "lista", "cotizador", "cotización", "me pasas", "me pasan"],
    15: ["pago", "pagar", "transferencia", "cheque", "cbu", "datos", "banco", "credicoop", "alias"],
    19: ["catalogo", "catálogo", "producto", "novedades", "fotos"],
    20: ["comprobante", "factura", "recibo", "donde", "dónde", "enviar"],
    21: ["minimo", "mínimo", "compra", "monto"],
  };

  const lowerMsg = userMessage.toLowerCase();

  // Buscar el FAQ con más coincidencias de keywords
  let bestMatch: { faq_id: number; score: number } | null = null;

  for (const [faqId, keywords] of Object.entries(faqKeywords)) {
    const score = keywords.filter(kw => lowerMsg.includes(kw)).length;
    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { faq_id: parseInt(faqId), score };
    }
  }

  if (!bestMatch) return null;

  // Obtener respuesta de la FAQ desde Supabase
  const { data } = await supabase
    .from("wa_faq")
    .select("bot_response")
    .eq("id", bestMatch.faq_id)
    .eq("is_active", true)
    .eq("automation_level", "full_auto")
    .maybeSingle();

  if (data?.bot_response) {
    return {
      id: bestMatch.faq_id,
      response: data.bot_response,
    };
  }

  return null;
}
