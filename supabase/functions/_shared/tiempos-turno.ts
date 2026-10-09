// _shared/tiempos-turno.ts — tiempo de punta a punta de cada respuesta del bot (Pablo Olejavetzky, 09/10/2026).
//
// Pedido: medir si el bot contesta en 3 a 6 s (docs/REQUERIMIENTOS-AGENTE-2026-10-09.md). Hasta acá no había forma:
// `wa_conversations` graba la pregunta y la respuesta juntas (0,0 s en las 156 filas) y `bot_llm_intentos` sólo mide
// el modelo. Esto anota, por mensaje entrante, cuándo llegó y cuándo Meta aceptó cada respuesta, y lo guarda en
// `wa_turno_tiempos` (sql/136).
//
// Cómo se enganchan los envíos: TODO POST a Meta sale por `waPost` (_shared/wa-api.ts), que llama a `registrarEnvio`
// con el `to` del mensaje. Un turno se busca por teléfono (últimos 10 dígitos). En las edges que no abren turnos
// (lk_outbox-flush, lk_templates…) no hay ninguno abierto y `registrarEnvio` no hace nada.
//
// Dos mensajes del mismo número procesándose a la vez (una ráfaga): los envíos van al turno abierto más reciente y
// los dos quedan con `concurrente = true`, para poder dejarlos afuera de la medición. Nunca lanza.

// Sin imports a propósito: wa-api.ts lo importa y no debe arrastrar el cliente de Supabase. `guardarTurno` recibe el cliente.

export interface Turno {
  wamid: string;
  phone: string;
  tipo: string;
  metaTs: number | null;        // ms, del `timestamp` del mensaje según Meta (precisión de 1 s)
  recibidoMs: number;           // ms, cuando el POST entró al webhook
  primerEnvioMs: number | null; // ms, cuando Meta aceptó la primera respuesta
  ultimoEnvioMs: number | null;
  envios: number;
  envioMs: number;              // suma del tiempo dentro de los POST a Meta (incluye la consulta de wa-guard)
  iaInicioMs: number | null;
  iaMs: number;                 // tiempo dentro de runConversation
  concurrente: boolean;
}

const abiertos = new Map<string, Turno[]>();

export function clave(phone: string): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-10);
}

/** Abre el turno de un mensaje entrante. `metaTimestamp` es el string en segundos que manda Meta. */
export function abrirTurno(
  p: { wamid: string; phone: string; tipo: string; metaTimestamp?: string | null; recibidoMs: number },
): Turno {
  const seg = Number(p.metaTimestamp);
  const t: Turno = {
    wamid: p.wamid, phone: p.phone, tipo: p.tipo,
    metaTs: Number.isFinite(seg) && seg > 0 ? seg * 1000 : null,
    recibidoMs: p.recibidoMs,
    primerEnvioMs: null, ultimoEnvioMs: null, envios: 0, envioMs: 0,
    iaInicioMs: null, iaMs: 0, concurrente: false,
  };
  const k = clave(p.phone);
  const lista = abiertos.get(k) ?? [];
  if (lista.length) { t.concurrente = true; for (const o of lista) o.concurrente = true; }
  lista.push(t);
  abiertos.set(k, lista);
  return t;
}

function activo(phone: string): Turno | undefined {
  const lista = abiertos.get(clave(phone));
  return lista?.[lista.length - 1];
}

/** Lo llama waPost cuando Meta aceptó un mensaje a `to`. `inicio` y `fin` en ms. */
export function registrarEnvio(to: string, inicio: number, fin: number): void {
  const t = activo(to);
  if (!t) return;
  t.envios++;
  t.envioMs += Math.max(0, fin - inicio);
  if (t.primerEnvioMs === null) t.primerEnvioMs = fin;
  t.ultimoEnvioMs = fin;
}

export function iaEmpieza(phone: string, ahora = Date.now()): void {
  const t = activo(phone);
  if (t) t.iaInicioMs = ahora;
}

export function iaTermina(phone: string, ahora = Date.now()): void {
  const t = activo(phone);
  if (t && t.iaInicioMs !== null) { t.iaMs += Math.max(0, ahora - t.iaInicioMs); t.iaInicioMs = null; }
}

/** Saca el turno de los abiertos (sin guardarlo). */
export function cerrarTurno(t: Turno): void {
  const k = clave(t.phone);
  const lista = (abiertos.get(k) ?? []).filter((o) => o !== t);
  if (lista.length) abiertos.set(k, lista); else abiertos.delete(k);
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Fila para `wa_turno_tiempos`. */
export function filaTurno(t: Turno, finMs: number, error: string | null = null): Record<string, unknown> {
  return {
    wamid: t.wamid,
    phone: t.phone,
    tipo: t.tipo,
    meta_at: iso(t.metaTs),
    recibido_at: iso(t.recibidoMs),
    primer_envio_at: iso(t.primerEnvioMs),
    ultimo_envio_at: iso(t.ultimoEnvioMs),
    fin_at: iso(finMs),
    envios: t.envios,
    envio_ms: Math.round(t.envioMs),
    ia: t.iaMs > 0 || t.iaInicioMs !== null,
    ia_ms: Math.round(t.iaMs),
    concurrente: t.concurrente,
    error: error ? error.slice(0, 300) : null,
  };
}

/** Cierra el turno y lo guarda. Nunca lanza: una medición que falla no puede tocar la respuesta al cliente. */
// deno-lint-ignore no-explicit-any
export async function guardarTurno(sb: any, t: Turno, error: string | null = null): Promise<void> {
  cerrarTurno(t);
  try {
    const { error: e } = await sb.from("wa_turno_tiempos").insert(filaTurno(t, Date.now(), error));
    if (e) console.error("[tiempos] no se pudo guardar:", e.message);
  } catch (e) {
    console.error("[tiempos] no se pudo guardar:", e instanceof Error ? e.message : e);
  }
}
