const META_API = "https://graph.facebook.com/v21.0";

/** Normaliza teléfono argentino a formato canónico (sin +, con 54). */
export function canonPhone(raw: string): string {
  let cleaned = raw.replace(/[^0-9]/g, "");
  if (cleaned.startsWith("54")) {
    cleaned = cleaned.slice(2);
  }
  if (cleaned.startsWith("9")) cleaned = cleaned.slice(1);
  if (cleaned.startsWith("0")) cleaned = cleaned.slice(1);
  // Quitar 15 intercalado (ej: 11 15 xxxx → 11 xxxx)
  if (cleaned.length > 10 && /^\d{2,4}15/.test(cleaned)) {
    cleaned = cleaned.replace(/^(\d{2,4})15/, "$1");
  }
  return "54" + cleaned;
}

/**
 * Error de la API de Meta. Lleva el status HTTP y el `code` de Meta (por ejemplo 132001 =
 * plantilla inexistente o no aprobada en ese idioma), que es lo que hace falta para saber si
 * conviene reintentar o si hay que ir a arreglar algo en el Business Manager.
 */
export class WaApiError extends Error {
  status: number;
  code: number | null;
  constructor(message: string, status: number, code: number | null) {
    super(message);
    this.name = "WaApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * POST genérico a Meta API.
 *
 * v2 (punto 12 de la auditoría del 2026-09-07) — **antes devolvía `res.json()` pasara lo que
 * pasara**, así que el cuerpo de error de Meta viajaba como si fuera una respuesta feliz.
 * Consecuencia medida: el `try/catch` de `flushOutbox` nunca disparaba y el outbox marcaba
 * `sent` mensajes que Meta había RECHAZADO. Nadie los reintentaba y nadie los veía. Lo mismo en
 * el camino del webhook: se guardaba en el historial una respuesta que el cliente nunca recibió.
 *
 * Ahora lanza `WaApiError` en `!res.ok`. Los que ya tenían `try/catch` (flushOutbox,
 * sendMediaActions) pasan a hacer lo correcto solos: marcar `failed` con el motivo.
 */
export async function waPost(
  phoneNumberId: string,
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `${META_API}/${phoneNumberId}/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // deno-lint-ignore no-explicit-any
    const err = (json as any)?.error ?? {};
    const code = typeof err.code === "number" ? err.code : null;
    const detalle = [err.message, err.error_data?.details].filter(Boolean).join(" · ") ||
      JSON.stringify(json).slice(0, 300);
    throw new WaApiError(
      `Meta ${res.status}${code ? ` (code ${code})` : ""}: ${detalle}`,
      res.status,
      code,
    );
  }
  return json;
}

/** Envía mensaje de texto simple. */
export async function sendText(
  phoneNumberId: string,
  token: string,
  to: string,
  text: string,
): Promise<Record<string, unknown>> {
  // WhatsApp max 4096 chars, cortamos a 4000 por seguridad
  const body = text.length > 4000 ? text.slice(0, 3997) + "..." : text;
  return waPost(phoneNumberId, token, "messages", {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

/** Envía template message. */
export async function sendTemplate(
  phoneNumberId: string,
  token: string,
  to: string,
  templateName: string,
  languageCode: string,
  components?: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: languageCode },
  };
  if (components) template.components = components;

  return waPost(phoneNumberId, token, "messages", {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template,
  });
}

/** Marca mensaje como leído. */
export async function markRead(
  phoneNumberId: string,
  token: string,
  messageId: string,
): Promise<void> {
  await waPost(phoneNumberId, token, "messages", {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
}

/** Extrae datos del mensaje entrante de Meta webhook payload. */
export function parseIncoming(body: Record<string, unknown>): {
  from: string;
  text: string;
  msgId: string;
  msgType: string;
  phoneNumberId: string;
} | null {
  try {
    // deno-lint-ignore no-explicit-any
    const entry = (body as any).entry?.[0];
    const change = entry?.changes?.[0]?.value;
    if (!change?.messages?.[0]) return null;
    const msg = change.messages[0];
    return {
      from: msg.from,
      text: msg.text?.body ?? msg.caption ?? "",
      msgId: msg.id,
      msgType: msg.type ?? "text",
      phoneNumberId: change.metadata?.phone_number_id ?? "",
    };
  } catch {
    return null;
  }
}
