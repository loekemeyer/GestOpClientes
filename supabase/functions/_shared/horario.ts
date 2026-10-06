// Horario de atención telefónica (Pablo Olejavetzky, 06/10/2026: "de lunes a viernes de 9 a 17 es el horario"). Módulo PURO (sin red ni base):
// se prueba en tests/horario.test.ts. Se guarda en app_settings.wa_derivaciones.horario y se edita en Configuración › Derivaciones.
//
// Para qué sirve:
//   1. Los tiempos de respuesta del semáforo (🔴 20 min · 🟡 2 h · 🟢 4 h) cuentan SÓLO dentro del horario (si `solo_en_horario`): una alerta
//      🔴 que entra el viernes a las 16:50 vence el lunes a las 9:10, no el viernes a las 17:10 (sumarMinutosHabiles).
//   2. Si un cliente que necesita a una persona escribe fuera de horario, el bot le avisa cuándo se le va a responder (textoAviso).
// Un solo tramo por día (sin corte de almuerzo). Zona horaria: Argentina, UTC-3 todo el año (no hay horario de verano).

export type Horario = {
  /** Días de atención, 1 = lunes … 7 = domingo. */
  dias: number[];
  /** "HH:MM" de apertura y de cierre (el cierre ya no es horario de atención). */
  desde: string;
  hasta: string;
  /** Fechas "AAAA-MM-DD" en las que no se atiende aunque sea día de atención. */
  feriados: string[];
  /** true = los tiempos de respuesta cuentan sólo dentro del horario. */
  solo_en_horario: boolean;
  /** true = los "puentes turísticos no laborables" del calendario de Planify también cuentan como días sin atención. Por defecto SÍ (Pablo, 06/10:
   *  "ante la duda vos cerralo siempre"): un puente no es feriado y se podría abrir, pero ante la duda se da por cerrado. */
  incluir_puentes: boolean;
};

export const HORARIO_DEFECTO: Readonly<Horario> = { dias: [1, 2, 3, 4, 5], desde: "09:00", hasta: "17:00", feriados: [], solo_en_horario: true, incluir_puentes: true };
export const MAX_FERIADOS = 60;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutosDe = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const fechaValida = (x: unknown): x is string =>
  typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) && new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x;

