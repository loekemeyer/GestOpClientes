// Pruebas puras del medidor de presupuesto mensual (_shared/presupuesto-ia.ts). Sin red, sin IA, sin base.
// Correr: deno run --allow-env tests/presupuesto-ia.test.ts   (sale con código 1 si algo falla)
import {
  contextoAlertaPresupuesto, inicioMesArgentina, PRESUP_MENSUAL_USD_DEFAULT, PRESUP_UMBRALES_DEFAULT, pctDelMes, presupuestoDeSettings,
  pozoDeSettings, sumarGastoMes, umbralCruzado, umbralesDeSettings,
} from "../supabase/functions/_shared/presupuesto-ia.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// --- inicio del mes de Argentina ---
// 14/10/2026 12:00 ART = 15:00 UTC. El mes arranca el 01/10/2026 00:00 ART = 01/10/2026 03:00 UTC.
const ahora = Date.parse("2026-10-14T15:00:00Z");
igual("inicio de mes ART cae el día 1 a las 03:00 UTC", new Date(inicioMesArgentina(ahora)).toISOString(), "2026-10-01T03:00:00.000Z");
// Un mensaje del 01/10 a las 01:00 ART (04:00 UTC) ya es de octubre; el inicio del mes es anterior a él.
const primeroMadrugada = Date.parse("2026-10-01T04:00:00Z");
igual("el 1 a la madrugada ART ya es del mes", inicioMesArgentina(primeroMadrugada) <= primeroMadrugada, true);
// El 01/10 a las 02:00 UTC es todavía 30/09 23:00 ART: pertenece a septiembre, no a octubre.
const ultimoDeSept = Date.parse("2026-10-01T02:00:00Z");
igual("antes de medianoche ART es el mes anterior", new Date(inicioMesArgentina(ultimoDeSept)).toISOString(), "2026-09-01T03:00:00.000Z");

// --- presupuesto y pozo desde settings ---
igual("presupuesto por defecto", presupuestoDeSettings(null), PRESUP_MENSUAL_USD_DEFAULT);
igual("presupuesto con coma decimal", presupuestoDeSettings("99,5"), 99.5);
igual("presupuesto 0 apaga (válido)", presupuestoDeSettings("0"), 0);
igual("presupuesto basura vuelve al defecto", presupuestoDeSettings(" abc "), PRESUP_MENSUAL_USD_DEFAULT);
igual("pozo por defecto", pozoDeSettings(undefined), 200);

// --- umbrales ---
igual("umbrales por defecto", umbralesDeSettings(null), PRESUP_UMBRALES_DEFAULT);
igual("umbrales desordenados y repetidos se limpian y ordenan", umbralesDeSettings("75, 25,50,25"), [25, 50, 75]);
igual("umbrales fuera de (0,100] se descartan", umbralesDeSettings("0,50,120,100"), [50, 100]);
igual("umbrales vacíos vuelven al defecto", umbralesDeSettings("   "), PRESUP_UMBRALES_DEFAULT);
igual("umbrales con separadores mezclados", umbralesDeSettings("25 50;75"), [25, 50, 75]);

// --- suma del gasto ---
igual("suma ignora lo que no es número y lo <= 0", sumarGastoMes([{ estimated_cost_usd: "1.5" }, { estimated_cost_usd: 0 }, { estimated_cost_usd: "x" }, null, { estimated_cost_usd: 2 }]), 3.5);

// --- porcentaje ---
igual("pct normal", pctDelMes(25, 100), 25);
igual("pct con presupuesto 0 es 0 (apagado)", pctDelMes(50, 0), 0);
igual("pct nunca negativo", pctDelMes(-5, 100), 0);
igual("pct puede pasar 100", pctDelMes(150, 100) > 100, true);

// --- umbral cruzado ---
const U = [25, 50, 75, 90, 100];
igual("sin cruzar ninguno", umbralCruzado(10, U), null);
igual("justo en el umbral cuenta", umbralCruzado(25, U), 25);
igual("salto grande devuelve el más alto cruzado", umbralCruzado(62, U), 50);
igual("al 100% devuelve 100", umbralCruzado(100, U), 100);
igual("pasado el 100% sigue siendo 100", umbralCruzado(140, U), 100);

// --- contexto de la alerta ---
const ctx50 = contextoAlertaPresupuesto(50, 50, 100, 200) as Record<string, unknown>;
igual("la alerta reusa el motivo tope_gasto", ctx50.motivo, "tope_gasto");
igual("nivel presupuesto (no se confunde con el diario aviso/tope)", ctx50.nivel, "presupuesto");
igual("lleva el umbral como clave de dedup", ctx50.umbral, 50);
igual("el 50% no es urgente", ctx50.urgente, false);
const ctx90 = contextoAlertaPresupuesto(90, 92, 100, 200) as Record<string, unknown>;
igual("desde el 90% es urgente (rojo)", ctx90.urgente, true);
igual("el detalle es texto no vacío", typeof ctx90.detalle === "string" && (ctx90.detalle as string).length > 0, true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
