// Pruebas del semáforo de las alertas (supabase/functions/_shared/semaforo.ts), con y sin semáforo fijado en Derivaciones. Sin red, sin IA.
// Correr: deno run tests/semaforo.test.ts   (sale con código 1 si algo falla)
import { esNivel, MAX_TIEMPO_MIN, nivelAuto, nivelDe, nivelFijo, registrarNiveles, registrarTiempos, tiempoDeNivel, TIEMPOS_DEFECTO, tiemposVigentes, urgenteAuto, urgenteDe } from "../supabase/functions/_shared/semaforo.ts";

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

// ── Tiempo de respuesta de cada semáforo (Pablo, 06/10: 🔴 20 min, 🟡 2 h, 🟢 4 h) ──
registrarTiempos(undefined);
igual("por defecto: 🔴 20 min · 🟡 2 h · 🟢 4 h", [tiempoDeNivel("rojo"), tiempoDeNivel("amarillo"), tiempoDeNivel("verde")], [20, 120, 240]);
igual("TIEMPOS_DEFECTO coincide", TIEMPOS_DEFECTO, { rojo: 20, amarillo: 120, verde: 240 });
registrarTiempos({ rojo: 10, amarillo: "90", verde: 300 });
igual("se pueden cambiar (acepta números en texto)", tiemposVigentes(), { rojo: 10, amarillo: 90, verde: 300 });
registrarTiempos({ rojo: 15 });
igual("lo que falta queda en el valor por defecto", tiemposVigentes(), { rojo: 15, amarillo: 120, verde: 240 });
registrarTiempos({ rojo: 0, amarillo: -5, verde: MAX_TIEMPO_MIN + 1 });
igual("inválidos (0, negativo, más de 30 días) se ignoran", tiemposVigentes(), { rojo: 20, amarillo: 120, verde: 240 });
registrarTiempos({ rojo: 1, amarillo: MAX_TIEMPO_MIN, verde: 20.4 });
igual("los bordes valen (1 min y 30 días); los decimales se redondean", tiemposVigentes(), { rojo: 1, amarillo: 43200, verde: 20 });
registrarTiempos({ rojo: 5 }); registrarTiempos(null);
igual("registrar de nuevo REEMPLAZA: volver a null deja los de siempre", tiemposVigentes(), { rojo: 20, amarillo: 120, verde: 240 });
registrarTiempos("x"); registrarTiempos([1, 2, 3]);
igual("registrar basura no rompe", tiemposVigentes(), { rojo: 20, amarillo: 120, verde: 240 });
// el tiempo sigue al semáforo EFECTIVO de la alerta
registrarNiveles(undefined);
igual("alta de cliente (🟢): 4 h", tiempoDeNivel(nivelDe("alta_cliente", {}, false)), 240);
igual("alta de cliente con un mensaje apurado sube a 🔴: 20 min", tiempoDeNivel(nivelDe("alta_cliente", { texto_recibido: "es urgente" }, false)), 20);
igual("reclamo (🟡): 2 h", tiempoDeNivel(nivelDe("reclamo", {}, false)), 120);
registrarNiveles({ reclamo: { nivel: "rojo" }, cliente_molesto: { nivel: "verde" } });
igual("reclamo fijado en 🔴: 20 min", tiempoDeNivel(nivelDe("reclamo", {}, false)), 20);
igual("cliente molesto fijado en 🟢: 4 h, aunque el mensaje grite", tiempoDeNivel(nivelDe("cliente_molesto", { texto_recibido: "ESTAFADORES!!!", urgente: true }, false)), 240);
registrarNiveles(undefined);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
