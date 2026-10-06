// A quién le llega en Planify una alerta, según Configuración › Derivaciones. Módulo PURO (sin red ni base): lo usa derivaciones.ts
// (que lo reexporta) y se prueba en tests/derivaciones-destino.test.ts.
//
// Pablo Olejavetzky, 06/10/2026: "primero elijo el sector; si necesito que esté dirigido a una persona en particular, debería poder elegirlo".
// Regla (antes ganaba el sector y la persona se ignoraba):
//   1. Persona elegida (sola o dentro de un sector) → tarea para ESA persona.
//   2. Sólo sector → tarea para el sector: le aparece a todos y la primera persona que toca "Me encargo yo" se la queda.
//   3. Ninguno → el sector, o si no la persona, "por defecto" (app_settings.wa_alertas_planify).
// Con la llave en prueba nada de esto rige: va siempre a la persona de prueba.
import type { Derivaciones } from "./derivaciones.ts";

/** Destino en Planify de una alerta, o null si sólo va a Tareas. */
export function destino(d: Derivaciones, cat: string, esUrgente: boolean, produccion: boolean):
  { employee_id: number } | { department_id: number } | null {
  const r = d.motivos[cat] ?? d.motivos.otro;
  if (cat === "whitelist_gate") return null;
  if (!r?.planify && !esUrgente) return null;
  if (!produccion) return d.prueba_employee_id ? { employee_id: d.prueba_employee_id } : null;
  if (r?.employee_id) return { employee_id: r.employee_id };
  const dep = r?.department_id ?? d.defecto.department_id;
  if (dep) return { department_id: dep };
  return d.defecto.employee_id ? { employee_id: d.defecto.employee_id } : null;
}
