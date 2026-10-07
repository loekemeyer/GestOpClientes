// Tope de gasto global diario de IA (Pablo Olejavetzky, 07/10/2026: "dejalo en US$ 2 con aviso a US$ 1").
//
// Por qué existe: el límite de 20 consultas por hora es POR NÚMERO (_shared/tope-ia.ts) y no hay techo total. El 01/10 el crédito de Anthropic se
// agotó y el agente dejó de contestar hasta que se recargó. Si algún día falla Gemini (gratis) y todo cae a Sonnet, o un bucle o abuso dispara
// llamadas, nada frenaba el gasto. Medida pendiente en MEDIDAS_SEGURIDAD ("Tope de gasto global diario"), activa desde acá.
//
// Qué cuenta: sólo lo que gastan los CLIENTES, o sea las filas de `bot_token_usage` con function_name = 'lk_whatsapp-webhook' (el agente y la lectura
// de archivos de pedido). El Simulador, el chat de prueba y el puntaje NO cuentan: sus gastos los gobierna la regla de "estimativo + sí" de Pablo y, si
// contaran, cada tanda de pruebas dejaría al bot en respuestas fijas (el 07/10 el Simulador gastó US$ 1,76 en un día).
// Medido el 07/10 sobre 10 días: promedio US$ 1,57 por día entre pruebas y clientes, clientes reales US$ 0,03 por día (con Gemini gratis de #1).
// ⚠ Ese mismo día Sonnet volvió a ser el #1 de la cadena (ESTADO): una llamada cuesta unos US$ 0,04 y un turno con herramientas unos US$ 0,10, así que
// US$ 2 son unos 20 turnos o 50 llamadas por día. La estimación de ESTADO para producción es US$ 18 por mes, o sea US$ 0,60 por día (~12 consultas por
// día, la mitad con IA; es una estimación, sin tráfico real): el tope queda a unas 3 veces un día normal y un día con el doble de tráfico ya pasa el aviso.
// Es un monto para revisar con tráfico real; se cambia sin deploy (app_settings).
//
// Qué hace:
//   • "aviso" (gasto >= aviso): una alerta para una persona, UNA vez por día (motivo `tope_gasto`, nivel `aviso`). El agente sigue contestando.
//   • "tope"  (gasto >= tope): el agente NO se llama más ese día y la lectura de archivos de pedido tampoco. A cada cliente que escribe se le avisa UNA vez
//     por día con un texto fijo y se deja una alerta para una persona (nivel `tope`) para que le conteste. Las FAQ y los flujos sin IA siguen igual.
//   • El día es el de Argentina (00:00 a 24:00, UTC-3 todo el año): a las 00:00 vuelve solo.
//   • Ante un error al leer el gasto NO se bloquea (se prefiere atender de más que dejar mudo a un cliente), igual que la blacklist.
//
// Los montos se cambian sin deploy en app_settings: `ia_tope_gasto_usd` (defecto 2; 0 apaga el tope) y `ia_aviso_gasto_usd` (defecto 1; 0 apaga el aviso).
// Módulo puro (sin red ni base). Se prueba en tests/tope-gasto.test.ts.

export const TOPE_GASTO_USD_DEFAULT = 2;
export const AVISO_GASTO_USD_DEFAULT = 1;
/** `bot_token_usage.function_name` de lo que gastan los clientes (el webhook, no el Simulador ni el chat de prueba). */
export const FUNCION_CLIENTES = "lk_whatsapp-webhook";
/** Cuánto se reutiliza la suma del gasto en un isolate antes de volver a leerla (un pasaje de tope se detecta con este retraso como máximo). */
export const CACHE_GASTO_MS = 30_000;

export type NivelGasto = "ok" | "aviso" | "tope";
export interface Topes { tope: number; aviso: number }

const HORA_MS = 3_600_000;
const OFFSET_ART_MS = -3 * HORA_MS; // Argentina, UTC-3 todo el año (igual que tope-ia.ts y horario.ts)

