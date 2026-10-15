// _shared/imagen-enviable.ts — ¿Meta va a aceptar esta imagen? (Pablo Olejavetzky, 15/10/2026, tanda de pruebas: la foto del 599E no llegó y el bot dijo que mandó las 10.)
//
// Causa medida: `products-images/hd/599E.jpg` es un JPEG CMYK (4 componentes, con un perfil ICC de 654 KB). WhatsApp sólo acepta JPEG en RGB o escala de grises y PNG:
// con CMYK Meta acepta el mensaje y después lo rechaza con 131053 «Media upload error». Pasó las 2 veces que se mandó (14/10 y 15/10); las otras 19 fotos salieron bien.
// La base ya filtra por tipo y tamaño (bot_obtener_imagenes_producto: image/jpeg o png, hasta 5 MB), pero no puede mirar adentro del archivo.
//
// Acá se mira el encabezado: se baja el archivo en streaming y se corta en cuanto aparece el marcador SOF del JPEG (donde dice cuántos componentes tiene; en una foto normal
// está en los primeros KB, en la del 599E después del perfil ICC). Un JPEG de 4 componentes, o un WebP de verdad (WhatsApp no lo acepta como imagen), no se manda.
// Si no se puede mirar (red caída, tiempo agotado, formato raro), SE MANDA igual: es lo que pasaba hasta hoy y el aviso de envío fallido sigue atrapando el resto.
//
// Sin efectos al importarlo. La lógica de bytes es pura y la prueba tests/imagen-enviable.test.ts.

export interface ResultadoImagen {
  ok: boolean;
  motivo?: string;
}

/** Cantidad de componentes de color de un JPEG (1 gris, 3 RGB o YCbCr, 4 CMYK) leyendo el primer marcador SOF. undefined = todavía no apareció, null = no es un JPEG. */
export function componentesJpeg(b: Uint8Array): number | null | undefined {
  if (b.length < 2) return undefined;
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }          // relleno entre segmentos
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }              // 0xFF de relleno
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; } // marcadores sin largo
    if (m === 0xd9 || m === 0xda) return null;      // fin de imagen o datos sin haber visto un SOF: no se puede saber
    const largo = (b[i + 2] << 8) | b[i + 3];
    const esSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (esSof) {
      if (i + 10 > b.length) return undefined;      // el SOF empieza pero todavía no llegó entero
      return b[i + 9];
    }
    i += 2 + largo;                                  // salta el segmento (el perfil ICC de 654 KB entra acá)
  }
  return undefined;
}

/** Decide con los primeros bytes: true/false si ya se sabe, undefined si hace falta leer más. */
export function veredictoDeBytes(b: Uint8Array): ResultadoImagen | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ok: true };            // PNG
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { ok: false, motivo: "es un WebP: WhatsApp no lo acepta como imagen" };
  }
  if (b.length < 12 && !(b[0] === 0xff && b[1] === 0xd8)) return undefined;   // muy poco para saber qué es
  const c = componentesJpeg(b);
  if (c === undefined) return undefined;          // todavía no apareció el SOF: hace falta leer más
  if (c === null) return { ok: true };            // no es un JPEG que sepamos mirar: se manda
  if (c === 4) return { ok: false, motivo: "es un JPEG en CMYK: WhatsApp sólo acepta RGB o escala de grises" };
  return { ok: true };
}

const MAX_BYTES = 2_500_000;    // si en 2,5 MB no apareció el SOF, no se sigue bajando: se manda
const TTL_MS = 6 * 3600 * 1000; // una foto no cambia seguido; el resultado se recuerda mientras viva la instancia
const cache = new Map<string, { r: ResultadoImagen; t: number }>();

/** ¿Se puede mandar esta imagen por WhatsApp? Nunca lanza: ante cualquier problema para mirarla, ok. */
export async function imagenEnviable(url: string, opts: { fetchFn?: typeof fetch; timeoutMs?: number; ahora?: () => number } = {}): Promise<ResultadoImagen> {
  const ahora = opts.ahora ?? Date.now;
  const hit = cache.get(url);
  if (hit && ahora() - hit.t < TTL_MS) return hit.r;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await (opts.fetchFn ?? fetch)(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) return { ok: true };
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    let r: ResultadoImagen | undefined;
    while (!r && buf.length < MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      const nuevo = new Uint8Array(buf.length + value.length);
      nuevo.set(buf); nuevo.set(value, buf.length);
      buf = nuevo;
      r = veredictoDeBytes(buf);
    }
    try { await reader.cancel(); } catch { /* ya cerrado */ }
    const final = r ?? { ok: true };
    cache.set(url, { r: final, t: ahora() });
    return final;
  } catch (_) {
    return { ok: true };            // no se pudo mirar: se manda como siempre (y no se recuerda, para volver a intentar)
  } finally {
    clearTimeout(timer);
  }
}

/** Para las pruebas. */
export function vaciarCacheImagenes(): void {
  cache.clear();
}
