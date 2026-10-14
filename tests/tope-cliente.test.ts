// Pruebas puras del tope de gasto por cliente (_shared/tope-cliente.ts). Sin red, sin IA, sin base.
// Correr: deno run --allow-env tests/tope-cliente.test.ts   (sale con código 1 si algo falla)
import {
  contextoAlertaCliente, inicioSemanaArgentina, nivelClienteGasto, TOPE_CLIENTE_DIA_USD_DEFAULT, TOPE_CLIENTE_SEMANA_USD_DEFAULT, topesClienteDeSettings,
} from "../supabase/functions/_shared/tope-cliente.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// --- inicio de la semana de Argentina (lunes 00:00 ART = 03:00 UTC del lunes) ---
// Miércoles 14/10/2026 12:00 ART (15:00 UTC): la semana arrancó el lunes 12/10 00:00 ART = 12/10 03:00 UTC.
igual("semana ART arranca el lunes 03:00 UTC", new Date(inicioSemanaArgentina(Date.parse("2026-10-14T15:00:00Z"))).toISOString(), "2026-10-12T03:00:00.000Z");
// Lunes 12/10 a las 00:30 ART (03:30 UTC) ya es de esta semana; el inicio es el mismo lunes 03:00 UTC.
igual("el lunes temprano ya es de esta semana", new Date(inicioSemanaArgentina(Date.parse("2026-10-12T03:30:00Z"))).toISOString(), "2026-10-12T03:00:00.000Z");
// Domingo 11/10 a las 23:00 ART (12/10 02:00 UTC) todavía es la semana anterior: arranca el lunes 05/10.
igual("el domingo a la noche ART es la semana anterior", new Date(inicioSemanaArgentina(Date.parse("2026-10-12T02:00:00Z"))).toISOString(), "2026-10-05T03:00:00.000Z");

// --- topes desde settings ---
igual("topes por defecto", topesClienteDeSettings(null, null), { dia: TOPE_CLIENTE_DIA_USD_DEFAULT, semana: TOPE_CLIENTE_SEMANA_USD_DEFAULT });
igual("topes con coma decimal", topesClienteDeSettings("2,5", "7,5"), { dia: 2.5, semana: 7.5 });
igual("0 apaga un tope (válido)", topesClienteDeSettings("0", "5"), { dia: 0, semana: 5 });
igual("basura vuelve al defecto", topesClienteDeSettings("x", ""), { dia: TOPE_CLIENTE_DIA_USD_DEFAULT, semana: TOPE_CLIENTE_SEMANA_USD_DEFAULT });

// --- nivel por cliente ---
const t = { dia: 2, semana: 5 };
igual("por debajo de los dos: ok", nivelClienteGasto(1, 3, t), { nivel: "ok", limite: null });
igual("justo en el tope diario corta", nivelClienteGasto(2, 2, t), { nivel: "tope", limite: "dia" });
igual("el semanal corta aunque el diario no", nivelClienteGasto(0.5, 5, t), { nivel: "tope", limite: "semana" });
igual("si cruza los dos, se reporta semana", nivelClienteGasto(2, 5, t), { nivel: "tope", limite: "semana" });
igual("diario en 0 no corta por día", nivelClienteGasto(9, 1, { dia: 0, semana: 5 }), { nivel: "ok", limite: null });
igual("los dos en 0: nunca corta", nivelClienteGasto(99, 99, { dia: 0, semana: 0 }), { nivel: "ok", limite: null });

// --- contexto de la alerta ---
const ctxSem = contextoAlertaCliente("semana", 2, 6, t, "hola", "Bazar Farimar") as Record<string, unknown>;
igual("la alerta reusa el motivo tope_gasto", ctxSem.motivo, "tope_gasto");
igual("nivel cliente (no se confunde con el global aviso/tope ni con presupuesto)", ctxSem.nivel, "cliente");
igual("lleva el límite que saltó", ctxSem.limite, "semana");
igual("guarda la razón social para el Panel", ctxSem.razon_social, "Bazar Farimar");
igual("el detalle es texto no vacío", typeof ctxSem.detalle === "string" && (ctxSem.detalle as string).length > 0, true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
