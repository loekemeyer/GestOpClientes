// A dónde va cada caso que necesita a una persona (Pablo, 29/09: "un panel que nos muestre a dónde se deriva
// cada caso … dentro de configuración"). Lo leen lk_alerta-planify (crea la tarea), lk_alertas (el panel) y el
// agente IA (qué motivos puede derivar).
//
//   app_settings.wa_derivaciones = {
//     prueba_employee_id: 64,                  // con la llave en prueba TODO lo que va a Planify va a esta persona
//     motivos: { reclamo: { destino: "planify", employee_id: 38, department_id: null }, … },
//     extra: [ { clave: "garantia", nombre: "Garantía", cuando: "…", min: 120 } ]   // motivos nuevos de la IA
//   }
// destino: "planify" = Tareas + tarea en Planify · "tareas" = sólo Centro de mensajes › Tareas ·
//          "bot" = lo responde el bot: la IA NO deriva ese motivo (sólo los motivos que deriva la IA).
// En producción (llave '1'): sector (department_id) si lo tiene → le aparece a todo el sector y gana el primero
// que toca "Me encargo yo"; si no, la persona (employee_id). Lo urgente (🔴) va a Planify aunque diga otra cosa.
// Sin fila, rige la config vieja app_settings.wa_alertas_planify (employee_id, categorias, department_id).
import { supabase } from "./supabase.ts";
import { CATEGORIAS, type MotivoExtra, registrarExtras } from "./alertas-vencimiento.ts";

export const SETTING_DERIVACIONES = "wa_derivaciones";

// Motivos que deriva la IA (derivar_a_persona). Son los únicos que pueden quedar en "lo responde el bot".
export const MOTIVOS_IA = ["reclamo", "pago", "cambio_pedido", "anulacion_pedido", "pedido_no_encontrado", "entrega"];
// Cuándo usar cada uno (va a la descripción de la herramienta de la IA).
export const CUANDO_IA: Record<string, string> = {
  reclamo: "NC, faltante, rotura, factura mal o duplicada, descuento que no se aplicó",
  pago: "importes, pagos, comprobantes, e-cheq",
  cambio_pedido: "sacar o cambiar artículos de un pedido",
  anulacion_pedido: "anular un pedido entero (decile antes en qué estado está: consultar_mis_pedidos)",
  pedido_no_encontrado: "dice que pidió y el pedido no está",
  entrega: "necesita fecha y el pedido no la tiene, no le llegó, o la fecha no coincide con la que le dijeron",
};

// Quién dispara cada motivo (texto del panel).
export const ORIGEN: Record<string, string> = {
  cliente_molesto: "El bot detecta enojo en el mensaje",
  respuesta_aviso_cambio: "El cliente responde a un aviso pidiendo cambiar o cancelar",
  escalation: "El cliente pide hablar con alguien, o la IA deriva sin otro motivo",
  comprobante_recibido: "El cliente manda un comprobante de pago",
  comprobante_error: "El comprobante no se pudo leer o no coincide",
  llm_timeout: "La IA no respondió a tiempo",
  llm_error: "La IA falló",
  alta_cliente: "Un no-cliente completa el alta, o la IA deriva un alta",
  blacklist: "Escribió un número bloqueado",
  faq_no_match: "Pregunta que el bot no supo responder",
  consulta_stock: "Artículo sin stock",
  otro: "Cualquier otra alerta",
  ...Object.fromEntries(MOTIVOS_IA.map((k) => [k, "La IA deriva: " + CUANDO_IA[k]])),
};

export type Destino = "planify" | "tareas" | "bot";
export type Regla = { destino: Destino; planify: boolean; employee_id: number | null; department_id: number | null };
export type Derivaciones = {
  prueba_employee_id: number | null;
  broadcast: boolean;
  defecto: { employee_id: number | null; department_id: number | null };
  motivos: Record<string, Regla>;
  extra: MotivoExtra[];
};

const num = (v: unknown) => (Number(v) > 0 ? Number(v) : null);
const SIEMPRE_DEF = new Set(MOTIVOS_IA);

let cache: { hasta: number; d: Derivaciones } | null = null;

export async function derivaciones(usarCache = false): Promise<Derivaciones> {
  if (usarCache && cache && cache.hasta > Date.now()) return cache.d;
  const { data } = await supabase.from("app_settings").select("key, value")
    .in("key", ["wa_alertas_planify", SETTING_DERIVACIONES]);
  const leer = (k: string) => {
    try { return JSON.parse(data?.find((r) => r.key === k)?.value ?? "{}") ?? {}; } catch { return {}; }
  };
  const viejo = leer("wa_alertas_planify");
  const nuevo = leer(SETTING_DERIVACIONES);
  const extra = registrarExtras(nuevo.extra);
  const esIA = new Set([...MOTIVOS_IA, ...extra.map((e) => e.clave)]);
  const catsViejas: string[] = Array.isArray(viejo.categorias) ? viejo.categorias : [];
  const motivos: Record<string, Regla> = {};
  for (const cat of Object.keys(CATEGORIAS)) {
    const g = nuevo.motivos?.[cat];
    let destino: Destino = typeof g?.destino === "string" && ["planify", "tareas", "bot"].includes(g.destino) ? g.destino
      : typeof g?.planify === "boolean" ? (g.planify ? "planify" : "tareas")
      : catsViejas.includes(cat) || SIEMPRE_DEF.has(cat) || esIA.has(cat) ? "planify" : "tareas";
    if (destino === "bot" && !esIA.has(cat)) destino = "tareas";
    if (cat === "whitelist_gate") destino = "tareas";
    motivos[cat] = { destino, planify: destino === "planify", employee_id: num(g?.employee_id), department_id: num(g?.department_id) };
  }
  const d: Derivaciones = {
    prueba_employee_id: num(nuevo.prueba_employee_id) ?? num(viejo.employee_id),
    broadcast: viejo.broadcast ?? true,
    defecto: { employee_id: num(viejo.employee_id), department_id: num(viejo.department_id) },
    motivos, extra,
  };
  cache = { hasta: Date.now() + 60_000, d };
  return d;
}

/** Motivos que la IA puede derivar hoy (los que no están en "lo responde el bot"), con cuándo usarlos. */
export async function motivosIA(): Promise<Array<{ clave: string; cuando: string }>> {
  const d = await derivaciones(true);
  const todos = [
    ...MOTIVOS_IA.map((k) => ({ clave: k, cuando: CUANDO_IA[k] })),
    ...d.extra.map((e) => ({ clave: e.clave, cuando: e.cuando || e.nombre })),
  ];
  return todos.filter((m) => d.motivos[m.clave]?.destino !== "bot");
}

/** Destino en Planify de una alerta, o null si sólo va a Tareas. */
export function destino(d: Derivaciones, cat: string, esUrgente: boolean, produccion: boolean):
  { employee_id: number } | { department_id: number } | null {
  const r = d.motivos[cat] ?? d.motivos.otro;
  if (cat === "whitelist_gate") return null;
  if (!r?.planify && !esUrgente) return null;
  if (!produccion) return d.prueba_employee_id ? { employee_id: d.prueba_employee_id } : null;
  const dep = r?.department_id ?? (r?.employee_id ? null : d.defecto.department_id);
  if (dep) return { department_id: dep };
  const emp = r?.employee_id ?? d.defecto.employee_id;
  return emp ? { employee_id: emp } : null;
}
