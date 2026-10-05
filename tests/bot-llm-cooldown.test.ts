// Pruebas de cuánto queda caído un modelo tras fallar (supabase/functions/_shared/bot-llm.ts `cooldownParaError`). Sin red.
// Correr: deno run --allow-env tests/bot-llm-cooldown.test.ts   (sale con código 1 si algo falla)
// bot-llm.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { cooldownParaError } = await import("../supabase/functions/_shared/bot-llm.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const MIN = 60_000, CINCO = 5 * 60_000;

// El 429 real de Gemini gratis (05/10/2026, guardado en bot_llm_intentos.error): cuota por minuto, "retry in 33 s".
const real429 = 'Google 429: {\n  "error": {\n    "code": 429,\n    "message": "You exceeded your current quota, please check your plan and billing details. ' +
  'For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \\n' +
  '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, model: gemini-3.5-flash-lite\\nPlease retry in 33.014935106s.",\n' +
  '    "status": "RESOURCE_EXHAUSTED"';

igual("429 de Gemini real (33 s): se aplica el piso de 60 s", cooldownParaError(429, real429), MIN);
igual("429 con retry in 90 s: se espera lo que pide Google", cooldownParaError(429, "Google 429: Please retry in 90.2s."), 90_200);
igual("429 con retry in 900 s: no pasa de 5 min", cooldownParaError(429, "Google 429: Please retry in 900s."), CINCO);
igual("429 con retryDelay en el detalle (75 s)", cooldownParaError(429, 'Google 429: {"retryDelay": "75s"}'), 75_000);
igual("429 sin dato de espera: 60 s", cooldownParaError(429, "Google 429: RESOURCE_EXHAUSTED"), MIN);
igual("429 de cuota por día: 5 min", cooldownParaError(429, "Google 429: GenerateRequestsPerDayPerProjectPerModel-FreeTier. Please retry in 33s."), CINCO);
igual("429 de otro proveedor (Anthropic, sin 'retry in')", cooldownParaError(429, "Anthropic 429: rate_limit_error"), MIN);

// Todo lo demás sigue en 5 min: no se arregla en un minuto.
igual("503 (alta demanda): 5 min", cooldownParaError(503, "Google 503: UNAVAILABLE. Please retry in 33s."), CINCO);
igual("timeout (sin código): 5 min", cooldownParaError(undefined, "Timeout 30000ms"), CINCO);
igual("401 (clave inválida): 5 min", cooldownParaError(401, "Google 401: API key not valid"), CINCO);
igual("404 (modelo inexistente): 5 min", cooldownParaError(404, "Google 404: model not found"), CINCO);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
