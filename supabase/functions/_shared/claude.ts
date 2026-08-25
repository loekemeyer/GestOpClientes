// Claude API — HTTP directo, sin SDK (Deno-friendly)

const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface ClaudeOpts {
  model?: string;
  maxTokens?: number;
  system?: string;
  temperature?: number;
}

/**
 * Llama a la API de Claude y devuelve el texto de respuesta.
 * Default: haiku para intent detection (rápido y barato).
 */
export async function askClaude(
  messages: ClaudeMessage[],
  apiKey: string,
  opts: ClaudeOpts = {},
): Promise<string> {
  const resp = await fetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-haiku-4-5-20251001",
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      temperature: opts.temperature ?? 0,
      messages,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`Claude API ${resp.status}: ${errText}`);
    throw new Error(`Claude API error ${resp.status}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text ?? "";
}

// ─── Intent detection ───────────────────────────────────────────────

const INTENT_SYSTEM = `Sos un clasificador de intents para un bot WhatsApp de Loekemeyer (fábrica de cubiertos/cuchillería mayorista).
El cliente escribe un mensaje y vos devolvés UN JSON con el intent detectado.

Intents posibles:
- "consulta_pedido": pregunta por estado de pedido, seguimiento, entrega, cuándo llega
- "nuevo_pedido": quiere hacer un pedido, comprar, pedir productos
- "consulta_producto": pregunta por un producto, precio, disponibilidad, catálogo
- "saludo": saludo inicial (hola, buen día, etc.)
- "ayuda": pide ayuda o menú de opciones
- "otro": cualquier otra cosa

Respondé SOLO con JSON, sin explicación:
{"intent":"<intent>","detail":"<resumen breve de lo que pide>"}`;

export interface IntentResult {
  intent: string;
  detail: string;
}

/** Detecta el intent del mensaje con Claude Haiku */
export async function detectIntent(
  text: string,
  apiKey: string,
): Promise<IntentResult> {
  const raw = await askClaude(
    [{ role: "user", content: text }],
    apiKey,
    { system: INTENT_SYSTEM, temperature: 0, maxTokens: 128 },
  );

  try {
    return JSON.parse(raw);
  } catch {
    return { intent: "otro", detail: raw };
  }
}

// ─── Respuesta conversacional ───────────────────────────────────────

const CONVERSATIONAL_SYSTEM = `Sos el asistente WhatsApp de Loekemeyer Hnos S.R.L., fábrica de cubiertos y artículos de cuchillería.
Atendés a clientes mayoristas. Sos amable, conciso y profesional.

Información del negocio:
- Venta exclusivamente mayorista (no minorista)
- Pedido mínimo: $500.000
- Retiro mínimo en fábrica: $300.000
- Descuento por pago web: 2%
- Contacto ventas: ventas@loekemeyer.com / WhatsApp 1131181021
- Cobranzas: +54 11 6557-4113

Reglas:
- Respondé siempre en español argentino
- Sé breve (máximo 3-4 párrafos)
- Si no sabés algo, derivá a ventas
- Nunca inventes información de productos o precios
- Usá emojis con moderación`;

export async function conversationalReply(
  text: string,
  customerName: string,
  apiKey: string,
): Promise<string> {
  return askClaude(
    [{ role: "user", content: text }],
    apiKey,
    {
      model: "claude-sonnet-4-6-20250514",
      system: CONVERSATIONAL_SYSTEM +
        `\n\nEstás hablando con: ${customerName}`,
      maxTokens: 512,
      temperature: 0.3,
    },
  );
}
