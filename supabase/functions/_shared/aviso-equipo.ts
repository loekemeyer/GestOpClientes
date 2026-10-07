// Aviso por WhatsApp al EQUIPO (Pablo Olejavetzky, 07/10/2026: "los avisos que salen en el Planify también lleguen al WhatsApp, sobre todo a Ventas"
// y, ya con el panel a la vista: "agregues todo al panel de configuración, hoy prefiero que sobre y no que falte"). Módulo PURO (sin red ni base):
// lo usa lk_alerta-planify y lo configura Configuración › Derivaciones (lk_alertas). Se prueba en tests/aviso-equipo.test.ts.
//
// Dos momentos por alerta (cada motivo elige cuál, o los dos):
//   · INMEDIATO: se encola apenas nace la alerta (junto con la tarea de Planify, o sola si el motivo va sólo a Tareas).
//   · ESCALADA: el cartel de Planify va primero y el WhatsApp sale sólo si nadie "se encargó" al vencer el tiempo del semáforo (o el que se fije acá).
// Todo sale por la cola `wa_outbox` con una PLANTILLA (a Ventas no le escribió al bot en las últimas 24 h: texto libre fuera de la ventana lo rechaza
// Meta, error 131047) y por lo tanto pasa por la llave `wa_envio_automatico` (principio de la vasectomía, CLAUDE.md): con la llave en `prueba` sólo sale
// a los números de `wa_envio_contactos`; este módulo no decide si algo SALE, decide si se ENCOLA.
//
// Config: app_settings.wa_derivaciones.whatsapp = ConfigWa y, por motivo, wa_derivaciones.motivos[motivo].wa = ModoWa.
import { lineaSegura } from "./dato-externo.ts";
import { dentroDeHorario, type Horario, sumarMinutosHabiles } from "./horario.ts";
import type { Dest } from "./derivaciones-destino.ts";
import type { Nivel } from "./semaforo.ts";

export type { Nivel };
/** Qué avisa un motivo por WhatsApp: nada · apenas nace · sólo si nadie lo toma a tiempo · las dos cosas. */
export type ModoWa = "off" | "inmediato" | "escalada" | "ambos";
export const MODOS_WA: readonly ModoWa[] = ["off", "inmediato", "escalada", "ambos"];
export const esModoWa = (v: unknown): v is ModoWa => typeof v === "string" && (MODOS_WA as readonly string[]).includes(v);
/** Cuando el destino de una alerta es un SECTOR: a cada persona del sector, a la línea del sector, o a las dos. */
export type SectorWa = "personas" | "linea" | "ambos";
export const SECTORES_WA: readonly SectorWa[] = ["personas", "linea", "ambos"];
export type NumeroExtra = { nombre: string; telefono: string };

export type ConfigWa = {
  /** Interruptor general del panel. El corte real sigue siendo la llave wa_envio_automatico: apagado acá no se encola NADA, ni lo urgente. */
  activo: boolean;
  sector: SectorWa;
  /** Números que reciben TODO lo que se avise (además de los destinatarios de cada motivo). */
  extra: NumeroExtra[];
  /** true = fuera del horario de atención (Derivaciones › Horario) el aviso espera a la próxima apertura. */
  solo_horario: boolean;
  /** true = lo urgente (🔴) avisa por WhatsApp aunque su motivo diga "Sin WhatsApp" (igual que lo urgente va a Planify aunque el motivo diga "Sólo Tareas"). */
  urgentes_siempre: boolean;
  /** true = el aviso lleva lo que escribió el cliente, en una línea y sin enlaces (lineaSegura). false = "ver en Planify". */
  con_detalle: boolean;
  /** Minutos (de atención) sin que nadie tome el aviso antes de escalar, por semáforo. null = el tiempo de respuesta de ese semáforo. */
  escalada_min: Record<Nivel, number | null>;
  /** No avisa de alertas más viejas que esto (horas): evita una ráfaga de avisos viejos al prender la función. */
  max_edad_h: number;
  /** Máximo de avisos por hora a cada número (corta una ráfaga); lo que pasa del tope no se manda y queda anotado en la alerta. */
  tope_hora: number;
};

