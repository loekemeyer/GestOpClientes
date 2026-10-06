// Categorías y vencimiento de las alertas para humanos (wa_alertas_humano).
// Lo usan lk_alertas (bandeja del dashboard) y lk_fallas-mail (mail de vencidas), así los dos
// calculan el mismo vencimiento. Minutos por categoría editables en app_settings.wa_alertas_vencimiento.

import { supabase } from "./supabase.ts";
import { nivelAuto, nivelDe, nivelFijo, registrarNiveles, registrarTiempos, tiempoDeNivel, type Nivel, urgenteDe } from "./semaforo.ts";
import { horarioEfectivo, registrarHorario, sumarMinutosHabiles } from "./horario.ts";
import { cargarCalendario } from "./feriados.ts";

export const SETTING_VENCIMIENTO = "wa_alertas_vencimiento";

// Nombre visible y vencimiento por defecto (minutos) de cada categoría.
export const CATEGORIAS: Record<string, { label: string; min: number; extra?: boolean }> = {
  cliente_molesto:        { label: "Cliente molesto", min: 30 },
  respuesta_aviso_cambio: { label: "Cambio o cancelación de pedido (respuesta a un aviso)", min: 60 },
  escalation:             { label: "Pidió hablar con una persona", min: 120 },
  comprobante_recibido:   { label: "Comprobante de pago recibido", min: 240 },
  comprobante_error:      { label: "Comprobante de pago con error", min: 120 },
  llm_timeout:            { label: "El bot no llegó a responder", min: 30 },
  llm_error:              { label: "El bot falló al responder", min: 30 },
  alta_cliente:           { label: "Alta de cliente nuevo", min: 1440 },
  blacklist:              { label: "Escribió un número bloqueado", min: 1440 },
  faq_no_match:           { label: "Pregunta sin respuesta", min: 240 },
  consulta_stock:         { label: "Consulta de stock sin disponibilidad", min: 120 },
  pedido_archivo:         { label: "Pedido por archivo (Excel, foto o PDF)", min: 120 },
  pedido_whatsapp:        { label: "Pedido por WhatsApp para confirmar", min: 120 },
  cambio_datos:           { label: "Dirección de entrega nueva", min: 240 },
  reseteo_clave:          { label: "Pide clave nueva para la web", min: 60 },
  acceso_web:             { label: "Problema con la web (acceso o sucursal)", min: 120 },
  adjunto_recibido:       { label: "Mandó un archivo (Excel, foto, PDF o audio)", min: 120 },
  // sql/115 (Pablo, 01/10): cliente sólo de Chef con una consulta que el bot todavía no responde (_shared/chef.ts).
  cliente_chef:           { label: "Cliente de Chef: consulta para una persona", min: 120 },
  // Motivos que elige la IA al derivar (herramienta derivar_a_persona, 29/09).
  reclamo:                { label: "Reclamo: NC, faltante, rotura o factura", min: 120 },
  pago:                   { label: "Pago o importe", min: 120 },
  cambio_pedido:          { label: "Cambio de artículos de un pedido", min: 60 },
  anulacion_pedido:       { label: "Anulación de pedido", min: 60 },
  pedido_no_encontrado:   { label: "Pedido que no aparece", min: 60 },
  entrega:                { label: "Entrega: sin fecha, no llegó o fecha distinta", min: 120 },
  excepcion_minimo:       { label: "Pide una excepción al pedido mínimo", min: 240 },
  // Pablo, 06/10 (corrección m66): quiere devolver mercadería. Respuesta fija en faq.ts (RE_DEVOLUCION); por ahora la maneja Ventas.
  devolucion:             { label: "Devolución de mercadería", min: 120 },
  otro:                   { label: "Otros", min: 240 },
  whitelist_gate:         { label: "Número fuera de la lista de prueba", min: 1440 },
};

// deno-lint-ignore no-explicit-any
export function categoria(a: any): string {
  const motivo = String(a?.contexto?.motivo ?? "");
  if (motivo && CATEGORIAS[motivo]) return motivo;
  if (a?.contexto?.lead_id || motivo === "alta") return "alta_cliente";
  return CATEGORIAS[a?.tipo] ? a.tipo : "otro";
}

