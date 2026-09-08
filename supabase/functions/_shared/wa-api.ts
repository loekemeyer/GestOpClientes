// _shared/wa-api.ts — el ÚNICO cliente de la API de Meta. Lo usan el webhook y lk_chat-test.
//
// ⚠ HISTORIA, PARA QUE NO SE REPITA (2026-09-08). Hasta hoy había DOS copias de este archivo:
// ésta y otra dentro de `lk_whatsapp-webhook/`. El webhook importaba la suya, así que el
// arreglo del punto 12 de la auditoría —que `waPost` lance cuando Meta rechaza, en vez de
// devolver el cuerpo de error como si fuera una respuesta feliz— se aplicó acá y **el webhook
// siguió sin él**. Se dio por cerrado un punto que en producción seguía abierto.
//
// Ahora hay una sola. Si hace falta algo nuevo, va acá.
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

/** Envía una imagen por URL. */
export async function sendImage(
  phoneNumberId: string,
  token: string,
  to: string,
  imageUrl: string,
  caption?: string,
): Promise<Record<string, unknown>> {
  return waPost(phoneNumberId, token, "messages", {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: imageUrl, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
  });
}

/** Envía un documento (PDF, etc) por URL. */
export async function sendDocument(
  phoneNumberId: string,
  token: string,
  to: string,
  docUrl: string,
  filename: string,
  caption?: string,
): Promise<Record<string, unknown>> {
  return waPost(phoneNumberId, token, "messages", {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { link: docUrl, filename, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
  });
}

// ─── Normalización de teléfonos ─────────────────────────────────────

/**
 * Variantes de formato para un número argentino. Meta manda el `from` como 5491131181594.
 * Las RPC `bot_*` normalizan con regexp, pero esto sirve para búsquedas directas en tabla.
 */
export function phoneVariants(raw: string): string[] {
  const d = raw.replace(/\D/g, "");
  const v = new Set<string>([d]);
  if (d.startsWith("549") && d.length >= 12) {
    v.add(d.slice(3)); v.add(d.slice(2)); v.add("54" + d.slice(3));
  } else if (d.startsWith("54") && d.length >= 11) {
    v.add(d.slice(2)); v.add("549" + d.slice(2));
  } else if (d.length >= 8 && d.length <= 11) {
    v.add("54" + d); v.add("549" + d);
    if (d.startsWith("9")) { v.add(d.slice(1)); v.add("54" + d.slice(1)); }
  }
  return [...v];
}

// ─── Extracción de datos del webhook ────────────────────────────────

export interface WaMessage {
  from: string;
  msgId: string;
  text: string;
  type: string;
  name?: string;
  timestamp: string;
  /** Id del media en Meta (image/document/audio/video/sticker). Requiere fetch 2-step. */
  mediaId?: string;
  mediaMime?: string;
  mediaFilename?: string;
  caption?: string;
}

/**
 * Extrae el primer mensaje del payload del webhook. Soporta texto y media; en media popula
 * mediaId + mediaMime + caption. Null si no hay mensaje procesable.
 *
 * Reemplaza a `parseIncoming`, que hacía lo mismo pero sin media y no la usaba nadie.
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
    const type = msg.type ?? "text";
    const mediaBlock = ["image", "document", "audio", "video", "sticker"].includes(type)
      ? msg[type] ?? {}
      : {};

    return {
      from: msg.from,
      msgId: msg.id,
      text: msg.text?.body ?? "",
      type,
      name: contact?.profile?.name,
      timestamp: msg.timestamp,
      mediaId: mediaBlock.id ?? undefined,
      mediaMime: mediaBlock.mime_type ?? undefined,
      mediaFilename: mediaBlock.filename ?? undefined,
      caption: mediaBlock.caption ?? undefined,
    };
  } catch {
    return null;
  }
}

// ─── Descarga de media (2 pasos, Meta Cloud API) ────────────────────

export interface DownloadedMedia {
  bytes: Uint8Array;
  mime: string;
  sha256: string | null;
  fileSize: number | null;
}

/**
 * Baja un adjunto de WhatsApp. Paso 1: GET /{media-id} → JSON con una signed URL.
 * Paso 2: GET esa URL con el mismo Bearer → bytes.
 * Los archivos expiran en Meta a los 30 días: hay que bajarlos apenas llegan.
 */
export async function downloadMediaFromMeta(mediaId: string, token: string): Promise<DownloadedMedia> {
  const metaRes = await fetch(`${META_API}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    throw new Error(`Meta media metadata ${metaRes.status}: ${(await metaRes.text()).slice(0, 300)}`);
  }
  const meta = await metaRes.json();
  if (!meta.url) throw new Error("Meta media metadata sin url");

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) {
    throw new Error(`Meta media download ${fileRes.status}: ${(await fileRes.text()).slice(0, 300)}`);
  }
  const buf = new Uint8Array(await fileRes.arrayBuffer());
  return {
    bytes: buf,
    mime: (meta.mime_type as string) || fileRes.headers.get("content-type") || "application/octet-stream",
    sha256: (meta.sha256 as string) ?? null,
    fileSize: typeof meta.file_size === "number" ? meta.file_size : buf.length,
  };
}