export const MAX_EXTRA = 10;
export const MAX_TIEMPO_ESCALADA = 43200;
export const MAX_EDAD_H = 720;
export const MAX_TOPE_HORA = 200;

// "Que sobre" (Pablo, 07/10): lo que no se toca avisa de más, no de menos.
export const CONFIG_WA_DEFECTO: Readonly<ConfigWa> = {
  activo: true, sector: "personas", extra: [], solo_horario: false, urgentes_siempre: true, con_detalle: true,
  escalada_min: { rojo: null, amarillo: null, verde: null }, max_edad_h: 48, tope_hora: 20,
};
const copia = (c: Readonly<ConfigWa>): ConfigWa => ({ ...c, extra: c.extra.map((x) => ({ ...x })), escalada_min: { ...c.escalada_min } });

// Motivos que avisan apenas nacen aunque nadie haya tocado nada: lo que cambia datos de una cuenta o da acceso (Pablo, 07/10: "cambio de algún dato
// para darle más seguridad"). Sin elección en el panel, ése es su modo. Si el motivo no existe en CATEGORIAS, no pasa nada.
export const SENSIBLES: ReadonlySet<string> = new Set(["cambio_datos", "reseteo_clave", "acceso_web"]);

/** Teléfono en formato Meta (sólo dígitos, con 549 para celulares argentinos). null si no parece un teléfono. Acepta "11 3118-1021", "011 3118 1021",
 *  "+54 9 11 3118-1021" y "54 11 3118 1021". */
export function canonTel(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "549" + d;
  else if (d.length === 12 && d.startsWith("54") && d[2] !== "9") d = "549" + d.slice(2);
  return d.length >= 12 && d.length <= 15 ? d : null;
}

/** Valida lo que manda el panel. Devuelve la config limpia, o el error en criollo. */
export function validarConfigWa(v: unknown): { ok: true; config: ConfigWa } | { ok: false; error: string } {
  if (!v || typeof v !== "object") return { ok: false, error: "Falta la configuración del aviso por WhatsApp." };
  const o = v as Record<string, unknown>;
  const bool = (k: string, def: boolean): boolean | null => (o[k] === undefined || o[k] === null ? def : typeof o[k] === "boolean" ? (o[k] as boolean) : null);
  const activo = bool("activo", true), solo = bool("solo_horario", false), urg = bool("urgentes_siempre", true), det = bool("con_detalle", true);
  if (activo === null || solo === null || urg === null || det === null) return { ok: false, error: "Los interruptores del aviso por WhatsApp tienen que ser sí o no." };
  const sector = o.sector === undefined || o.sector === null || o.sector === "" ? "personas" : String(o.sector);
  if (!(SECTORES_WA as readonly string[]).includes(sector)) return { ok: false, error: "«Cuando el destino es un sector» tiene que ser personas, línea o las dos." };
  const esc = { rojo: null, amarillo: null, verde: null } as Record<Nivel, number | null>;
  const e = (o.escalada_min ?? {}) as Record<string, unknown>;
  for (const n of ["rojo", "amarillo", "verde"] as Nivel[]) {
    const x = e[n];
    if (x === undefined || x === null || x === "") continue;
    const m = Math.round(Number(x));
    if (!(m >= 1 && m <= MAX_TIEMPO_ESCALADA)) return { ok: false, error: `El tiempo de escalada del semáforo ${n} tiene que estar entre 1 minuto y 30 días.` };
    esc[n] = m;
  }
  const edad = o.max_edad_h === undefined || o.max_edad_h === null || o.max_edad_h === "" ? CONFIG_WA_DEFECTO.max_edad_h : Math.round(Number(o.max_edad_h));
  if (!(edad >= 1 && edad <= MAX_EDAD_H)) return { ok: false, error: `«No avisar de alertas con más de» va de 1 a ${MAX_EDAD_H} horas.` };
  const tope = o.tope_hora === undefined || o.tope_hora === null || o.tope_hora === "" ? CONFIG_WA_DEFECTO.tope_hora : Math.round(Number(o.tope_hora));
  if (!(tope >= 1 && tope <= MAX_TOPE_HORA)) return { ok: false, error: `El tope de avisos por hora va de 1 a ${MAX_TOPE_HORA}.` };
  const lista = o.extra === undefined || o.extra === null ? [] : o.extra;
  if (!Array.isArray(lista) || lista.length > MAX_EXTRA) return { ok: false, error: `Los números adicionales son hasta ${MAX_EXTRA}.` };
  const extra: NumeroExtra[] = [];
  for (const x of lista as Array<Record<string, unknown>>) {
    const nombre = lineaSegura(x?.nombre, 40), tel = canonTel(x?.telefono);
    if (!nombre) return { ok: false, error: "A cada número adicional le falta el nombre." };
    if (!tel) return { ok: false, error: `El teléfono de «${nombre}» no parece válido (código de área y número, por ejemplo 11 3118 1021).` };
    if (!extra.some((y) => y.telefono === tel)) extra.push({ nombre, telefono: tel });
  }
  return { ok: true, config: { activo, sector: sector as SectorWa, extra, solo_horario: solo, urgentes_siempre: urg, con_detalle: det, escalada_min: esc, max_edad_h: edad, tope_hora: tope } };
}

