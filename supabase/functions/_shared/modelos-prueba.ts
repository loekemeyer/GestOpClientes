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
