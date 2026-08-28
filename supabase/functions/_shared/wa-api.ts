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

/** POST genérico a Meta API. */
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
  return res.json();
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

/** Lista message templates de la WABA (default: solo APPROVED). */
export async function getTemplates(
  wabaId: string,
  token: string,
  status = "APPROVED",
): Promise<{ data: Record<string, unknown>[]; error?: string }> {
  const params = new URLSearchParams({ limit: "100" });
  if (status) params.set("status", status);

  const url = `${META_API}/${wabaId}/message_templates?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (json.error) {
    return { data: [], error: json.error.message ?? JSON.stringify(json.error) };
  }
  return { data: json.data ?? [] };
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
