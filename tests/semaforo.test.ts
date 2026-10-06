// Pruebas del semáforo de las alertas (supabase/functions/_shared/semaforo.ts), con y sin semáforo fijado en Derivaciones. Sin red, sin IA.
// Correr: deno run tests/semaforo.test.ts   (sale con código 1 si algo falla)
import { esNivel, nivelAuto, nivelDe, nivelFijo, registrarNiveles, urgenteAuto, urgenteDe } from "../supabase/functions/_shared/semaforo.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── "Auto": lo de siempre (nada fijado) ──
registrarNiveles(undefined);
igual("auto: cliente molesto → 🔴", nivelAuto("cliente_molesto", {}, false), "rojo");
igual("auto: cambio de pedido → 🔴", nivelAuto("cambio_pedido", {}, false), "rojo");
igual("auto: reclamo → 🟡", nivelAuto("reclamo", {}, false), "amarillo");
igual("auto: alta de cliente → 🟢", nivelAuto("alta_cliente", {}, false), "verde");
igual("auto: motivo agregado desde el panel → 🟡", nivelAuto("garantia", {}, true), "amarillo");
igual("auto: un mensaje apurado sube un 🟢 a 🔴", nivelAuto("alta_cliente", { texto_recibido: "es urgente, lo necesito hoy mismo" }, false), "rojo");
igual("auto: contexto.urgente=true sube a 🔴", nivelAuto("pago", { urgente: true }, false), "rojo");
igual("auto: contexto.urgente=false gana al motivo (🔴 por defecto pasa a 🟡/🟢)", nivelAuto("cambio_pedido", { urgente: false }, false), "verde");
igual("auto: urgenteAuto de un motivo urgente", urgenteAuto("comprobante_error", {}), true);
igual("sin fijar: nivelDe == nivelAuto", nivelDe("reclamo", {}, false), "amarillo");
igual("sin fijar: nivelFijo es null", nivelFijo("reclamo"), null);

// ── Fijado a mano ──
registrarNiveles({ reclamo: { destino: "planify", nivel: "rojo" }, cliente_molesto: { nivel: "verde" }, pago: { nivel: "amarillo" }, alta_cliente: {} });
igual("fijo 🔴 en un motivo 🟡 → 🔴", nivelDe("reclamo", {}, false), "rojo");
igual("fijo 🔴 cuenta como urgente (va a Planify)", urgenteDe("reclamo", {}), true);
igual("fijo 🟢 en un motivo 🔴 → 🟢", nivelDe("cliente_molesto", {}, false), "verde");
igual("fijo 🟢 deja de ser urgente (respeta 'Sólo Tareas')", urgenteDe("cliente_molesto", {}), false);
igual("fijo manda sobre el mensaje: texto apurado no lo sube", nivelDe("cliente_molesto", { texto_recibido: "ESTAFADORES!!!", urgente: true }, false), "verde");
igual("fijo 🟡 con contexto.urgente=true sigue 🟡", [nivelDe("pago", { urgente: true }, false), urgenteDe("pago", { urgente: true })], ["amarillo", false]);
igual("fijo en un motivo agregado desde el panel", (registrarNiveles({ garantia: { nivel: "verde" } }), nivelDe("garantia", {}, true)), "verde");
igual("sin 'nivel' en la regla (o vacío) → Auto", (registrarNiveles({ alta_cliente: { destino: "planify" }, reclamo: { nivel: "" } }), [nivelDe("alta_cliente", {}, false), nivelDe("reclamo", {}, false)]), ["verde", "amarillo"]);
igual("un valor inválido se ignora (Auto)", (registrarNiveles({ reclamo: { nivel: "violeta" } }), nivelDe("reclamo", {}, false)), "amarillo");
igual("registrar de nuevo REEMPLAZA: el fijo anterior desaparece", (registrarNiveles({ pago: { nivel: "rojo" } }), registrarNiveles({}), nivelFijo("pago")), null);
igual("registrar basura (null, string, array) no rompe", (registrarNiveles(null), registrarNiveles("x"), registrarNiveles([1, 2]), nivelFijo("pago")), null);
igual("esNivel", [esNivel("rojo"), esNivel("amarillo"), esNivel("verde"), esNivel(""), esNivel(null), esNivel("Rojo")], [true, true, true, false, false, false]);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
