// Pruebas de las tareas de Planify de una alerta (supabase/functions/_shared/tareas-alerta.ts). Sin red, sin IA.
// Correr: deno run tests/tareas-alerta.test.ts   (sale con código 1 si algo falla)
import { alertaAtendida, contextoConTareas, idsDeTareas, quienTomo, trozos } from "../supabase/functions/_shared/tareas-alerta.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── ids de las tareas ──
igual("formato viejo: una tarea", idsDeTareas({ planify_task_id: 5100 }), [5100]);
igual("formato nuevo: varias, en orden", idsDeTareas({ planify_task_id: 5100, planify_task_ids: [5100, 5101, 5102] }), [5100, 5101, 5102]);
igual("la primera siempre va primero aunque la lista no la traiga", idsDeTareas({ planify_task_id: 5100, planify_task_ids: [5101] }), [5100, 5101]);
igual("sin repetidos ni basura", idsDeTareas({ planify_task_ids: [5101, "5101", 0, -3, "x", null, 5102] }), [5101, 5102]);
igual("sin tareas / contexto nulo", [idsDeTareas({}), idsDeTareas(null), idsDeTareas(undefined)], [[], [], []]);
igual("planify_task_ids que no es lista se ignora", idsDeTareas({ planify_task_ids: "5101", planify_task_id: 7 }), [7]);

// ── lo que se guarda ──
igual("una tarea: queda como siempre (sólo planify_task_id)", contextoConTareas({ motivo: "pago" }, [5100]), { motivo: "pago", planify_task_id: 5100 });
igual("varias: la primera + la lista", contextoConTareas({ motivo: "pago" }, [5100, 5101]), { motivo: "pago", planify_task_id: 5100, planify_task_ids: [5100, 5101] });
igual("no deja una lista vieja de otra corrida", contextoConTareas({ planify_task_ids: [1, 2] }, [9]), { planify_task_id: 9 });

// ── cuándo se da por atendida ──
const abiertas = (...ids: number[]) => new Set(ids);
igual("una tarea hecha → atendida", alertaAtendida([5100], abiertas()), true);
igual("una tarea abierta → no", alertaAtendida([5100], abiertas(5100)), false);
igual("varias: se cerró una y queda otra abierta → NO está atendida", alertaAtendida([5100, 5101], abiertas(5101)), false);
igual("varias: se cerraron todas → atendida", alertaAtendida([5100, 5101], abiertas()), true);
igual("varias: ninguna cerrada → no", alertaAtendida([5100, 5101], abiertas(5100, 5101)), false);
igual("sin tareas no se da por atendida (no hay nada que mirar)", alertaAtendida([], abiertas()), false);
igual("una tarea borrada en Planify cuenta como cerrada (no está entre las abiertas)", alertaAtendida([5100, 5101], abiertas(5101, 9999)), false);

// ── quién se hizo cargo ──
const tomo = new Map([[5100, "Diego Mollo"], [5102, "Giuliana De La Vega"]]);
igual("nadie la tomó → null", quienTomo([5101], tomo), null);
igual("una la tomó uno", quienTomo([5100, 5101], tomo), "Diego Mollo");
igual("la tomaron en dos destinos → los dos nombres", quienTomo([5100, 5101, 5102], tomo), "Diego Mollo, Giuliana De La Vega");
igual("el mismo nombre dos veces se junta", quienTomo([5100, 5103], new Map([[5100, "Ana"], [5103, "Ana"]])), "Ana");

// ── tandas ──
igual("trozos: 5 en tandas de 2", trozos([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
igual("trozos: lista vacía", trozos([], 3), []);
igual("trozos: 2.500 ids en tandas de 200 → 13 tandas, ninguna pasa de 200", (() => { const t = trozos(Array.from({ length: 2500 }, (_, i) => i), 200); return [t.length, Math.max(...t.map((x) => x.length)), t.flat().length]; })(), [13, 200, 2500]);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
