// Ventana del historial que ve el agente, con INICIO FIJO (Pablo Olejavetzky, 08/10/2026).
// Antes eran siempre los últimos 16 mensajes: en cada turno entraban 2 y salían los 2 más viejos, así que el historial que le llegaba
// al modelo empezaba en otro lado en CADA turno y el caché de Anthropic (que es por prefijo) nunca lo podía reusar. Ahora la ventana
// arranca en un múltiplo de 8 y crece de 16 a 23 mensajes: el inicio se queda quieto 8 mensajes (unos 4 turnos) y en esos turnos el
// historial anterior se lee del caché a 0,1× en vez de escribirse de nuevo a 1,25×. Ver bot-llm.ts (contextoEnElTurno, cuerpoAnthropic).
// Las compuertas (pedido-gate, mail-gate, pedido-turno) y la nota de tiempo siguen viendo los últimos 16, como antes.
//
// Charla anterior completa (Pablo, 08/10, pedido de gerencia: "que el agente tenga memoria"): además de la ventana, el modelo ve la
// charla ANTERIOR entera (corte de 12 h, el mismo de la nota de tiempo), con tope de 8.750 caracteres (~2.500 tokens) y 60 mensajes
// contados desde su final. Esa parte no cambia mientras dura la charla actual, así que también se lee del caché. Si la ventana ya la
// incluye, no cambia nada. Cuando el historial junta más de una charla (o tiene un salto), cada tramo arranca con una marca de fecha y
// hora: sin fechas, el modelo no distingue la charla de ayer de la de hoy (Pablo, 30/09: seguía un tema de un mes atrás).

export const VENTANA_MIN = 16;
export const VENTANA_PASO = 8;
export const HORAS_CHARLA_NUEVA = 12;
export const TOPE_ANTERIOR_CARACTERES = 8_750;
export const TOPE_ANTERIOR_MENSAJES = 60;
/** Filas que se leen por turno: la charla actual y la anterior hasta su tope. Una charla actual de más de ~140 mensajes corta la anterior. */
export const LECTURA_MAX = 200;

export interface Fila { rol: string; contenido: string; creado_en: string }

/** Cuántos de los últimos mensajes entran si el teléfono tiene `total` mensajes guardados: todos si son 16 o menos, si no entre 16 y 23. */
export function largoVentana(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const t = Math.floor(total);
  if (t <= VENTANA_MIN) return t;
  return VENTANA_MIN + ((t - VENTANA_MIN) % VENTANA_PASO);
}

/** "[Mensajes del 07/10 desde las 09:30]", en hora de Argentina. */
export function marcaDeTramo(creadoEn: string): string {
  const d = new Date(creadoEn);
  if (isNaN(d.getTime())) return "[Mensajes anteriores]";
  const p = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const v = (t: string) => (p.find((x) => x.type === t)?.value ?? "").padStart(2, "0");   // es-AR da "7/10" aunque se pida 2 dígitos
  return `[Mensajes del ${v("day")}/${v("month")} desde las ${v("hour")}:${v("minute")}]`;
}

/** Si el modelo copia la marca en su respuesta (la regla CHARLAS ANTERIORES se lo prohíbe), se borra antes de enviar: el cliente nunca la ve. */
export function sinMarcaDeTramo(texto: string): string {
  return texto.replace(/^[ \t]*\[Mensajes (?:del \d{2}\/\d{2} desde las \d{2}:\d{2}|anteriores)\][ \t]*\n?/gm, "").trim();
}

const msDe = (f: Fila) => new Date(f.creado_en).getTime();

/** Lo que ve el modelo, del más viejo al más nuevo: la ventana anclada y, si no la incluye, la charla anterior (con tope).
 *  `nuevasPrimero`: las últimas filas guardadas (hasta LECTURA_MAX), del más nuevo al más viejo, como bot_leer_historial; `total`: cuántas
 *  hay en total (null si no se pudo contar: ventana de 16). `marcas`: posiciones de `filas` que llevan la marca de tramo (vacío si todo
 *  es una sola charla seguida, como antes). `agregadas`: filas de la charla anterior que la ventana sola no traía. */
export function historialParaElModelo(nuevasPrimero: Fila[], total: number | null): { filas: Fila[]; marcas: number[]; agregadas: number } {
  const v = [...nuevasPrimero].reverse();
  const L = v.length;
  if (!L) return { filas: [], marcas: [], agregadas: 0 };
  const desdeVentana = L - Math.min(total == null ? VENTANA_MIN : largoVentana(total), L);
  let desde = desdeVentana;

  const inicios: number[] = [0];
  for (let i = 1; i < L; i++) if (msDe(v[i]) - msDe(v[i - 1]) > HORAS_CHARLA_NUEVA * 3600_000) inicios.push(i);

  // Charla anterior: desde su final hacia atrás, mientras entre en el tope. Ese inicio no se mueve mientras dure la charla actual.
  let tramoAnterior: [number, number] | null = null;
  if (inicios.length >= 2) {
    const iniP = inicios[inicios.length - 2], finP = inicios[inicios.length - 1] - 1;
    let k = finP + 1, chars = 0;
    while (k - 1 >= iniP && finP - k + 2 <= TOPE_ANTERIOR_MENSAJES && chars + v[k - 1].contenido.length <= TOPE_ANTERIOR_CARACTERES) {
      k--;
      chars += v[k].contenido.length;
    }
    if (k <= finP && k < desde) {
      if (desde <= finP + 1) desde = k;   // la ventana arranca dentro de la anterior o justo después: todo seguido desde k
      else tramoAnterior = [k, finP];     // la ventana no llega: la anterior y después la ventana, con un salto en el medio
    }
  }

  const idx: number[] = [];
  if (tramoAnterior) for (let i = tramoAnterior[0]; i <= tramoAnterior[1]; i++) idx.push(i);
  for (let i = desde; i < L; i++) idx.push(i);
  while (idx.length && v[idx[0]].rol !== "user") idx.shift();   // el primer mensaje tiene que ser del cliente (Anthropic y Gemini)

  const esInicio = new Set(inicios);
  const marcas: number[] = [];
  for (let j = 0; j < idx.length; j++) {
    if (j === 0 || idx[j] !== idx[j - 1] + 1 || esInicio.has(idx[j])) marcas.push(j);
  }
  return {
    filas: idx.map((i) => v[i]),
    marcas: marcas.length > 1 ? marcas : [],
    agregadas: idx.filter((i) => i < desdeVentana).length,
  };
}
