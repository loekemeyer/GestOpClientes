// _shared/anthropic-extras.ts — lo que cambia por modelo en un pedido a Anthropic. Módulo puro (sin imports): lo usan el agente
// (bot-llm.ts), el lector de comprobantes (lk_parse-comprobante), el puntaje de respuestas (lk_ia-puntaje) y las fichas de memoria
// (lk_memoria-cliente).
//
// Haiku 5.5 (Pablo Olejavetzky, 09/10/2026: "reemplazá el uso de Haiku 4.5 por 5.5"). Tres diferencias con Haiku 4.5:
//   1. Piensa por defecto y, pensando, hay que devolverle sus bloques de pensamiento con cada resultado de herramienta (el historial
//      normalizado del agente no los guarda). Se pide con el pensamiento apagado y esfuerzo bajo, que la documentación permite hasta
//      "high": lo más rápido y barato, y lo más parecido a cómo corría Haiku 4.5 (prueba del 09/10: 5 de 5 turnos bien, p50 1,4 s).
//   2. temperature, top_p o top_k distintos del valor por defecto dan 400: no se mandan.
//   3. Su tokenizador cuenta ~30 % más tokens por el mismo texto: más tope de salida.

/** Campos que se agregan (o pisan) en el cuerpo del pedido para ese modelo. {} si no hay nada que cambiar. */
// deno-lint-ignore no-explicit-any
export function extrasAnthropic(model: string): Record<string, any> {
  if (/^claude-haiku-5/.test(model)) return { max_tokens: 2048, thinking: { type: "disabled" }, output_config: { effort: "low" } };
  return {};
}

/** El texto de la respuesta: los bloques "text" juntos, sin los de pensamiento (con el pensamiento prendido el primero puede ser uno). */
// deno-lint-ignore no-explicit-any
export function textoAnthropic(content: any): string {
  return (Array.isArray(content) ? content : []).filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("");
}
