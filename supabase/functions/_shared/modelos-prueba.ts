// app_settings.llm_modelo_pruebas: el modelo (o los modelos, en orden) con que corren el Simulador y el Chat de prueba.
//
// Pablo Olejavetzky, 08/10/2026: "me importa que funcione". Con un solo modelo, cada caída de Gemini gratis era una prueba perdida
// (07/10: 3.5 Flash-Lite falló en 36,9 % de las llamadas y 3.1 Flash-Lite en 69,5 %, fuente bot_llm_intentos). Ahora el valor acepta
// varios model_id separados por coma: si el primero falla, el turno sigue con el siguiente. Sólo los de la lista: la prueba NUNCA cae a la
// cadena de producción (regla del 01/10: que una caída no se pague en otro modelo sin que nadie se entere). Un modelo pago en la lista
// se paga a sabiendas: la regla de gasto (estimativo + "sí") sigue valiendo para quien lo ponga.
//
// Módulo puro (sin red ni base). Se prueba en tests/modelos-prueba.test.ts.

export const MAX_MODELOS_PRUEBA = 5;

export function listaModelosPrueba(valor: string | null | undefined): string[] {
  const out: string[] = [];
  for (const p of (valor ?? "").split(/[,\s]+/)) {
    const m = p.trim();
    if (m && !out.includes(m)) out.push(m);
  }
  return out.slice(0, MAX_MODELOS_PRUEBA);
}

/** id de cada modelo de prueba: negativo (markModelDown no toca negativos: no son filas de la cadena) y distinto por modelo, porque el loop
 *  del agente saltea por id los que ya fallaron en el turno. -1 el primero (como antes) y -11, -12… los siguientes (-2 es el reintento
 *  del modelo fijo de pedidos, pedido-turno.ts). */
export function idModeloPrueba(i: number): number {
  return i === 0 ? -1 : -10 - i;
}

/** Hasta dónde puede llegar un turno del Simulador contando una espera por cuota: la corrida de evaluación le da 120 s a cada caso
 *  (wa_eval_tick, timeout_milliseconds) y la llamada que sigue a la espera puede tardar hasta el tope general de 30 s. */
export const PRESUPUESTO_TURNO_PRUEBA_MS = 110_000;
const LLAMADA_MAX_MS = 30_000;

/** Pablo Olejavetzky, 08/10/2026 (medir Gemma 4 gratis): el plan gratis de Google le da a Gemma 4 26B 16.000 tokens de entrada por minuto
 *  y una llamada del bot manda ~12.000, así que la segunda llamada de un turno con herramientas daba 429 y el caso se perdía (medido el 08/10:
 *  de 11 llamadas en la 2ª o 3ª vuelta, 9 dieron 429). En el Simulador, un 429 por cuota POR MINUTO con "retry in Ns" se espera (N + 1 s)
 *  y se reintenta el mismo modelo, si entra en el presupuesto del turno. Devuelve los ms a esperar, o 0 si no hay que esperar.
 *  No aplica a la cuota por día (no se arregla esperando) ni a nada fuera del Simulador. */
export function esperaPorCuotaDePrueba(status: number | undefined, msg: string, transcurridoMs: number): number {
  if (status !== 429 || /PerDay/i.test(msg)) return 0;
  const m = msg.match(/retry in ([\d.]+)\s*s/i) ?? msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  if (!m) return 0;
  const espera = Math.ceil(parseFloat(m[1]) * 1000) + 1_000;
  if (!(espera > 0) || espera > 61_000) return 0;
  return transcurridoMs + espera + LLAMADA_MAX_MS <= PRESUPUESTO_TURNO_PRUEBA_MS ? espera : 0;
}

/** Pablo, 08/10: sólo los modelos gratis (is_free_tier). La usa la corrida automática de evaluación (opciones.soloGratis de runConversation). */
export function soloModelosGratis<T extends { isFreeTier: boolean }>(candidatos: readonly T[]): T[] {
  return candidatos.filter((c) => c.isFreeTier === true);
}
