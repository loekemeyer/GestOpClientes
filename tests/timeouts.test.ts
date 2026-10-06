// Pruebas del tope de espera por modelo (supabase/functions/_shared/timeouts.ts). Sin red, sin IA.
// Correr: deno run tests/timeouts.test.ts   (sale con código 1 si algo falla)
import { TIMEOUT_GEMINI_MS, TIMEOUT_MODELO_MS, timeoutDeModelo } from "../supabase/functions/_shared/timeouts.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

igual("Gemini (google): 8 s", timeoutDeModelo("google"), 8_000);
igual("Sonnet y Haiku (anthropic): 30 s", timeoutDeModelo("anthropic"), 30_000);
igual("un proveedor compatible con OpenAI (groq, openai…): 30 s", [timeoutDeModelo("openai"), timeoutDeModelo("groq")], [30_000, 30_000]);
igual("proveedor vacío o desconocido: 30 s (no se acorta lo que no se midió)", [timeoutDeModelo(""), timeoutDeModelo("otro")], [30_000, 30_000]);
igual("el tope de Gemini es menor que el del resto", TIMEOUT_GEMINI_MS < TIMEOUT_MODELO_MS, true);
// Margen sobre lo medido en bot_llm_intentos (48 h, 06/10): p99 2.709 ms, máximo normal 4.498 ms.
igual("el tope de Gemini deja margen sobre el máximo normal medido (4.498 ms)", TIMEOUT_GEMINI_MS > 4_498 * 1.5, true);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
