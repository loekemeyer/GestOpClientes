// Plazo de entrega general del bot (Pablo Olejavetzky, 06/10/2026, correcciones m61 y m62 del artifact: "hoy son 14 días hábiles", "14 días hábiles fijo").
// Módulo puro, sin imports: lo usa faq.ts (respuesta al plazo y al "¿puede estar para el viernes?") y lo prueba tests/plazo-entrega.test.ts.
//
// ⚠ Es un número fijo a propósito: Pablo eligió "14 días hábiles para todos" y no el cálculo real por modo que ya existe para el aviso de pedido
// recibido (sql/082, wa_fecha_estimada: reparto ~21 días corridos, expreso ~20, retiro ~8, medido el 29/09). Si cambia la promesa, se cambia acá.

export const PLAZO_DIAS_HABILES = 14;

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const aFecha = (iso: string): Date => new Date(iso + "T12:00:00Z");
const aIso = (d: Date): string => d.toISOString().slice(0, 10);

/** Día hábil: lunes a viernes que no esté en `feriados` (fechas "AAAA-MM-DD"). */
export function esDiaHabil(iso: string, feriados: readonly string[] = []): boolean {
  const dow = aFecha(iso).getUTCDay();
  return dow !== 0 && dow !== 6 && !feriados.includes(iso);
}

/** La fecha en que se cumplen `n` días hábiles DESPUÉS de `desde` (el día del pedido no cuenta). Con n = 0 devuelve `desde`. */
export function sumarDiasHabiles(desde: string, n: number, feriados: readonly string[] = []): string {
  const d = aFecha(desde);
  let faltan = Math.max(0, Math.floor(n));
  while (faltan > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (esDiaHabil(aIso(d), feriados)) faltan--;
  }
  return aIso(d);
}

/** "martes 27/10". */
export function textoFecha(iso: string): string {
  const d = aFecha(iso);
  return `${DIAS[d.getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Respuesta al "¿qué plazo de entrega manejan?" (m61). */
export const textoPlazo = (): string => `El plazo de entrega hoy es de ${PLAZO_DIAS_HABILES} días hábiles desde que hacés el pedido.`;

/** Respuesta a "Paso un pedido, ¿puede estar para el viernes?" (m62): fecha estimada de un pedido de hoy + lo consulta una persona. */
export function textoPedidoParaFecha(hoy: string, feriados: readonly string[] = []): string {
  const llega = textoFecha(sumarDiasHabiles(hoy, PLAZO_DIAS_HABILES, feriados));
  return `Hoy la entrega estimada es de ${PLAZO_DIAS_HABILES} días hábiles: si hacés el pedido hoy, sería el ${llega}.\n` +
    "Para la fecha que necesitás lo consulta una persona de Ventas y te escribe por acá. ¿Qué artículos necesitás?";
}
