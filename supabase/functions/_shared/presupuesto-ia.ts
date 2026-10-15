// Presupuesto MENSUAL global de gasto de IA (Pablo Olejavetzky, 14/10/2026: "200 USD gratis de Anthropic, uso 100 USD mensuales, que avise al
// 25, 50 y 75 por ciento, y verlo en el dashboard"). Decidido con él: "las dos capas" (ésta + el tope por cliente) y, al 100%, "sólo avisa".
//
// Qué cuida y en qué se diferencia del tope diario (_shared/tope-gasto.ts):
//   • tope-gasto.ts es un corte DIARIO y GLOBAL que mira SÓLO a los clientes (function_name = lk_whatsapp-webhook): frena al agente ese día.
//   • esto es un MEDIDOR MENSUAL del POZO: cuenta TODO el gasto (clientes + simulador + chat de prueba + puntaje), porque el crédito de Anthropic
//     se agota con todo, no sólo con los clientes. El 01/10 el pozo se secó y el agente quedó mudo: el medidor avisa antes de que eso vuelva a pasar.
//   • "Sólo avisa" (Pablo, 14/10): al 100% manda la alerta máxima pero NO corta nada. El único freno real siguen siendo el tope diario y el por cliente.
//
// Fuente del número (Pablo eligió "híbrido"): los avisos salen sobre `estimated_cost_usd` de bot_token_usage (el estimativo del código, ya cargado,
// gratis). Ese número puede divergir de la factura real de Anthropic; la corrección contra el Admin/Usage API (que necesita una admin key nueva)
// queda como paso aparte. Mientras no esté, el medidor es una aproximación: sirve para avisar, no para cerrar la contabilidad.
//
// Dónde se cambia sin deploy (app_settings):
//   • ia_presup_mensual_usd  — presupuesto del mes en US$ (defecto 100; 0 apaga el medidor y los avisos).
//   • ia_presup_pozo_usd     — crédito total del pozo en US$, sólo para mostrarlo en el dashboard (defecto 200; 0 lo oculta).
//   • ia_presup_umbrales     — a qué % avisa, separados por coma (defecto "25,50,75,90,100").
//
// El aviso reusa el motivo `tope_gasto` de Derivaciones (misma categoría, semáforo y destino que el gasto diario: lo mira la misma persona) con
// `nivel: "presupuesto"` y el `umbral` cruzado, así no hace falta cablear un motivo nuevo en cinco archivos. La deduplicación es UNA alerta por
// umbral por mes (el webhook la consulta en wa_alertas_humano por motivo+nivel+umbral dentro del mes).
//
// Módulo PURO (sin red ni base). Se prueba en tests/presupuesto-ia.test.ts.

export const PRESUP_MENSUAL_USD_DEFAULT = 100;
export const PRESUP_POZO_USD_DEFAULT = 200;
export const PRESUP_UMBRALES_DEFAULT = [25, 50, 75, 90, 100];
/** A partir de este umbral la alerta se marca urgente (rojo en el semáforo): el pozo está por secarse. */
export const PRESUP_UMBRAL_URGENTE = 90;

const HORA_MS = 3_600_000;
const OFFSET_ART_MS = -3 * HORA_MS; // Argentina, UTC-3 todo el año (igual que tope-gasto.ts, tope-ia.ts y horario.ts)

/** Instante (ms UTC) en que empezó el MES de Argentina al que pertenece `ahoraMs`: el día 1 a las 00:00 ART son las 03:00 UTC de ese día. */
export function inicioMesArgentina(ahoraMs: number): number {
  const local = new Date(ahoraMs + OFFSET_ART_MS); // "fecha local": se lee con getUTC*
  const primero = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, 0, 0, 0, 0);
  return primero - OFFSET_ART_MS;
}

/** Un monto de app_settings: acepta "100", "100.5" y "100,5". Vacío, ausente, no numérico o negativo → el valor por defecto. 0 es válido (apaga). */
function monto(crudo: unknown, porDefecto: number): number {
  if (crudo === null || crudo === undefined) return porDefecto;
  const t = String(crudo).trim().replace(",", ".");
  if (!t) return porDefecto;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
}

/** El presupuesto del mes guardado en app_settings (`ia_presup_mensual_usd`). */
export function presupuestoDeSettings(crudo: unknown): number {
  return monto(crudo, PRESUP_MENSUAL_USD_DEFAULT);
}

/** El pozo total guardado en app_settings (`ia_presup_pozo_usd`), sólo para mostrarlo. */
export function pozoDeSettings(crudo: unknown): number {
  return monto(crudo, PRESUP_POZO_USD_DEFAULT);
}

