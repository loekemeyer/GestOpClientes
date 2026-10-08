// Pruebas de la lista de modelos de prueba (supabase/functions/_shared/modelos-prueba.ts). Sin red, sin IA.
// Correr: deno run tests/modelos-prueba.test.ts   (sale con código 1 si algo falla)
import { esperaPorCuotaDePrueba, idModeloPrueba, listaModelosPrueba, MAX_MODELOS_PRUEBA, PRESUPUESTO_TURNO_PRUEBA_MS, soloModelosGratis } from "../supabase/functions/_shared/modelos-prueba.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

igual("un solo modelo (como hasta el 08/10)", listaModelosPrueba("gemini-3.5-flash-lite"), ["gemini-3.5-flash-lite"]);
igual("varios, en orden", listaModelosPrueba("gemini-3.5-flash-lite,mistral-small-latest"), ["gemini-3.5-flash-lite", "mistral-small-latest"]);
igual("con espacios y comas de más", listaModelosPrueba(" gemini-3.5-flash-lite , ,mistral-small-latest, "), ["gemini-3.5-flash-lite", "mistral-small-latest"]);
igual("repetido: una vez", listaModelosPrueba("a,b,a"), ["a", "b"]);
igual("sin clave o vacía: ninguno (la prueba usa la cadena, como antes)", [listaModelosPrueba(null), listaModelosPrueba(undefined), listaModelosPrueba("  ")], [[], [], []]);
igual(`a lo sumo ${MAX_MODELOS_PRUEBA}`, listaModelosPrueba("a,b,c,d,e,f,g").length, MAX_MODELOS_PRUEBA);

const ids = Array.from({ length: MAX_MODELOS_PRUEBA }, (_, i) => idModeloPrueba(i));
igual("el primero sigue siendo -1", ids[0], -1);
igual("todos negativos (markModelDown no los marca caídos)", ids.every((i) => i < 0), true);
igual("todos distintos (el loop saltea por id el que falló)", new Set(ids).size, ids.length);
igual("ninguno es -2 (reintento del modelo fijo de pedidos) ni 0 (respaldo del env)", ids.includes(-2) || ids.includes(0), false);

// Pablo, 08/10: la corrida automática de evaluación nunca gasta, aunque alguien deje Haiku en llm_modelo_pruebas mientras corre un caso.
const cands = [{ model: "gemini-3.5-flash-lite", isFreeTier: true }, { model: "claude-haiku-4-5-20251001", isFreeTier: false }, { model: "gemini-3.1-flash-lite", isFreeTier: true }];
igual("sólo gratis: quedan los dos Gemini, en orden", soloModelosGratis(cands).map((c) => c.model), ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
igual("sólo gratis: con Haiku solo, no queda ninguno (no se llama a nada)", soloModelosGratis([cands[1]]), []);
igual("sólo gratis: un modelo que el Simulador no reconoce cuenta como pago (isFreeTier false)", soloModelosGratis([{ model: "x", isFreeTier: false }]).length, 0);

// Pablo, 08/10: espera por la cuota por minuto del plan gratis (Gemma 4 26B: 16.000 tokens de entrada por minuto).
// Mensaje real de Google del 08/10 (recortado).
const g429 = 'Google 429: { "error": { "code": 429, "message": "You exceeded your current quota. * Quota exceeded for metric: ' +
  'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 16000, model: gemma-4-26b\\nPlease retry in 45.855536296s.", "status": "RESOURCE_EXHAUSTED" } }';
igual("429 por minuto al principio del turno: espera lo que pide Google + 1 s", esperaPorCuotaDePrueba(429, g429, 10_000), 46_856);
igual("429 por minuto, también con retryDelay", esperaPorCuotaDePrueba(429, 'quota "retryDelay": "20s"', 0), 21_000);
igual("no entra en el presupuesto del turno (110 s con la llamada siguiente): no espera", esperaPorCuotaDePrueba(429, g429, 40_000), 0);
igual("justo en el borde del presupuesto: espera", esperaPorCuotaDePrueba(429, "retry in 49s", PRESUPUESTO_TURNO_PRUEBA_MS - 30_000 - 50_000), 50_000);
igual("cuota por día: no espera (no se arregla en un minuto)", esperaPorCuotaDePrueba(429, "GenerateRequestsPerDayPerProjectPerModel retry in 10s", 0), 0);
igual("429 sin 'retry in': no espera", esperaPorCuotaDePrueba(429, "Too Many Requests", 0), 0);
igual("Google pide más de un minuto: no espera", esperaPorCuotaDePrueba(429, "retry in 75s", 0), 0);
igual("otros errores (500, 503, timeout): no espera", [esperaPorCuotaDePrueba(500, "retry in 5s", 0), esperaPorCuotaDePrueba(503, "retry in 5s", 0), esperaPorCuotaDePrueba(undefined, "Timeout 30000ms", 0)], [0, 0, 0]);
// El loop vuelve a llamar esperando cada vez: con el tiempo que pasa, el presupuesto corta solo.
let transcurrido = 12_000, esperas = 0;
for (let i = 0; i < 10; i++) { const e = esperaPorCuotaDePrueba(429, "retry in 30s", transcurrido); if (!e) break; esperas++; transcurrido += e + 10_000; }
igual("esperas repetidas: el presupuesto las corta (una sola con 12 s ya pasados)", esperas, 1);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
