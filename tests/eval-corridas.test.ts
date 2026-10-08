// Pruebas de cómo se cuenta la corrida automática de los casos del agente (supabase/functions/_shared/eval-corridas.ts, sql/133).
// Pablo Olejavetzky, 08/10/2026. Sin red, sin IA.
// Correr: deno run tests/eval-corridas.test.ts   (sale con código 1 si algo falla)
import { describirCambios, filasDeCorrida, hayQueAvisar, resumenCorrida, type Corrida, type Resultado, type CasoEval } from "../supabase/functions/_shared/eval-corridas.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const C = (x: Partial<Corrida>): Corrida => ({ id: 2, origen: "cron", estado: "terminada", modelos: "gemini-3.5-flash-lite", anterior_id: 1,
  casos: 84, hechos: 84, errores: 0, cambios: 0, creada_at: "2026-10-09T06:15:00Z", terminada_at: "2026-10-09T07:40:00Z", ...x });
const R = (x: Partial<Resultado>): Resultado => ({ eval_id: 10, estado: "listo", camino: "ia", deriva: "no", respuesta: "hola", error: null,
  cambios: [], antes: { estado: "listo", camino: "ia", deriva: "no", respuesta: "hola" }, ...x });

// ── Resumen de la corrida ──
igual("terminada sin cambios", resumenCorrida(C({})), "84 casos · 84 contestados · ninguno cambió");
igual("con cambios y errores", resumenCorrida(C({ hechos: 81, errores: 3, cambios: 2 })), "84 casos · 81 contestados · 3 con error · 2 cambiaron");
igual("primera corrida", resumenCorrida(C({ anterior_id: null })), "84 casos · 84 contestados · primera corrida: queda como base");
igual("cortada", resumenCorrida(C({ estado: "cortada", hechos: 40, errores: 44 })).endsWith("se cortó a las 6 horas"), true);
igual("sin modelo gratis: dice cuál y que no gasta", resumenCorrida(C({ estado: "sin_modelo_gratis", modelos: "claude-haiku-4-5-20251001" })),
  "No corrió: el modelo de pruebas (claude-haiku-4-5-20251001) no es gratis, y la corrida nunca gasta.");
igual("corriendo", resumenCorrida(C({ estado: "corriendo" })), "Corriendo: 84 casos, de a uno por minuto.");

// ── ¿Avisar? ──
igual("sin cambios ni errores: no avisa", hayQueAvisar(C({})), false);
igual("con un cambio: avisa", hayQueAvisar(C({ cambios: 1 })), true);
igual("con un error: avisa", hayQueAvisar(C({ errores: 1 })), true);
igual("sin modelo gratis: avisa", hayQueAvisar(C({ estado: "sin_modelo_gratis" })), true);
igual("cortada: avisa", hayQueAvisar(C({ estado: "cortada" })), true);

// ── Qué cambió, en castellano ──
igual("camino: fija → IA", describirCambios(R({ cambios: ["camino"], camino: "ia", antes: { camino: "fija #4" } })),
  ["camino: respuesta fija #4 → agente IA"]);
igual("deriva: no → pago", describirCambios(R({ cambios: ["deriva"], deriva: "pago", antes: { deriva: "no" } })), ["no deriva → deriva: pago"]);
igual("deriva: cambio_pedido → no", describirCambios(R({ cambios: ["deriva"], deriva: "no", antes: { deriva: "cambio_pedido" } })),
  ["deriva: cambio pedido → no deriva"]);
igual("texto", describirCambios(R({ cambios: ["texto"] })), ["cambió el texto de la respuesta fija"]);
igual("error, con el motivo", describirCambios(R({ cambios: ["error"], estado: "error", error: "Google 503" })), ["antes contestaba, ahora falla (Google 503)"]);
igual("dos cambios", describirCambios(R({ cambios: ["camino", "deriva"], camino: "ia", deriva: "entrega", antes: { camino: "fija", deriva: "no" } })),
  ["camino: respuesta fija → agente IA", "no deriva → deriva: entrega"]);
igual("sin cambios: nada", describirCambios(R({ cambios: null })), []);

// ── Filas para el mail y el Panel ──
const casos = new Map<number, CasoEval>([[10, { id: 10, clave: "m21", pregunta: "¿Cuándo llega mi pedido?", causa: "entrega" }],
  [11, { id: 11, clave: null, pregunta: "Quiero cancelar mi pedido", causa: null }]]);
const filas = filasDeCorrida([
  R({ eval_id: 11, estado: "error", error: "el Simulador no contestó en 5 minutos", cambios: [] }),
  R({ eval_id: 10, cambios: ["deriva"], deriva: "entrega", antes: { deriva: "no" } }),
  R({ eval_id: 12 }),
], casos);
igual("primero los que cambiaron, después los que fallaron, y nada de los que quedaron igual", filas, [
  { caso: "m21", pregunta: "¿Cuándo llega mi pedido?", que: "no deriva → deriva: entrega" },
  { caso: "#11", pregunta: "Quiero cancelar mi pedido", que: "no contestó (el Simulador no contestó en 5 minutos)" },
]);
igual("un error que ya figura como cambio no se repite",
  filasDeCorrida([R({ eval_id: 10, estado: "error", error: "x", cambios: ["error"] })], casos).length, 1);
igual("tope de filas", filasDeCorrida(Array.from({ length: 40 }, (_, i) => R({ eval_id: 100 + i, cambios: ["texto"] })), casos, 30).length, 30);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
