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

/** Envía una imagen por URL */
export function sendImage(
  phoneId: string,
  token: string,
  to: string,
  imageUrl: string,
  caption?: string,
): Promise<unknown> {
  return waPost(phoneId, token, {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link: imageUrl,
      ...(caption ? { caption: caption.slice(0, 1024) } : {}),
    },
  });
}

/** Envía un documento (PDF, etc) por URL */
export function sendDocument(
  phoneId: string,
  token: string,
  to: string,
  docUrl: string,
  filename: string,
  caption?: string,
): Promise<unknown> {
  return waPost(phoneId, token, {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: {
      link: docUrl,
      filename,
      ...(caption ? { caption: caption.slice(0, 1024) } : {}),
    },
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
 * Las RPCs bot_* usan regexp_replace para normalizar, pero esta
 * función es útil para búsquedas directas en tabla.
 */
export function phoneVariants(raw: string): string[] {
  const d = canonPhone(raw);
  const v = new Set<string>();
  v.add(d);

  if (d.startsWith("549") && d.length >= 12) {
    v.add(d.slice(3));
    v.add(d.slice(2));
    v.add("54" + d.slice(3));
  } else if (d.startsWith("54") && d.length >= 11) {
    v.add(d.slice(2));
    v.add("549" + d.slice(2));
  } else if (d.length >= 8 && d.length <= 11) {
    v.add("54" + d);
    v.add("549" + d);
    if (d.startsWith("9")) {
      v.add(d.slice(1));
      v.add("54" + d.slice(1));
    }
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
  /** Id del media en Meta (para image/document/audio/video/sticker). Requiere
   * fetch 2-step contra Graph API para bajar el archivo real. */
  mediaId?: string;
  /** MIME sugerido por Meta (opcional; para redoblar contra el detectado al bajar). */
  mediaMime?: string;
  /** Filename original cuando el cliente adjunta un documento. */
  mediaFilename?: string;
  /** Caption opcional que el cliente puede haber puesto junto al adjunto. */
  caption?: string;
}

/**
 * Extrae el primer mensaje del payload del webhook de Meta. Soporta texto y
 * media (image/document/audio/video/sticker) — en media, popula mediaId +
 * mediaMime + caption. Retorna null si no hay mensaje procesable.
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

    // Media types: el payload trae msg[type] = { id, mime_type, sha256, filename?, caption? }
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
 * Baja un adjunto de WhatsApp desde Meta Cloud API.
 *
 * Paso 1: GET /{media-id} con Bearer → devuelve JSON con { url, mime_type,
 *         sha256, file_size } donde `url` es una signed URL de Meta.
 * Paso 2: GET esa signed URL con el mismo Bearer → bytes del archivo.
 *
 * Los archivos expiran en Meta a los 30 días — hay que bajarlos y guardarlos
 * apenas llegan. Los devuelve como Uint8Array listos para subir a Storage.
 */
export async function downloadMediaFromMeta(mediaId: string, token: string): Promise<DownloadedMedia> {
  // Paso 1
  const metaRes = await fetch(`${GRAPH_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    const t = await metaRes.text();
    throw new Error(`Meta media metadata ${metaRes.status}: ${t.slice(0, 300)}`);
  }
  const meta = await metaRes.json();
  if (!meta.url) throw new Error("Meta media metadata sin url");

  // Paso 2 — signed URL apunta a lookaside.fbsbx.com; requiere el mismo Bearer
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) {
    const t = await fileRes.text();
    throw new Error(`Meta media download ${fileRes.status}: ${t.slice(0, 300)}`);
  }
  const buf = new Uint8Array(await fileRes.arrayBuffer());
  return {
    bytes: buf,
    mime: (meta.mime_type as string) || fileRes.headers.get("content-type") || "application/octet-stream",
    sha256: (meta.sha256 as string) ?? null,
    fileSize: typeof meta.file_size === "number" ? meta.file_size : buf.length,
  };
}
