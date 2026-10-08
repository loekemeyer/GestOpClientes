// Cuánto se espera a cada modelo en la conversación del agente antes de darlo por caído y pasar al siguiente de la cadena.
//
// Pablo Olejavetzky, 06/10/2026: el simulador mostró "[TIMEOUT] El LLM no respondió a tiempo" porque UNA llamada a Gemini quedó colgada los 30 s
// completos (1 de 239 en 48 h; las demás: mediana 1,07 s, p95 1,94 s, p99 2,71 s, máximo 4,5 s; fuente: bot_llm_intentos). En producción eso
// es un cliente esperando 30 s antes de que conteste Sonnet. Gemini va con tope corto; Sonnet y Haiku siguen en 30 s (con herramientas y
// prompts largos tardan más y NO tienen a quién pasarle después: un corte ahí es un turno perdido).
//
// Pablo Olejavetzky, 08/10/2026 (medir modelos de pesos abiertos, los que se podrían correr en un equipo propio): Gemma 4 viene por la misma
// API de Google pero NO es Gemini. Piensa antes de contestar (170 a 250 tokens de razonamiento por llamada con un prompt de 13.281 tokens,
// medido el 08/10) y su demora en el bot no está medida: va con el tope general hasta que bot_llm_intentos diga otra cosa.
//
// Módulo puro (sin red ni base). Se prueba en tests/timeouts.test.ts.

/** Tope para todos los modelos salvo los de abajo. */
export const TIMEOUT_MODELO_MS = 30_000;
/** Gemini: ~3 veces su p99 y casi el doble de su máximo normal medido. */
export const TIMEOUT_GEMINI_MS = 8_000;

export function timeoutDeModelo(proveedor: string, modelo = ""): number {
  if (proveedor !== "google" || /^gemma/i.test(modelo)) return TIMEOUT_MODELO_MS;
  return TIMEOUT_GEMINI_MS;
}
