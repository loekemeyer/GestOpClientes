// Partir la respuesta del agente en varios mensajes de WhatsApp (Pablo Olejavetzky, 16/10/2026).
//
// Cuando el cliente pregunta varias cosas en un mensaje (y con el audio prendido puede explayarse), el agente contesta
// cada dato en un mensaje aparte, para que no se mezclen y parezca natural. Lo marca poniendo `[[corte]]` entre una
// respuesta y la siguiente; el webhook y el Simulador parten el texto en ese marcador y mandan cada parte por separado.
//
// Clave: SIN el marcador, sale un solo mensaje, exactamente como hasta hoy → cero regresión en las respuestas normales.
// El marcador nunca llega al cliente: el split lo consume. Tope de partes (MAX_PARTES_RESPUESTA): si el modelo pusiera de
// más (un audio enorme con muchas preguntas), las que pasan del tope se pegan a la última, para no inundar al cliente.
//
// Módulo puro (sin red ni base). Se prueba en tests/partir-respuesta.test.ts.

/** El marcador que el agente pone, en una línea sola, entre una respuesta y la siguiente. */
export const MARCADOR_CORTE = "[[corte]]";

/** Tope de mensajes separados por turno (Pablo, 16/10: hasta 7 datos; dejamos 8 por si suma un cierre). */
export const MAX_PARTES_RESPUESTA = 8;

/** Parte `texto` en los `[[corte]]`. Devuelve [texto] si no hay marcador (una sola respuesta, lo de siempre). Saca partes
 *  vacías y recorta cada una. Si hay más de `max` partes, las de más se unen a la última (no se pierde nada ni se inunda). */
export function partirRespuesta(texto: string, max = MAX_PARTES_RESPUESTA): string[] {
  const t = String(texto ?? "");
  if (!t.includes(MARCADOR_CORTE)) return t.trim() ? [t] : [];
  const partes = t.split(MARCADOR_CORTE).map((p) => p.trim()).filter(Boolean);
  if (partes.length <= max) return partes.length ? partes : [];
  const cabeza = partes.slice(0, max - 1);
  cabeza.push(partes.slice(max - 1).join("\n\n"));
  return cabeza;
}