/** Lee lo guardado, sin quejarse: lo inválido o ausente queda en el valor por defecto (rescata lo que sí sirve, campo por campo). */
export function leerConfigWa(v: unknown): ConfigWa {
  const d = copia(CONFIG_WA_DEFECTO);
  if (!v || typeof v !== "object") return d;
  const o = v as Record<string, unknown>;
  const r = validarConfigWa(o);
  if (r.ok) return r.config;
  if (typeof o.activo === "boolean") d.activo = o.activo;
  if (typeof o.solo_horario === "boolean") d.solo_horario = o.solo_horario;
  if (typeof o.urgentes_siempre === "boolean") d.urgentes_siempre = o.urgentes_siempre;
  if (typeof o.con_detalle === "boolean") d.con_detalle = o.con_detalle;
  if ((SECTORES_WA as readonly string[]).includes(String(o.sector))) d.sector = o.sector as SectorWa;
  const e = (o.escalada_min ?? {}) as Record<string, unknown>;
  for (const n of ["rojo", "amarillo", "verde"] as Nivel[]) { const m = Math.round(Number(e[n])); if (m >= 1 && m <= MAX_TIEMPO_ESCALADA) d.escalada_min[n] = m; }
  const edad = Math.round(Number(o.max_edad_h)); if (edad >= 1 && edad <= MAX_EDAD_H) d.max_edad_h = edad;
  const tope = Math.round(Number(o.tope_hora)); if (tope >= 1 && tope <= MAX_TOPE_HORA) d.tope_hora = tope;
  if (Array.isArray(o.extra)) {
    for (const x of (o.extra as Array<Record<string, unknown>>).slice(0, MAX_EXTRA)) {
      const nombre = lineaSegura(x?.nombre, 40), tel = canonTel(x?.telefono);
      if (nombre && tel && !d.extra.some((y) => y.telefono === tel)) d.extra.push({ nombre, telefono: tel });
    }
  }
  return d;
}

/** Qué modo rige para un motivo: el que se eligió en el panel; sin elegir, lo sensible avisa apenas nace, lo que va a Planify avisa apenas nace y
 *  escala, y el resto no avisa. Lo urgente avisa aunque diga "off" si `urgentes_siempre`. Con la función apagada, nada. */
export function modoDeMotivo(cfg: ConfigWa, explicito: unknown, cat: string, o: { planify: boolean; urgente: boolean }): ModoWa {
  if (!cfg.activo) return "off";
  let m: ModoWa = esModoWa(explicito) ? explicito : SENSIBLES.has(cat) ? "inmediato" : o.planify ? "ambos" : "off";
  if (m === "off" && o.urgente && cfg.urgentes_siempre) m = "inmediato";
  return m;
}
export const avisaAlNacer = (m: ModoWa) => m === "inmediato" || m === "ambos";
export const avisaSiNadieToma = (m: ModoWa) => m === "escalada" || m === "ambos";

// ── Destinatarios ──
export type Persona = { id: number; nombre: string; telefono: string | null; department_id: number | null; activo: boolean };
export type Sector = { id: number; nombre: string; telefono: string | null };
export type Destinatario = { telefono: string; etiqueta: string; origen: "persona" | "sector" | "linea" | "extra" };