// Motivos agregados desde Configuración › Derivaciones (app_settings.wa_derivaciones.extra): se suman a
// CATEGORIAS en memoria para que categoria(), el vencimiento y los nombres los reconozcan.
export type MotivoExtra = { clave: string; nombre: string; cuando: string; min: number };
export function registrarExtras(extra: unknown): MotivoExtra[] {
  const out: MotivoExtra[] = [];
  for (const e of Array.isArray(extra) ? extra : []) {
    const clave = String(e?.clave ?? "").trim();
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(clave)) continue;
    const m: MotivoExtra = { clave, nombre: String(e?.nombre ?? clave).slice(0, 80), cuando: String(e?.cuando ?? "").slice(0, 300), min: Number(e?.min) > 0 ? Math.round(Number(e.min)) : 120 };
    if (!CATEGORIAS[clave] || CATEGORIAS[clave].extra) {
      CATEGORIAS[clave] = { label: m.nombre, min: m.min, extra: true };
    }
    out.push(m);
  }
  return out;
}

export async function vencimientos(): Promise<Record<string, number>> {
  const { data: filas } = await supabase.from("app_settings").select("key, value").in("key", [SETTING_VENCIMIENTO, "wa_derivaciones"]);
  try {
    const w = JSON.parse(filas?.find((r) => r.key === "wa_derivaciones")?.value ?? "{}");
    registrarExtras(w?.extra);
    registrarNiveles(w?.motivos); // semáforos fijados en Derivaciones (06/10)
    registrarTiempos(w?.tiempos); // tiempo de respuesta de cada semáforo (06/10)
    registrarHorario(w?.horario); // horario de atención telefónica: los tiempos cuentan sólo dentro de él (06/10)
  } catch { /* sin extras ni semáforos fijos */ }
  await cargarCalendario(); // feriados de Planify (caché de 6 h, con tope de espera: nunca frena ni lanza)
  const base = Object.fromEntries(Object.entries(CATEGORIAS).map(([k, v]) => [k, v.min]));
  const data = filas?.find((r) => r.key === SETTING_VENCIMIENTO);
  try {
    const guardado = data?.value ? JSON.parse(data.value) : {};
    for (const [k, v] of Object.entries(guardado)) if (k in base && Number(v) > 0) base[k] = Number(v);
  } catch { /* JSON roto → defaults */ }
  return base;
}

// Urgencia y semáforo de una alerta (Pablo, 28/09): 🔴 rojo = urgente (cliente molesto, cambio/cancelación de pedido, comprobante
// con error, reclamo o apuro en el texto) · 🟡 amarillo = una persona tiene que contestar pronto (pidió hablar con alguien, consulta de
// stock sin disponibilidad) · 🟢 verde = puede esperar (comprobante recibido, alta de cliente, el resto). Desde el 06/10 cada motivo puede
// tener su semáforo fijado en Configuración › Derivaciones; la lógica vive en semaforo.ts (pura, con pruebas).
export type { Nivel };
export { nivelFijo, registrarNiveles, registrarTiempos };
export { MAX_TIEMPO_MIN, tiempoDeNivel, TIEMPOS_DEFECTO, tiemposVigentes } from "./semaforo.ts";
export const SEMAFORO: Record<Nivel, string> = { rojo: "🔴", amarillo: "🟡", verde: "🟢" };
// deno-lint-ignore no-explicit-any
export function urgente(a: any): boolean {
  return urgenteDe(categoria(a), a?.contexto ?? {});
}
// deno-lint-ignore no-explicit-any
export function nivel(a: any): Nivel {
  const cat = categoria(a);
  return nivelDe(cat, a?.contexto ?? {}, !!CATEGORIAS[cat]?.extra);
}
/** Minutos que tiene una alerta para responderse: el tiempo de SU semáforo (el fijado en Derivaciones o el Auto, con el mensaje apurado incluido). */
// deno-lint-ignore no-explicit-any
export function minutosDeVencimiento(a: any): number {
  return tiempoDeNivel(nivel(a));
}
/** Cuándo vence una alerta: sus minutos de respuesta contados en tiempo de ATENCIÓN (horario de Derivaciones; si no manda, corridos). */
// deno-lint-ignore no-explicit-any
export function venceAtDe(a: any): Date {
  return sumarMinutosHabiles(new Date(a.created_at), minutosDeVencimiento(a), horarioEfectivo()); // horario + feriados del calendario de Planify
}
/** Semáforo "Auto" de un motivo (el de siempre, sin el fijado a mano): es lo que muestra Derivaciones al lado de "Auto". */
export function nivelAutoDeMotivo(cat: string): Nivel {
  return nivelAuto(cat, {}, !!CATEGORIAS[cat]?.extra);
}