/**
 * Los umbrales de aviso desde `ia_presup_umbrales` (ej. "25,50,75,90,100"). Se quedan sólo los que son números en (0, 100], sin repetidos y ordenados
 * de menor a mayor. Un texto vacío o sin ningún umbral válido vuelve al valor por defecto. Acepta coma decimal suelta sólo si no hay separadores de lista.
 */
export function umbralesDeSettings(crudo: unknown): number[] {
  if (crudo === null || crudo === undefined) return [...PRESUP_UMBRALES_DEFAULT];
  const txt = String(crudo).trim();
  if (!txt) return [...PRESUP_UMBRALES_DEFAULT];
  const partes = txt.split(/[,;\s]+/).filter(Boolean);
  const nums: number[] = [];
  for (const p of partes) {
    const n = Number(p.replace(",", "."));
    if (Number.isFinite(n) && n > 0 && n <= 100 && !nums.includes(n)) nums.push(n);
  }
  nums.sort((a, b) => a - b);
  return nums.length ? nums : [...PRESUP_UMBRALES_DEFAULT];
}

/** Suma el costo de las filas de bot_token_usage (numeric llega como texto desde PostgREST). Lo que no es número cuenta 0. */
export function sumarGastoMes(filas: ReadonlyArray<{ estimated_cost_usd?: unknown } | null | undefined>): number {
  let t = 0;
  for (const f of filas) {
    const n = Number(f?.estimated_cost_usd);
    if (Number.isFinite(n) && n > 0) t += n;
  }
  return t;
}

/** Qué porcentaje del presupuesto se gastó. Presupuesto en 0 o negativo → 0 (el medidor está apagado). Nunca negativo. */
export function pctDelMes(gasto: number, presupuesto: number): number {
  if (!(presupuesto > 0)) return 0;
  const p = (gasto / presupuesto) * 100;
  return p > 0 ? p : 0;
}

/**
 * El umbral MÁS ALTO que ya se cruzó (pct alcanzado o superado), o null si todavía no se cruzó ninguno. Los umbrales se asumen ordenados de menor a
 * mayor (umbralesDeSettings los deja así). Es el umbral sobre el que avisa el webhook: si el gasto saltó varios de golpe, avisa por el más alto y el
 * texto dice el % real, así no manda un aviso por cada umbral saltado.
 */
export function umbralCruzado(pct: number, umbrales: readonly number[]): number | null {
  let cruzado: number | null = null;
  for (const u of umbrales) if (pct >= u) cruzado = u; else break;
  return cruzado;
}

const usd = (n: number) => (Math.round(n * 100) / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctTxt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("es-AR", { maximumFractionDigits: 1 });

/**
 * Contexto de la alerta para una persona. Reusa el motivo `tope_gasto` (misma categoría, semáforo y destino en Derivaciones que el gasto diario) con
 * `nivel: "presupuesto"` y el `umbral` cruzado, que es además la clave de deduplicación (una alerta por umbral por mes). Desde PRESUP_UMBRAL_URGENTE
 * se marca `urgente` (rojo): el pozo está por secarse. `pozo` es opcional y sólo agrega una línea informativa.
 */
export function contextoAlertaPresupuesto(
  umbral: number, gasto: number, presupuesto: number, pozo?: number | null,
): Record<string, unknown> {
  const pct = pctDelMes(gasto, presupuesto);
  const urgente = umbral >= PRESUP_UMBRAL_URGENTE;
  const lineaPozo = pozo && pozo > 0
    ? ` El pozo total son US$ ${usd(pozo)}: con este mes van US$ ${usd(gasto)} del pozo.`
    : "";
  const detalle = `El gasto de IA del mes llegó al ${pctTxt(umbral)}% del presupuesto de US$ ${usd(presupuesto)} (va en US$ ${usd(gasto)}, el ` +
    `${pctTxt(pct)}%).${lineaPozo} ` +
    (urgente
      ? "Está por agotarse: mirá qué lo está gastando (¿cayó el modelo gratis a uno pago?, ¿una tanda de pruebas?, ¿un bucle?) antes de que el pozo se seque."
      : "El agente sigue contestando normal (esto sólo avisa, no corta): mirá qué lo está gastando si el ritmo no cuadra.");
  return {
    motivo: "tope_gasto",
    nivel: "presupuesto",
    umbral,
    urgente,
    gasto_usd: Math.round(gasto * 10_000) / 10_000,
    presupuesto_usd: presupuesto,
    pozo_usd: pozo && pozo > 0 ? pozo : null,
    pct: Math.round(pct * 100) / 100,
    detalle,
  };
}
