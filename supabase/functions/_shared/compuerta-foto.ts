// compuerta-foto — si el cliente pidió una foto y en el turno el agente NO llamó a enviar_fotos_producto, el CÓDIGO manda la foto.
// Pablo Olejavetzky, 16/10/2026: a «¿tenés stock del 654, cuánto vale? ¿tenés foto?» el agente contestó stock y precio pero se comió la foto
// (antes había sido al revés: sólo la foto). Misma lección que la compuerta de stock y el artículo en curso: el modelo no dispara de forma
// confiable una herramienta por cada pedido, y una regla de prompt no alcanza.
//
// Diferencia con la compuerta de stock: la foto es media, no texto. El borrador del modelo (el stock y el precio) está BIEN y se conserva;
// la compuerta sólo ejecuta enviar_fotos_producto y suma la imagen al turno, sin descartar la respuesta ni hacer otra vuelta del modelo.
// Dispara por lo que pidió el CLIENTE (no por lo que afirma la respuesta, como la de stock): el cliente pidió ver una foto.
//
// Módulo puro, sin imports de red: lo prueba tests/compuerta-foto.test.ts.

import { buscarArticuloEnCurso, codigosDelBot, codigosDelCliente, type FilaCharla } from "./articulo-en-curso.ts";

/** Hasta cuántas fotos manda la compuerta en un turno (una lista larga no dispara 10 envíos). */
export const MAX_FOTOS_COMPUERTA = 4;

const L = String.raw`[a-záéíóúüñ]`;
// «tenés foto», «mandame una foto», «pasame la imagen», «foto del 654», «fotos», «una imagen». La palabra foto/imagen suelta alcanza.
const RE_PIDE_FOTO = new RegExp(String.raw`(?<!${L})(?:fotos?|imagen|im[aá]genes)(?!${L})`, "i");
// «sin foto», «no … foto/imagen»: el cliente NO está pidiendo una foto (la está descartando). No dispara.
const RE_NO_FOTO = new RegExp(String.raw`(?<!${L})(?:sin\s+(?:foto|imagen)|no\s+(?:${L}+\s+){0,3}(?:foto|imagen))`, "i");

/** ¿El cliente pidió ver una foto/imagen en su mensaje? */
export function pideFoto(userText: string): boolean {
  const t = String(userText ?? "");
  if (RE_NO_FOTO.test(t)) return false;
  return RE_PIDE_FOTO.test(t);
}

/** Los códigos cuya foto el modelo tendría que haber mandado. Misma búsqueda de artículo que la compuerta de stock: los que nombra la
 *  respuesta, si no los que escribió el cliente, si no el artículo en curso de la charla. [] si no se sabe de qué artículo (no inventa). */
export function fotosAEnviar(texto: string, userText: string, historial: FilaCharla[], ahora = new Date()): string[] {
  let cods = [...new Set(codigosDelBot(texto).map((m) => m.cod))];
  if (!cods.length) cods = [...new Set(codigosDelCliente(userText).map((m) => m.cod))];
  if (!cods.length) {
    const enCurso = buscarArticuloEnCurso(historial, userText, ahora);
    if (enCurso) cods = [enCurso.cod];
  }
  return cods.slice(0, MAX_FOTOS_COMPUERTA);
}

/** ¿Forzar el envío de la foto? Sólo si el cliente la pidió, en el turno no se llamó a enviar_fotos_producto y no es turno de pedido
 *  (la toma de pedidos tiene sus propias compuertas y no se toca). */
export function debeForzarFoto(userText: string, herramientasUsadas: string[], enPedido: boolean): boolean {
  if (enPedido || herramientasUsadas.includes("enviar_fotos_producto")) return false;
  return pideFoto(userText);
}
