// Pruebas de a quién le llega en Planify una alerta (supabase/functions/_shared/derivaciones-destino.ts). Sin red, sin IA.
// Correr: deno run tests/derivaciones-destino.test.ts   (sale con código 1 si algo falla)
import { destino } from "../supabase/functions/_shared/derivaciones-destino.ts";
import type { Derivaciones, Regla } from "../supabase/functions/_shared/derivaciones.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const regla = (o: Partial<Regla> = {}): Regla => ({ destino: "planify", planify: true, employee_id: null, department_id: null, ...o });
const der = (motivos: Record<string, Regla>, defecto: Derivaciones["defecto"] = { employee_id: 64, department_id: null }): Derivaciones =>
  ({ prueba_employee_id: 64, broadcast: true, defecto, motivos: { otro: regla(), ...motivos }, extra: [] });

// ── Producción: la persona gana, el sector es para todos ──
igual("sólo sector → tarea para el sector", destino(der({ cambio_pedido: regla({ department_id: 1 }) }), "cambio_pedido", false, true), { department_id: 1 });
igual("sector + persona → sólo la persona (antes ganaba el sector)", destino(der({ cambio_pedido: regla({ department_id: 1, employee_id: 5 }) }), "cambio_pedido", false, true), { employee_id: 5 });
igual("sólo persona → la persona", destino(der({ pago: regla({ employee_id: 7 }) }), "pago", false, true), { employee_id: 7 });
igual("sin sector ni persona → la persona por defecto", destino(der({ pago: regla() }), "pago", false, true), { employee_id: 64 });
igual("sin sector ni persona y el defecto es un sector → ese sector", destino(der({ pago: regla() }, { employee_id: 64, department_id: 8 }), "pago", false, true), { department_id: 8 });
igual("persona elegida le gana también al sector por defecto", destino(der({ pago: regla({ employee_id: 7 }) }, { employee_id: 64, department_id: 8 }), "pago", false, true), { employee_id: 7 });
igual("sin nada y sin defecto → null (sólo Tareas)", destino(der({ pago: regla() }, { employee_id: null, department_id: null }), "pago", false, true), null);

// ── Llave en prueba: siempre a la persona de prueba, sin mirar sector ni persona ──
igual("prueba: ignora sector y persona", destino(der({ cambio_pedido: regla({ department_id: 1, employee_id: 5 }) }), "cambio_pedido", false, false), { employee_id: 64 });
igual("prueba sin persona de prueba → null", destino({ ...der({ pago: regla() }), prueba_employee_id: null }, "pago", false, false), null);

// ── Sólo Tareas, urgencia y motivos sin regla ──
const soloTareas = regla({ destino: "tareas", planify: false, department_id: 1 });
igual("'Sólo Tareas' no abre tarea en Planify", destino(der({ reclamo: soloTareas }), "reclamo", false, true), null);
igual("lo urgente va a Planify aunque diga 'Sólo Tareas'", destino(der({ reclamo: soloTareas }), "reclamo", true, true), { department_id: 1 });
igual("whitelist_gate nunca va a Planify", destino(der({ whitelist_gate: regla() }), "whitelist_gate", true, true), null);
igual("motivo sin regla usa la de 'otro'", destino(der({ otro: regla({ employee_id: 9 }) }), "motivo_que_no_existe", false, true), { employee_id: 9 });

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
