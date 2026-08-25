// Meta Cloud API v21.0 — WhatsApp Business
// Patrón basado en Planify (waPost / sendText / canonPhone / phoneVariants)

const GRAPH_URL = "https://graph.facebook.com/v21.0";

/** POST genérico a la Graph API */
async function waPost(
  phoneId: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(`${GRAPH_URL}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error("WA API error:", JSON.stringify(data));
  }
  return data;
}

/** Envía un mensaje de texto */
export function sendText(
  phoneId: string,
  token: string,
  to: string,
  body: string,
): Promise<unknown> {
  return waPost(phoneId, token, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: body.slice(0, 4000) },
  });
}

/** Marca un mensaje como leído */
export function markRead(
  phoneId: string,
  token: string,
  messageId: string,
): Promise<unknown> {
  return waPost(phoneId, token, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
}

/** Envía un template aprobado por Meta */
export function sendTemplate(
  phoneId: string,
  token: string,
  to: string,
  templateName: string,
  lang: string,
  params: string[],
): Promise<unknown> {
  return waPost(phoneId, token, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: params.length
        ? [
            {
              type: "body",
              parameters: params.map((p) => ({ type: "text", text: p })),
            },
          ]
        : [],
    },
  });
}

// ─── Normalización de teléfonos ─────────────────────────────────────

/** Deja solo dígitos */
export function canonPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Genera variantes de formato para un número argentino.
 * Meta manda el "from" como 5491131181594 (sin +).
 * En customers.whatsapp hay de todo: 5491131181594, 1131181594, 31181594, etc.
 * Probamos todas las variantes posibles al buscar.
 */
export function phoneVariants(raw: string): string[] {
  const d = canonPhone(raw);
  const v = new Set<string>();
  v.add(d);

  if (d.startsWith("549") && d.length >= 12) {
    // 5491131181594 → 1131181594 (sin país ni 9)
    v.add(d.slice(3));
    // 5491131181594 → 91131181594 (sin 54)
    v.add(d.slice(2));
    // 5491131181594 → 541131181594 (sin 9 móvil)
    v.add("54" + d.slice(3));
  } else if (d.startsWith("54") && d.length >= 11) {
    // 541131181594 → 1131181594
    v.add(d.slice(2));
    // Agregar variante con 9 móvil
    v.add("549" + d.slice(2));
  } else if (d.length >= 8 && d.length <= 11) {
    // Número local → agregar prefijos
    v.add("54" + d);
    v.add("549" + d);
    // Si empieza con 9, probar sin ella
    if (d.startsWith("9")) {
      v.add(d.slice(1));
      v.add("54" + d.slice(1));
    }
  }

  return [...v];
}

// ─── Extracción de datos del webhook ────────────────────────────────

interface WaMessage {
  from: string;       // teléfono del remitente (formato internacional sin +)
  msgId: string;      // ID del mensaje de Meta (para dedup)
  text: string;       // texto del mensaje
  type: string;       // text, image, audio, document, etc.
  name?: string;      // nombre del contacto en WA
  timestamp: string;  // Unix timestamp
}

/**
 * Extrae el primer mensaje de texto del payload del webhook de Meta.
 * Retorna null si no hay mensaje procesable.
 */
export function extractMessage(body: Record<string, unknown>): WaMessage | null {
  try {
    // deno-lint-ignore no-explicit-any
    const entry = (body as any)?.entry?.[0];
    const change = entry?.changes?.[0];
    if (change?.field !== "messages") return null;

    const value = change.value;
    const msg = value?.messages?.[0];
    if (!msg) return null;

    const contact = value?.contacts?.[0];

    return {
      from: msg.from,
      msgId: msg.id,
      text: msg.text?.body ?? "",
      type: msg.type ?? "text",
      name: contact?.profile?.name,
      timestamp: msg.timestamp,
    };
  } catch {
    return null;
  }
}
