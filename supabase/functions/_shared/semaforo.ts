// Semáforo de las alertas para humanos (🔴 urgente · 🟡 pronto · 🟢 puede esperar). Módulo PURO (sin red ni base): lo usa
// alertas-vencimiento.ts y se prueba en tests/semaforo.test.ts.
//
// Pablo Olejavetzky, 06/10/2026: "que se pueda cambiar el tipo de semáforo desde las derivaciones". Cada motivo puede tener su semáforo FIJO
// (app_settings.wa_derivaciones.motivos[motivo].nivel). Sin fijar, rige el de siempre ("Auto"): el que sale del motivo, y que además un mensaje
// puede subir a 🔴 si el cliente está molesto o apurado (contexto.urgente o el texto).
// Fijo manda sobre todo lo demás, también sobre el mensaje. 🔴 es lo mismo que "urgente": la tarea va a Planify aunque el motivo diga "Sólo Tareas".
import { esUrgente } from "./humor-reglas.ts";

export type Nivel = "rojo" | "amarillo" | "verde";
const NIVELES: ReadonlySet<string> = new Set(["rojo", "amarillo", "verde"]);
export const esNivel = (v: unknown): v is Nivel => typeof v === "string" && NIVELES.has(v);

// Semáforos fijados a mano. Se vuelcan desde wa_derivaciones cada vez que se lee esa fila (derivaciones() y vencimientos()),
// y cada vuelco REEMPLAZA el anterior: si se vuelve a "Auto" o se borra la fila, el fijo desaparece.
let fijos = new Map<string, Nivel>();
export function registrarNiveles(motivos: unknown): void {
  const m = new Map<string, Nivel>();
  if (motivos && typeof motivos === "object") {
    for (const [cat, r] of Object.entries(motivos as Record<string, unknown>)) {
      const n = (r as { nivel?: unknown } | null)?.nivel;
      if (esNivel(n)) m.set(cat, n);
    }
  }
  fijos = m;
}
// ── Tiempo de respuesta PROPIO de cada semáforo (Pablo, 06/10: "si es urgente 20 mins, pronto 2 hs y verde 4 hs") ──
// Antes el vencimiento era por motivo (30 min, 1 h, 24 h…). Ahora el tiempo lo manda el semáforo de la alerta: una alerta 🔴 vence a los 20 min sea
// del motivo que sea, y si un mensaje apurado sube un 🟢 a 🔴 pasa a vencer a los 20 min. Editable en Derivaciones (wa_derivaciones.tiempos).
export const TIEMPOS_DEFECTO: Readonly<Record<Nivel, number>> = { rojo: 20, amarillo: 120, verde: 240 };
/** Un tiempo de respuesta va de 1 minuto a 30 días. */
export const MAX_TIEMPO_MIN = 43200;
let tiempos: Record<Nivel, number> = { ...TIEMPOS_DEFECTO };
/** Vuelca los tiempos guardados. Lo que falte o sea inválido queda en el valor por defecto; cada vuelco REEMPLAZA al anterior. */
export function registrarTiempos(v: unknown): void {
  const t: Record<Nivel, number> = { ...TIEMPOS_DEFECTO };
  if (v && typeof v === "object") {
    for (const n of Object.keys(TIEMPOS_DEFECTO) as Nivel[]) {
      const m = Math.round(Number((v as Record<string, unknown>)[n]));
      if (m >= 1 && m <= MAX_TIEMPO_MIN) t[n] = m;
    }
  }
  tiempos = t;
}
/** Minutos que tiene para responderse una alerta de ese semáforo. */
export const tiempoDeNivel = (n: Nivel): number => tiempos[n];
export const tiemposVigentes = (): Record<Nivel, number> => ({ ...tiempos });

/** Semáforo fijado a mano para un motivo, o null si va en "Auto". */
export const nivelFijo = (cat: string): Nivel | null => fijos.get(cat) ?? null;

const CATEGORIAS_URGENTES = new Set(["cliente_molesto", "respuesta_aviso_cambio", "comprobante_error", "cambio_pedido"]);
const CATEGORIAS_AMARILLAS = new Set(["escalation", "consulta_stock", "faq_no_match", "llm_timeout", "llm_error",
  "reclamo", "devolucion", "pedido_mail", "tope_ia", "tope_gasto", "pago", "pedido_no_encontrado", "entrega", "adjunto_recibido", "acceso_web", "reseteo_clave", "pedido_archivo", "pedido_whatsapp"]);

type Ctx = Record<string, unknown>;

/** Urgencia "Auto": la que se guardó al crear la alerta (contexto.urgente) o, para las viejas, por motivo + texto. */
export function urgenteAuto(cat: string, ctx: Ctx): boolean {
  if (typeof ctx.urgente === "boolean") return ctx.urgente;
  const texto = String(ctx.texto_recibido ?? ctx.texto ?? "");
  return CATEGORIAS_URGENTES.has(cat) || (texto ? esUrgente(texto) : false);
}

/** Semáforo "Auto": 🔴 si es urgente · 🟡 si una persona tiene que contestar pronto (o es un motivo agregado desde el panel) · 🟢 el resto. */
export function nivelAuto(cat: string, ctx: Ctx, esExtra: boolean): Nivel {
  if (urgenteAuto(cat, ctx)) return "rojo";
  return CATEGORIAS_AMARILLAS.has(cat) || esExtra ? "amarillo" : "verde";
}

/** Urgencia efectiva: el semáforo fijo manda (🔴 = urgente); sin fijo, la "Auto". */
export function urgenteDe(cat: string, ctx: Ctx): boolean {
  const f = fijos.get(cat);
  return f ? f === "rojo" : urgenteAuto(cat, ctx);
}

/** Semáforo efectivo: el fijo, o el "Auto". */
export function nivelDe(cat: string, ctx: Ctx, esExtra: boolean): Nivel {
  return fijos.get(cat) ?? nivelAuto(cat, ctx, esExtra);
}
