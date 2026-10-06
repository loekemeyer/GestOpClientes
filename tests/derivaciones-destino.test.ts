// Pruebas de a quién le llega en Planify una alerta (supabase/functions/_shared/derivaciones-destino.ts). Sin red, sin IA.
// Correr: deno run tests/derivaciones-destino.test.ts   (sale con código 1 si algo falla)
import { destino, destinosDe } from "../supabase/functions/_shared/derivaciones-destino.ts";
import type { Derivaciones, Regla } from "../supabase/functions/_shared/derivaciones.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const regla = (o: Partial<Regla> = {}): Regla => ({ destino: "planify", planify: true, employee_id: null, department_id: null, tambien: [], ...o });
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

// ── Varios destinos ("también a"): una tarea por destino ──
const D = (m: Record<string, Regla>, defecto?: Derivaciones["defecto"]) => der(m, defecto);
const tb = (employee_id: number | null, department_id: number | null) => ({ employee_id, department_id });
const asignar = (x: ReturnType<typeof destinosDe>) => x.map((y) => y.asignar);
igual("sin 'también': un solo destino, igual que antes", asignar(destinosDe(D({ reclamo: regla({ department_id: 8 }) }), "reclamo", false, true)), [{ department_id: 8 }]);
igual("sector + 'también' sector → dos tareas, el principal primero",
  asignar(destinosDe(D({ reclamo: regla({ department_id: 8, tambien: [tb(null, 1)] }) }), "reclamo", false, true)), [{ department_id: 8 }, { department_id: 1 }]);
igual("sector + 'también' persona → sector y persona",
  asignar(destinosDe(D({ reclamo: regla({ department_id: 8, tambien: [tb(5, null)] }) }), "reclamo", false, true)), [{ department_id: 8 }, { employee_id: 5 }]);
igual("persona elegida en el principal + 'también' sector",
  asignar(destinosDe(D({ reclamo: regla({ department_id: 8, employee_id: 7, tambien: [tb(null, 1)] }) }), "reclamo", false, true)), [{ employee_id: 7 }, { department_id: 1 }]);
igual("el principal 'por defecto' + un 'también'",
  asignar(destinosDe(D({ reclamo: regla({ tambien: [tb(null, 1)] }) }), "reclamo", false, true)), [{ employee_id: 64 }, { department_id: 1 }]);
igual("destinos repetidos se juntan en uno", asignar(destinosDe(D({ reclamo: regla({ department_id: 8, tambien: [tb(null, 8), tb(5, null), tb(5, 3)] }) }), "reclamo", false, true)), [{ department_id: 8 }, { employee_id: 5 }]);
igual("un 'también' vacío se ignora", asignar(destinosDe(D({ reclamo: regla({ department_id: 8, tambien: [tb(null, null)] }) }), "reclamo", false, true)), [{ department_id: 8 }]);
igual("'también' con persona y sector a la vez: gana la persona", asignar(destinosDe(D({ reclamo: regla({ department_id: 8, tambien: [tb(5, 1)] }) }), "reclamo", false, true)), [{ department_id: 8 }, { employee_id: 5 }]);
// prueba: una tarea por destino, todas a la persona de prueba, recordando a quién irían
igual("prueba: una tarea por destino, todas a la persona de prueba",
  destinosDe(D({ reclamo: regla({ department_id: 8, tambien: [tb(null, 1)] }) }), "reclamo", false, false),
  [{ asignar: { employee_id: 64 }, real: { department_id: 8 } }, { asignar: { employee_id: 64 }, real: { department_id: 1 } }]);
igual("prueba sin destino configurado: una tarea para la persona de prueba (como antes)", destinosDe(D({ pago: regla() }, { employee_id: null, department_id: null }), "pago", false, false), [{ asignar: { employee_id: 64 }, real: null }]);
igual("prueba sin persona de prueba → ninguna", destinosDe({ ...D({ pago: regla() }), prueba_employee_id: null }, "pago", false, false), []);
// Sólo Tareas y urgencia: valen para todos los destinos
const soloTareas2 = regla({ destino: "tareas", planify: false, department_id: 1, tambien: [tb(null, 8)] });
igual("'Sólo Tareas' no abre ninguna tarea, aunque tenga 'también'", destinosDe(D({ reclamo: soloTareas2 }), "reclamo", false, true), []);
igual("lo urgente abre una por cada destino aunque diga 'Sólo Tareas'", asignar(destinosDe(D({ reclamo: soloTareas2 }), "reclamo", true, true)), [{ department_id: 1 }, { department_id: 8 }]);
igual("whitelist_gate nunca abre tareas", destinosDe(D({ whitelist_gate: regla({ tambien: [tb(null, 1)] }) }), "whitelist_gate", true, true), []);
igual("destino() sigue devolviendo sólo el principal", destino(D({ reclamo: regla({ department_id: 8, tambien: [tb(null, 1)] }) }), "reclamo", false, true), { department_id: 8 });

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
