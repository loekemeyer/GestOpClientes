// compuerta-stock — si la respuesta del agente afirma (o niega) stock y en el turno NO llamó a consultar_stock, el CÓDIGO llama a la herramienta y el modelo
// rehace la respuesta con su resultado. Pablo Olejavetzky, 15/10/2026: «Sí, arreglalo con la compuerta» (auditoría 834).
//
// Caso real (Logística …1027, 15/10 16:56): «Del ergonomico, de ese tenes 30 cajas?» → «tiene stock para las 30 cajas» con herramientas vacío: repitió su respuesta
// de 4 minutos antes. La regla STOCK de agente-fijos.ts ya dice «nunca digas que hay o que no hay stock sin usar consultar_stock»; Haiku 5.5 la salteó (segunda vez
// ese día: fila 60 de wa_ia_puntajes). Mismo criterio que el caso Cuccinarte y que el artículo en curso: lo exacto no lo redacta el modelo, y una regla de prompt
// no alcanza para un dato que el cliente toma como una promesa.
//
// Cómo funciona (bot-conversation.ts, runConversation): cuando el modelo termina sin herramientas, se mira el texto. Si afirma stock y no hubo consultar_stock, la
// compuerta arma las llamadas (artículo y cajas salen del texto, del mensaje del cliente o del artículo en curso), las ejecuta como si las hubiera pedido el modelo
// y vuelve a darle la palabra: el modelo contesta con el texto de la herramienta, como manda la regla STOCK. Una sola vez por turno. Costo: una llamada más del modelo
// (unos US$ 0,0005 con Haiku 5.5) sólo en los turnos donde salta.
//
// Módulo puro, sin imports de red: lo prueba tests/compuerta-stock.test.ts.

import { buscarArticuloEnCurso, cajasRespaldadas, codigosDelBot, codigosDelCliente, type FilaCharla } from "./articulo-en-curso.ts";

/** Hasta cuántos artículos consulta la compuerta en un turno (una lista larga no dispara 10 consultas). */
export const MAX_ARTICULOS_COMPUERTA = 4;

const L = String.raw`[a-záéíóúüñ]`;
// «tiene stock», «tiene stock disponible», «no hay stock», «tenemos stock para las 30 cajas», «hay poco stock». No cuenta si va después de «si» («le confirmo si hay stock»).
const RE_AFIRMA = new RegExp(
  String.raw`(?<!${L})(?<!\bsi\s+)(?:tiene|tienen|tenemos|ten[eé]s|hay|queda|quedan|cuenta con|contamos con|disponemos de)\s+(?:${L}+\s+){0,3}stock(?!${L})`, "i");
// «sin stock», «stock limitado», «stock suficiente»: afirman un estado aunque no lleven el verbo.
const RE_ESTADO = new RegExp(String.raw`(?<!${L})(?:sin stock|stock (?:limitado|suficiente|insuficiente|justo|agotado))(?!${L})`, "i");

/** true si algún renglón del texto dice que hay o que no hay stock. Las preguntas al cliente («¿Querés que revise el stock?») y los condicionales («si hay stock») no cuentan. */
export function afirmaStock(texto: string): boolean {
  for (const frag of String(texto ?? "").split(/(?<=[.!?\n])/)) {
    const f = frag.trim();
    if (!f || f.endsWith("?")) continue;   // una pregunta al cliente no afirma nada
    if (RE_AFIRMA.test(f) || RE_ESTADO.test(f)) return true;
  }
  return false;
}

export interface LlamadaStock { cod: string; cajas?: number }

// «30 cajas», «una caja» no (sin cifra no se infiere): sólo cifras pegadas a «caja/cajas».
const RE_CAJAS = /(?<![\d.,])(\d{1,5})\s*cajas?(?![a-záéíóúüñ])/i;

/** Las llamadas a consultar_stock que el modelo tendría que haber hecho. [] si no se sabe de qué artículo habla (la compuerta no inventa uno).
 *  Artículos, en este orden: los códigos que nombra la respuesta («cód. 586»), si no los que escribió el cliente, si no el artículo en curso de la charla.
 *  Cajas: la cifra de la respuesta o del mensaje del cliente, y sólo si el cliente la escribió (cajasRespaldadas): nunca un número que puso el modelo solo. */
export function llamadasDeStock(texto: string, userText: string, historial: FilaCharla[], ahora = new Date()): LlamadaStock[] {
  let cods = [...new Set(codigosDelBot(texto).map((m) => m.cod))];
  if (!cods.length) cods = [...new Set(codigosDelCliente(userText).map((m) => m.cod))];
  if (!cods.length) {
    const enCurso = buscarArticuloEnCurso(historial, userText, ahora);
    if (enCurso) cods = [enCurso.cod];
  }
  if (!cods.length) return [];
  const deLaRespuesta = Number(String(texto ?? "").match(RE_CAJAS)?.[1]);
  const deLaCharla = Number(String(userText ?? "").match(RE_CAJAS)?.[1]);
  const cajas = cajasRespaldadas(deLaRespuesta, userText, historial) ?? cajasRespaldadas(deLaCharla, userText, historial);
  return cods.slice(0, MAX_ARTICULOS_COMPUERTA).map((cod) => (cajas ? { cod, cajas } : { cod }));
}

/** ¿Hay que forzar la consulta? Sólo si la respuesta habla de stock, en el turno no se llamó a consultar_stock y no es un turno de pedido (la toma de pedidos
 *  tiene sus propias compuertas y no se toca). */
export function debeForzarStock(texto: string, herramientasUsadas: string[], enPedido: boolean): boolean {
  if (enPedido || herramientasUsadas.includes("consultar_stock")) return false;
  return afirmaStock(texto);
}
