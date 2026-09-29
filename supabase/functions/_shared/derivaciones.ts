// A dónde va cada caso que necesita a una persona (Pablo, 29/09: "un panel que nos muestre a dónde se deriva
// cada caso … dentro de configuración"). Lo leen lk_alerta-planify (crea la tarea) y lk_alertas (el panel).
//
// Toda alerta aparece siempre en Centro de mensajes › Tareas. Lo que se configura acá es si ADEMÁS abre una
// tarea en Planify y para quién:
//   app_settings.wa_derivaciones = {
//     prueba_employee_id: 64,                         // con la llave en prueba TODO va a esta persona
//     motivos: { reclamo: { planify: true, employee_id: 38, department_id: null }, … }
//   }
// En producción (llave '1'): sector (department_id) si lo tiene → le aparece a todo el sector y gana el primero
// que toca "Me encargo yo"; si no, la persona (employee_id). Lo urgente (🔴) va a Planify aunque el motivo diga
// que no. Sin fila, rige la config vieja app_settings.wa_alertas_planify (employee_id, categorias, department_id).
import { supabase } from "./supabase.ts";
import { CATEGORIAS } from "./alertas-vencimiento.ts";

export const SETTING_DERIVACIONES = "wa_derivaciones";

// Motivos que la IA deriva (derivar_a_persona): van siempre a Planify salvo que se cambie en el panel.
const SIEMPRE_DEF = new Set(["reclamo", "pago", "cambio_pedido", "pedido_no_encontrado", "entrega"]);

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
  reclamo: "La IA deriva: NC, faltante, rotura o error de factura",
  pago: "La IA deriva: importe, pago no acreditado, e-cheq",
  cambio_pedido: "La IA deriva: agregar, quitar o anular artículos",
  pedido_no_encontrado: "La IA deriva: el cliente dice que cargó un pedido y no aparece",
  entrega: "La IA deriva: pedido sin fecha que el cliente necesita, no llegó, o fecha distinta a la acordada",
  otro: "Cualquier otra alerta",
  whitelist_gate: "Número fuera de la lista de prueba (no llega a Planify)",
};

export type Regla = { planify: boolean; employee_id: number | null; department_id: number | null };
export type Derivaciones = {
  prueba_employee_id: number | null;
  broadcast: boolean;
  defecto: { employee_id: number | null; department_id: number | null };
  motivos: Record<string, Regla>;
};

const num = (v: unknown) => (Number(v) > 0 ? Number(v) : null);

export async function derivaciones(): Promise<Derivaciones> {
  const { data } = await supabase.from("app_settings").select("key, value")
    .in("key", ["wa_alertas_planify", SETTING_DERIVACIONES]);
  const leer = (k: string) => {
    try { return JSON.parse(data?.find((r) => r.key === k)?.value ?? "{}") ?? {}; } catch { return {}; }
  };
  const viejo = leer("wa_alertas_planify");
  const nuevo = leer(SETTING_DERIVACIONES);
  const catsViejas: string[] = Array.isArray(viejo.categorias) ? viejo.categorias : [];
  const motivos: Record<string, Regla> = {};
  for (const cat of Object.keys(CATEGORIAS)) {
    const g = nuevo.motivos?.[cat];
    motivos[cat] = {
      planify: cat === "whitelist_gate" ? false
        : typeof g?.planify === "boolean" ? g.planify : catsViejas.includes(cat) || SIEMPRE_DEF.has(cat),
      employee_id: num(g?.employee_id),
      department_id: num(g?.department_id),
    };
  }
  return {
    prueba_employee_id: num(nuevo.prueba_employee_id) ?? num(viejo.employee_id),
    broadcast: viejo.broadcast ?? true,
    defecto: { employee_id: num(viejo.employee_id), department_id: num(viejo.department_id) },
    motivos,
  };
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
