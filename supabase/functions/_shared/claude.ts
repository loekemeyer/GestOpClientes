import { supabase } from "./supabase.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Usar aliases sin fecha para no romperse cuando Anthropic depreca versiones
const MODEL_HAIKU = "claude-haiku-4-5";
const MODEL_SONNET = "claude-sonnet-4-6";

const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  [MODEL_HAIKU]: { input: 1.0, output: 5.0 },
  [MODEL_SONNET]: { input: 3.0, output: 15.0 },
};

/** Llama a Claude API directo (sin SDK). Loguea tokens a bot_token_usage. */
export async function claudeMessage(opts: {
  apiKey: string;
  model: string;
  system?: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0,
      system: opts.system,
      messages: opts.messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }

  const data = await res.json();

  // Log token usage (fire and forget)
  const usage = data.usage;
  if (usage) {
    const rates = COST_PER_MTOK[opts.model] ?? { input: 3, output: 15 };
    const cost = (usage.input_tokens * rates.input + usage.output_tokens * rates.output) / 1_000_000;
    supabase.from("bot_token_usage").insert({
      model: opts.model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      estimated_cost_usd: cost,
    }).then(() => {}).catch((e: unknown) => console.error("token log err:", e));
  }

  return data.content?.[0]?.text ?? "";
}

/** Detecta intent con Haiku. Devuelve JSON parseado. */
export async function detectIntent(
  apiKey: string,
  userMessage: string,
): Promise<{ intent: string; details: string }> {
  const system = `Sos un clasificador de intents para un bot WhatsApp de una empresa mayorista de artículos de cocina.
Dado el mensaje del cliente, respondé SOLO con JSON válido:
{"intent": "consulta_pedido" | "nuevo_pedido" | "retiro" | "cancelar" | "ayuda" | "opt_out" | "faq" | "otro", "details": "breve contexto"}

Reglas:
- "consulta_pedido": pregunta por estado, seguimiento, envío de un pedido
- "nuevo_pedido": quiere hacer un pedido, pedir productos, agregar items
- "retiro": pregunta si puede pasar a retirar
- "cancelar": quiere cancelar pedido en curso
- "ayuda": pide ayuda o menú de opciones
- "opt_out": no quiere recibir más mensajes
- "faq": preguntas generales sobre la empresa (horarios, formas de pago, envíos, mínimos, devoluciones, catálogo, precios, descuentos, zonas de entrega)
- "otro": cualquier otra cosa que no encaje arriba`;

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

/** Respuesta conversacional con Sonnet. */
export async function conversationalReply(
  apiKey: string,
  system: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  return claudeMessage({
    apiKey,
    model: MODEL_SONNET,
    system,
    messages,
    maxTokens: 800,
    temperature: 0.3,
  });
}