/** A quién se le manda: por cada destino de la alerta, la persona (si tiene teléfono) o el sector (cada persona activa con teléfono y/o la línea del
 *  sector, según la config), más los números adicionales. Sin repetidos (el primero gana). `sin_telefono` = personas a las que no se les pudo avisar. */
export function destinatarios(blancos: Dest[], personas: Persona[], sectores: Sector[], cfg: ConfigWa): { lista: Destinatario[]; sin_telefono: string[] } {
  const lista: Destinatario[] = [], sin: string[] = [];
  const poner = (telRaw: unknown, etiqueta: string, origen: Destinatario["origen"]) => {
    const telefono = canonTel(telRaw);
    if (!telefono) { if (!sin.includes(etiqueta)) sin.push(etiqueta); return; }
    if (!lista.some((x) => x.telefono === telefono)) lista.push({ telefono, etiqueta, origen });
  };
  for (const b of blancos) {
    if ("employee_id" in b) {
      const p = personas.find((x) => x.id === b.employee_id);
      if (p && p.activo !== false) poner(p.telefono, p.nombre, "persona");
      continue;
    }
    const s = sectores.find((x) => x.id === b.department_id);
    const nombre = s?.nombre ?? `sector #${b.department_id}`;
    if (cfg.sector !== "linea") for (const p of personas.filter((x) => x.department_id === b.department_id && x.activo !== false)) poner(p.telefono, nombre, "sector");
    if (cfg.sector !== "personas") poner(s?.telefono, nombre, "linea");
  }
  for (const x of cfg.extra) poner(x.telefono, x.nombre, "extra");
  return { lista, sin_telefono: sin };
}

// ── Plantillas ──
export const PLANTILLA_AVISO = "aviso_equipo";
export const PLANTILLA_SIN_TOMAR = "aviso_equipo_sin_tomar";
export const CONTEXTO_INM = "aviso_equipo_inm";
export const CONTEXTO_ESC = "aviso_equipo_esc";
/** Lo que cuenta el tope por hora: todo lo que la cola tenga con este prefijo en `context`. */
export const PREFIJO_CONTEXTO = "aviso_equipo_";

export type DatosAviso = { etiqueta: string; motivo: string; cliente: string; detalle: string | null; hace?: string };

// Meta no deja saltos de línea, tabulaciones ni 4 espacios seguidos dentro de una variable: lineaSegura deja una sola línea con espacios simples.
const campo = (t: unknown, max: number, vacio = "-") => lineaSegura(t, max) || vacio;

/** {{1}} para quién · {{2}} motivo · {{3}} cliente · {{4}} detalle (lo que escribió el cliente o "ver en Planify"). */
export function paramsInmediato(d: DatosAviso, cfg: Pick<ConfigWa, "con_detalle">): Record<string, string> {
  return { "1": campo(d.etiqueta, 40), "2": campo(d.motivo, 60), "3": campo(d.cliente, 60), "4": cfg.con_detalle ? campo(d.detalle, 120, "ver en Planify") : "ver en Planify" };
}
/** {{1}} hace cuánto · {{2}} motivo · {{3}} cliente · {{4}} detalle. */
export function paramsEscalada(d: DatosAviso, cfg: Pick<ConfigWa, "con_detalle">): Record<string, string> {
  return { "1": campo(d.hace, 30, "un rato"), "2": campo(d.motivo, 60), "3": campo(d.cliente, 60), "4": cfg.con_detalle ? campo(d.detalle, 120, "ver en Planify") : "ver en Planify" };
}

/** "45 min", "2 h", "2 h 30 min", "1 día 3 h". */
export function duracionTexto(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "un rato";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24), hr = h % 24;
  return `${d} ${d === 1 ? "día" : "días"}${hr ? ` ${hr} h` : ""}`;
}

// ── Estado en la alerta (idempotencia) ──
// contexto.wa_aviso = { inm: [tel…]  ya avisados apenas nació (definido = esa fase ya corrió, aunque sea con [])
//                       esc: [tel…]  ya avisados por escalada (idem)
//                       dif: true    el aviso inmediato espera a la apertura del horario
//                       omit: [tel…] no se mandaron por el tope por hora
//                       sin_tel: […] personas sin teléfono }
export type EstadoWa = { inm?: string[]; esc?: string[]; dif?: boolean; omit?: string[]; sin_tel?: string[] };
export const CLAVE_ESTADO = "wa_aviso";

