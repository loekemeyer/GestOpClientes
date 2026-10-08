// Ventana del historial que ve el agente, con INICIO FIJO (Pablo Olejavetzky, 08/10/2026).
// Antes eran siempre los últimos 16 mensajes: en cada turno entraban 2 y salían los 2 más viejos, así que el historial que le llegaba
// al modelo empezaba en otro lado en CADA turno y el caché de Anthropic (que es por prefijo) nunca lo podía reusar. Ahora la ventana
// arranca en un múltiplo de 8 y crece de 16 a 23 mensajes: el inicio se queda quieto 8 mensajes (unos 4 turnos) y en esos turnos el
// historial anterior se lee del caché a 0,1× en vez de escribirse de nuevo a 1,25×. Ver bot-llm.ts (contextoEnElTurno, cuerpoAnthropic).
// Las compuertas (pedido-gate, mail-gate, pedido-turno) y la nota de tiempo siguen viendo los últimos 16, como antes.

export const VENTANA_MIN = 16;
export const VENTANA_PASO = 8;

/** Cuántos de los últimos mensajes entran si el teléfono tiene `total` mensajes guardados: todos si son 16 o menos, si no entre 16 y 23. */
export function largoVentana(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const t = Math.floor(total);
  if (t <= VENTANA_MIN) return t;
  return VENTANA_MIN + ((t - VENTANA_MIN) % VENTANA_PASO);
}

/** Recorta las filas (del más nuevo al más viejo, como bot_leer_historial) a la ventana anclada. Sin conteo, los 16 de siempre. */
export function filasDeLaVentana<T>(filas: T[], total: number | null): T[] {
  return filas.slice(0, total == null ? VENTANA_MIN : largoVentana(total));
}
