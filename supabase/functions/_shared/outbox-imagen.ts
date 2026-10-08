// _shared/outbox-imagen.ts — una fila de wa_outbox con `media_url` sale como mensaje de IMAGEN (Pablo, 08/10/2026).
//
// Hasta acá la cola sólo mandaba texto y plantillas, así que no había forma de mandar una foto por la salida con corte
// (`bot_flush_outbox` + wa-guard): la única que mandaba fotos era la respuesta del bot en el webhook. Primer uso: la foto del
// 505 que Damián (Chef 411) pidió el 08/10 y nunca le llegó (sql/130). `body` va de epígrafe (Meta corta en 1024).
// Meta sólo acepta JPEG y PNG en mensajes de imagen: el link tiene que servir uno de esos dos.

/** Cuerpo del POST a Meta para una imagen por link. `null` si el link no es https (no se manda nada). */
export function cuerpoImagen(to: string, link: string, epigrafe?: string | null): Record<string, unknown> | null {
  const url = String(link ?? "").trim();
  if (!/^https:\/\/\S+$/.test(url)) return null;
  const cap = String(epigrafe ?? "").trim();
  return {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: url, ...(cap ? { caption: cap.slice(0, 1024) } : {}) },
  };
}

/** Lo que queda en el historial (Conversaciones), con el mismo formato que las fotos del webhook: `[Imagen] <epígrafe>`. */
export function historialImagen(link: string, epigrafe?: string | null): string {
  const cap = String(epigrafe ?? "").trim();
  return `[Imagen] ${cap || String(link ?? "").trim()}`;
}