/** Valida lo que manda el panel. Devuelve el horario limpio, o el error en criollo. */
export function validarHorario(v: unknown): { ok: true; horario: Horario } | { ok: false; error: string } {
  if (!v || typeof v !== "object") return { ok: false, error: "Falta el horario de atención." };
  const o = v as Record<string, unknown>;
  const dias = Array.isArray(o.dias) ? [...new Set(o.dias.map(Number))].sort((a, b) => a - b) : [];
  if (!dias.length || dias.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return { ok: false, error: "Elegí al menos un día de atención." };
  const desde = String(o.desde ?? ""), hasta = String(o.hasta ?? "");
  if (!HHMM.test(desde) || !HHMM.test(hasta)) return { ok: false, error: "El horario tiene que ser HH:MM (por ejemplo 09:00 y 17:00)." };
  if (minutosDe(desde) >= minutosDe(hasta)) return { ok: false, error: "La hora de cierre tiene que ser posterior a la de apertura." };
  const fer = o.feriados === undefined || o.feriados === null ? [] : o.feriados;
  if (!Array.isArray(fer) || fer.length > MAX_FERIADOS) return { ok: false, error: `Los feriados son una lista de hasta ${MAX_FERIADOS} fechas.` };
  const malo = fer.find((f) => !fechaValida(f));
  if (malo !== undefined) return { ok: false, error: `Feriado inválido: «${String(malo)}» (usá AAAA-MM-DD).` };
  if (o.solo_en_horario !== undefined && typeof o.solo_en_horario !== "boolean") return { ok: false, error: "«Contar sólo en horario» tiene que ser sí o no." };
  if (o.incluir_puentes !== undefined && typeof o.incluir_puentes !== "boolean") return { ok: false, error: "«Contar los puentes» tiene que ser sí o no." };
  return { ok: true, horario: { dias, desde, hasta, feriados: [...new Set(fer as string[])].sort(), solo_en_horario: o.solo_en_horario !== false, incluir_puentes: o.incluir_puentes !== false } };
}

/** Lee lo guardado, sin quejarse: lo inválido o ausente queda en el valor por defecto. */
export function leerHorario(v: unknown): Horario {
  const d: Horario = { ...HORARIO_DEFECTO, dias: [...HORARIO_DEFECTO.dias], feriados: [] };
  if (!v || typeof v !== "object") return d;
  const o = v as Record<string, unknown>;
  const r = validarHorario({ dias: o.dias, desde: o.desde, hasta: o.hasta, feriados: [], solo_en_horario: o.solo_en_horario, incluir_puentes: o.incluir_puentes });
  if (r.ok) { d.dias = r.horario.dias; d.desde = r.horario.desde; d.hasta = r.horario.hasta; d.solo_en_horario = r.horario.solo_en_horario; d.incluir_puentes = r.horario.incluir_puentes; }
  else {
    // Se rescata lo que sí sirve: días válidos por un lado, horas válidas por otro.
    const dias = Array.isArray(o.dias) ? [...new Set(o.dias.map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 7).sort((a, b) => a - b) : [];
    if (dias.length) d.dias = dias;
    if (HHMM.test(String(o.desde)) && HHMM.test(String(o.hasta)) && minutosDe(String(o.desde)) < minutosDe(String(o.hasta))) { d.desde = String(o.desde); d.hasta = String(o.hasta); }
    if (typeof o.solo_en_horario === "boolean") d.solo_en_horario = o.solo_en_horario;
    if (typeof o.incluir_puentes === "boolean") d.incluir_puentes = o.incluir_puentes;
  }
  if (Array.isArray(o.feriados)) d.feriados = [...new Set(o.feriados.filter(fechaValida))].sort().slice(0, MAX_FERIADOS);
  return d;
}

// Horario vigente: se vuelca desde wa_derivaciones cada vez que se lee esa fila (igual que los semáforos y sus tiempos) y cada vuelco
// REEMPLAZA al anterior.
let vigente: Horario = leerHorario(undefined);
export function registrarHorario(v: unknown): void { vigente = leerHorario(v); }
export const horarioVigente = (): Horario => ({ ...vigente, dias: [...vigente.dias], feriados: [...vigente.feriados] });

// ── Feriados del calendario de Planify (Pablo, 06/10: "hay un calendario en el Planify, podés tomar ahí la data") ──
// planify.feriados (cron diario desde argentinadatos) trae `fecha`, `nombre` y `tipo`: "nacional", "trasladable" o "puente" (un puente turístico
// NO LABORABLE: el comercio podría abrir, pero ante la duda se da por cerrado: cuenta mientras `incluir_puentes` siga en su valor por defecto, que es sí;
// destildándolo en el panel deja de contar). Se leen en vivo (feriados.ts) y se suman a
// los que se cargan a mano en `horario.feriados`; así no hay que mantenerlos en dos lados.
export type FeriadoCalendario = { fecha: string; nombre?: string; tipo?: string };

/** Fechas del calendario que valen como día sin atención para este horario (lo inválido se ignora; los puentes sólo si `incluir_puentes`). */
export function feriadosDelCalendario(h: Pick<Horario, "incluir_puentes">, filas: FeriadoCalendario[]): string[] {
  const out = new Set<string>();
  for (const f of filas ?? []) {
    if (!fechaValida(f?.fecha)) continue;
    if (f.tipo === "puente" && !h.incluir_puentes) continue;
    out.add(f.fecha);
  }
  return [...out].sort();
}
/** El horario con los feriados del calendario sumados a los manuales: el que se usa para CONTAR (vencimientos, aviso al cliente). */
export function conCalendario(h: Horario, filas: FeriadoCalendario[]): Horario {
  return { ...h, dias: [...h.dias], feriados: [...new Set([...h.feriados, ...feriadosDelCalendario(h, filas)])].sort() };
}
// Calendario vigente: se vuelca desde feriados.ts cada vez que se lee (y REEMPLAZA al anterior).
let calendario: FeriadoCalendario[] = [];
export function registrarCalendario(filas: unknown): void {
  calendario = Array.isArray(filas) ? (filas as FeriadoCalendario[]).filter((f) => fechaValida(f?.fecha)) : [];
}
export const calendarioVigente = (): FeriadoCalendario[] => calendario.map((f) => ({ ...f }));
/** Horario efectivo: el guardado + el calendario de Planify. */
export const horarioEfectivo = (): Horario => conCalendario(horarioVigente(), calendario);

// ── Cuentas con la hora de Argentina ──
const OFFSET_MS = -3 * 3_600_000; // UTC-3
const DIA_MS = 86_400_000;
const aLocal = (d: Date) => d.getTime() + OFFSET_MS;               // "ms locales": se leen con getUTC*
const inicioDia = (ms: number) => Math.floor(ms / DIA_MS) * DIA_MS; // inicio del día local, en ms locales
const deLocal = (ms: number) => new Date(ms - OFFSET_MS);
const isoDow = (msDia: number) => { const d = new Date(msDia).getUTCDay(); return d === 0 ? 7 : d; };
const ymd = (msDia: number) => new Date(msDia).toISOString().slice(0, 10);
const atiende = (h: Horario, msDia: number) => h.dias.includes(isoDow(msDia)) && !h.feriados.includes(ymd(msDia));

/** ¿Es horario de atención en ese momento? (la hora de cierre ya no cuenta). */
export function dentroDeHorario(ahora: Date, h: Horario): boolean {
  const l = aLocal(ahora), dia = inicioDia(l);
  if (!atiende(h, dia)) return false;
  const m = (l - dia) / 60_000;
  return m >= minutosDe(h.desde) && m < minutosDe(h.hasta);
}

/** Primer momento de atención desde `ahora`: el mismo `ahora` si ya se atiende, si no la próxima apertura. */
export function proximaApertura(ahora: Date, h: Horario): Date {
  if (dentroDeHorario(ahora, h)) return ahora;
  const l = aLocal(ahora), dia = inicioDia(l);
  for (let i = 0; i < 800; i++) {
    const d = dia + i * DIA_MS;
    if (!atiende(h, d)) continue;
    const apertura = d + minutosDe(h.desde) * 60_000;
    if (apertura >= l) return deLocal(apertura);
  }
  return ahora; // no se llega: hay al menos un día de atención y los feriados son 60 como mucho
}

/**
 * Vencimiento de una alerta: `minutos` de tiempo de ATENCIÓN a partir de `desde`. Si el horario no manda (`solo_en_horario` falso), es
 * `desde + minutos` corrido. Lo que cae fuera del horario no cuenta: empieza a correr en la próxima apertura.
 */
export function sumarMinutosHabiles(desde: Date, minutos: number, h: Horario): Date {
  const total = Math.max(0, minutos);
  if (!h.solo_en_horario) return new Date(desde.getTime() + total * 60_000);
  let t = desde, resto = total;
  for (let i = 0; i < 2000; i++) {
    t = proximaApertura(t, h);
    const cierre = deLocal(inicioDia(aLocal(t)) + minutosDe(h.hasta) * 60_000);
    const disponible = (cierre.getTime() - t.getTime()) / 60_000;
    if (resto <= disponible) return new Date(t.getTime() + resto * 60_000);
    resto -= disponible;
    t = cierre;
  }
  return new Date(desde.getTime() + total * 60_000);
}

// ── Textos ──
const NOMBRE_DIA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const hora = (hhmm: string) => { const m = minutosDe(hhmm) % 60; return m ? `${Number(hhmm.slice(0, 2))}:${hhmm.slice(3)}` : String(Number(hhmm.slice(0, 2))); };

/** "lunes a viernes", "lunes, miércoles y viernes", "sábado y domingo". */
export function textoDias(dias: number[]): string {
  const ds = [...new Set(dias)].sort((a, b) => a - b);
  const tramos: number[][] = [];
  for (const d of ds) { const u = tramos[tramos.length - 1]; if (u && u[u.length - 1] === d - 1) u.push(d); else tramos.push([d]); }
  const partes = tramos.map((t) => t.length >= 3 ? `${NOMBRE_DIA[t[0] % 7]} a ${NOMBRE_DIA[t[t.length - 1] % 7]}` : t.map((d) => NOMBRE_DIA[d % 7]).join(" y "));
  return partes.length <= 1 ? (partes[0] ?? "") : `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
}
/** "lunes a viernes de 9 a 17 h". */
export const textoHorario = (h: Horario): string => `${textoDias(h.dias)} de ${hora(h.desde)} a ${hora(h.hasta)} h`;

/** Cuándo se va a poder responder, dicho para el cliente: "hoy desde las 9 h", "mañana desde las 9 h", "el lunes desde las 9 h". */
export function textoCuando(ahora: Date, h: Horario): string {
  const ap = proximaApertura(ahora, h);
  const dif = Math.round((inicioDia(aLocal(ap)) - inicioDia(aLocal(ahora))) / DIA_MS);
  const desde = `desde las ${hora(h.desde)} h`;
  if (dif <= 0) return `hoy ${desde}`;
  if (dif === 1) return `mañana ${desde}`;
  return `el ${NOMBRE_DIA[isoDow(inicioDia(aLocal(ap))) % 7]} ${desde}`;
}

// ── Aviso al cliente fuera de horario ──
export const PREFIJO_AVISO = "Ahora estamos fuera del horario de atención";
/** Motivos de alerta que NO esperan que una persona le conteste al cliente: no se le avisa nada. */
const SIN_AVISO = new Set(["comprobante_recibido", "adjunto_recibido", "llm_timeout", "llm_error", "blacklist", "whitelist_gate"]);
export const esperaRespuestaDePersona = (categoria: string): boolean => !SIN_AVISO.has(categoria);
export function textoAviso(ahora: Date, h: Horario): string {
  return `${PREFIJO_AVISO} (${textoHorario(h)}). Tu consulta quedó registrada y te respondemos ${textoCuando(ahora, h)}.`;
}