type Ctx = Record<string, unknown> | null | undefined;
const comoLista = (x: unknown): string[] | undefined => (Array.isArray(x) ? x.map(String) : undefined);
export function leerEstadoWa(ctx: Ctx): EstadoWa {
  const e = ctx?.[CLAVE_ESTADO];
  if (!e || typeof e !== "object") return {};
  const o = e as Record<string, unknown>;
  const s: EstadoWa = {};
  const inm = comoLista(o.inm), esc = comoLista(o.esc), omit = comoLista(o.omit), sin = comoLista(o.sin_tel);
  if (inm) s.inm = inm; if (esc) s.esc = esc; if (omit) s.omit = omit; if (sin) s.sin_tel = sin;
  if (o.dif === true) s.dif = true;
  return s;
}
export function contextoConEstadoWa(ctx: Record<string, unknown>, e: EstadoWa): Record<string, unknown> {
  return { ...ctx, [CLAVE_ESTADO]: e };
}

/** Los destinatarios que todavía no recibieron esta fase. */
export const sinAvisar = (lst: Destinatario[], ya: string[] | undefined): Destinatario[] => lst.filter((x) => !(ya ?? []).includes(x.telefono));

/** Aplica el tope por hora: `enviadosUltimaHora[telefono]` = cuántos avisos ya salieron en la última hora. Dentro de la misma tanda también cuenta. */
export function aplicarTope(lst: Destinatario[], enviadosUltimaHora: Record<string, number>, tope: number): { enviar: Destinatario[]; omitidos: Destinatario[] } {
  const enviar: Destinatario[] = [], omitidos: Destinatario[] = [];
  const usados: Record<string, number> = { ...enviadosUltimaHora };
  for (const x of lst) {
    if ((usados[x.telefono] ?? 0) >= tope) { omitidos.push(x); continue; }
    usados[x.telefono] = (usados[x.telefono] ?? 0) + 1;
    enviar.push(x);
  }
  return { enviar, omitidos };
}

// ── Escalada ──
/** Cuándo se escala una alerta: `escalada_min[nivel]` (o, sin fijar, los minutos de su semáforo) contados en tiempo de atención. */
export function escaladaVence(creada: Date, nivel: Nivel, cfg: ConfigWa, minutosSemaforo: number, h: Horario): Date {
  return sumarMinutosHabiles(creada, cfg.escalada_min[nivel] ?? minutosSemaforo, h);
}

export type EntradaEscalada = { ahora: Date; creada: Date; vence: Date; tomadaPor: unknown; estado: EstadoWa; cfg: ConfigWa; h: Horario; modo: ModoWa };
/** ¿Hay que mandar ahora el aviso "sin tomar"? Una sola vez por alerta, si nadie se encargó, ya venció, no es demasiado vieja y (si se pidió) hay atención. */
export function debeEscalar(e: EntradaEscalada): boolean {
  if (!avisaSiNadieToma(e.modo) || e.estado.esc !== undefined) return false;
  if (String(e.tomadaPor ?? "").trim()) return false;
  if (e.ahora.getTime() < e.vence.getTime()) return false;
  if (e.ahora.getTime() - e.creada.getTime() > e.cfg.max_edad_h * 3_600_000) return false;
  if (e.cfg.solo_horario && !dentroDeHorario(e.ahora, e.h)) return false;
  return true;
}
/** ¿Hay que mandar ahora el aviso inmediato que quedó esperando la apertura? */
export function debeInmediatoDiferido(e: { ahora: Date; creada: Date; estado: EstadoWa; cfg: ConfigWa; h: Horario; modo: ModoWa }): boolean {
  if (!avisaAlNacer(e.modo) || e.estado.dif !== true || e.estado.inm !== undefined) return false;
  if (e.ahora.getTime() - e.creada.getTime() > e.cfg.max_edad_h * 3_600_000) return false;
  return !e.cfg.solo_horario || dentroDeHorario(e.ahora, e.h);
}
