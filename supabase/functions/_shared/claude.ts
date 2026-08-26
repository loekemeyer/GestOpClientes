const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** Llama a Claude API directo (sin SDK). */
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
  return data.content?.[0]?.text ?? "";
}

/** Detecta intent con Haiku. Devuelve JSON parseado. */
export async function detectIntent(
  apiKey: string,
  userMessage: string,
): Promise<{ intent: string; details: string }> {
  const system = `Sos un clasificador de intents para un bot WhatsApp de una empresa mayorista de artículos de cocina.
Dado el mensaje del cliente, respondé SOLO con JSON válido:
{"intent": "consulta_pedido" | "nuevo_pedido" | "retiro" | "cancelar" | "ayuda" | "opt_out" | "otro", "details": "breve contexto"}

Reglas:
- "consulta_pedido": pregunta por estado, seguimiento, envío de un pedido
- "nuevo_pedido": quiere hacer un pedido, pedir productos, agregar items
- "retiro": pregunta si puede pasar a retirar
- "cancelar": quiere cancelar pedido en curso
- "ayuda": pide ayuda o menú de opciones
- "opt_out": no quiere recibir más mensajes
- "otro": cualquier otra cosa`;

  const text = await claudeMessage({
    apiKey,
    model: "claude-haiku-4-5-20241022",
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
    model: "claude-sonnet-4-6-20250514",
    system,
    messages,
    maxTokens: 800,
    temperature: 0.3,
  });
}
