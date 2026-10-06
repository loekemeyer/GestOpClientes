// A quién le llega en Planify una alerta, según Configuración › Derivaciones. Módulo PURO (sin red ni base): lo usa derivaciones.ts
// (que lo reexporta) y se prueba en tests/derivaciones-destino.test.ts.
//
// Pablo Olejavetzky, 06/10/2026: "primero elijo el sector; si necesito que esté dirigido a una persona en particular, debería poder elegirlo".
// Regla de UN destino (antes ganaba el sector y la persona se ignoraba):
//   1. Persona elegida (sola o dentro de un sector) → tarea para ESA persona.
//   2. Sólo sector → tarea para el sector: le aparece a todos y la primera persona que toca "Me encargo yo" se la queda.
//   3. Ninguno → el sector, o si no la persona, "por defecto" (app_settings.wa_alertas_planify).
// Varios destinos (mismo día): el motivo puede sumar destinos ("también a"); cada uno abre SU tarea con la regla 1 o 2. Los repetidos se juntan.
// Con la llave en prueba nada de esto rige: cada tarea va a la persona de prueba (pero se sigue creando una por destino, para poder probar).
import type { Derivaciones } from "./derivaciones.ts";

export type Dest = { employee_id: number } | { department_id: number };
/** `asignar` = a quién se le asigna la tarea (en prueba, la persona de prueba); `real` = a quién iría en producción (null si no hay uno configurado). */
export type DestinoTarea = { asignar: Dest; real: Dest | null };

const clave = (x: Dest) => ("employee_id" in x ? `e${x.employee_id}` : `d${x.department_id}`);

/** Destinos de una alerta en Planify, el principal primero. Vacío si el motivo sólo va a Tareas (o no hay a quién). */
export function destinosDe(d: Derivaciones, cat: string, esUrgente: boolean, produccion: boolean): DestinoTarea[] {
  const r = d.motivos[cat] ?? d.motivos.otro;
  if (cat === "whitelist_gate") return [];
  if (!r?.planify && !esUrgente) return [];
  const reales: Dest[] = [];
  // Principal: la persona gana al sector; sin ninguno de los dos, el sector o la persona "por defecto".
  if (r?.employee_id) reales.push({ employee_id: r.employee_id });
  else {
    const dep = r?.department_id ?? d.defecto.department_id;
    if (dep) reales.push({ department_id: dep });
    else if (d.defecto.employee_id) reales.push({ employee_id: d.defecto.employee_id });
  }
  for (const t of r?.tambien ?? []) {
    if (t.employee_id) reales.push({ employee_id: t.employee_id });
    else if (t.department_id) reales.push({ department_id: t.department_id });
  }
  const unicos = reales.filter((x, i) => reales.findIndex((y) => clave(y) === clave(x)) === i);
  if (!produccion) {
    if (!d.prueba_employee_id) return [];
    const prueba: Dest = { employee_id: d.prueba_employee_id };
    return unicos.length ? unicos.map((real) => ({ asignar: prueba, real })) : [{ asignar: prueba, real: null }];
  }
  return unicos.map((real) => ({ asignar: real, real }));
}

/** Destino en Planify de una alerta (el principal), o null si sólo va a Tareas. */
export function destino(d: Derivaciones, cat: string, esUrgente: boolean, produccion: boolean): Dest | null {
  return destinosDe(d, cat, esUrgente, produccion)[0]?.asignar ?? null;
}