/** Instante (ms UTC) en que empezó el día de Argentina al que pertenece `ahoraMs`: las 00:00 ART son las 03:00 UTC. */
export function inicioDiaArgentina(ahoraMs: number): number {
  const local = ahoraMs + OFFSET_ART_MS; // "ms locales": se leen con getUTC*
  return Math.floor(local / 86_400_000) * 86_400_000 - OFFSET_ART_MS;
}

/** Un monto de app_settings: acepta "2", "2.5" y "2,5". Vacío, ausente, no numérico o negativo → el valor por defecto. 0 es válido (apaga). */
function monto(crudo: unknown, porDefecto: number): number {
  if (crudo === null || crudo === undefined) return porDefecto;
  const t = String(crudo).trim().replace(",", ".");
  if (!t) return porDefecto;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
}

/** Tope y aviso a partir de lo guardado en app_settings (`ia_tope_gasto_usd`, `ia_aviso_gasto_usd`). */
export function topesDeSettings(topeCrudo: unknown, avisoCrudo: unknown): Topes {
  return { tope: monto(topeCrudo, TOPE_GASTO_USD_DEFAULT), aviso: monto(avisoCrudo, AVISO_GASTO_USD_DEFAULT) };
}

/** Suma el costo de las filas de `bot_token_usage` (numeric llega como texto desde PostgREST). Lo que no es número cuenta 0. */
export function sumarGasto(filas: ReadonlyArray<{ estimated_cost_usd?: unknown } | null | undefined>): number {
  let t = 0;
  for (const f of filas) {
    const n = Number(f?.estimated_cost_usd);
    if (Number.isFinite(n) && n > 0) t += n;
  }
  return t;
}

/** En qué nivel está el gasto del día. Un tope en 0 apaga todo (nada se corta); un aviso en 0 apaga sólo el aviso. */
export function nivelDeGasto(gasto: number, t: Topes): NivelGasto {
  if (!(t.tope > 0)) return "ok";
  if (gasto >= t.tope) return "tope";
  if (t.aviso > 0 && gasto >= t.aviso) return "aviso";
  return "ok";
}

/**
 * Lo que se le dice al cliente cuando el agente ya no atiende por hoy. Sin montos ni explicaciones internas: no es un error suyo y no tiene que
 * enterarse del gasto. No promete un horario (lo contesta una persona cuando pueda).
 */
export const MSG_TOPE_GASTO =
  "En este momento no podemos responder tu consulta de forma automática. Ya le avisamos a una persona del equipo para que te escriba en cuanto pueda.";

const usd = (n: number) => (Math.round(n * 100) / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Contexto de la alerta para una persona (motivo `tope_gasto`, Configuración › Derivaciones). Sin `urgente`: lo decide `notificarHumano` por el
 * texto. `nivel` distingue el aviso (el agente sigue) del tope (el agente se cortó y este cliente quedó sin respuesta de IA).
 */
export function contextoAlertaGasto(
  nivel: Exclude<NivelGasto, "ok">, gasto: number, t: Topes, texto: string, razonSocial: string | null | undefined,
): Record<string, unknown> {
  const detalle = nivel === "aviso"
    ? `El gasto de IA de los clientes hoy ya llegó a US$ ${usd(gasto)} (el aviso es a US$ ${usd(t.aviso)}, el tope a US$ ${usd(t.tope)}). El agente sigue contestando: ` +
      "mirá qué lo está gastando (¿cayó el modelo gratis a uno pago?, ¿un bucle?) antes de que llegue al tope."
    : `El gasto de IA de los clientes hoy llegó al tope de US$ ${usd(t.tope)} (va en US$ ${usd(gasto)}). El agente no contesta más hasta las 00:00 y este cliente ` +
      "recibió un aviso fijo: mirá el chat y contestale vos.";
  return {
    motivo: "tope_gasto",
    nivel,
    gasto_usd: Math.round(gasto * 10_000) / 10_000,
    tope_usd: t.tope,
    aviso_usd: t.aviso,
    detalle,
    texto_recibido: String(texto ?? "").slice(0, 200),
    razon_social: razonSocial ?? null,
  };
}
