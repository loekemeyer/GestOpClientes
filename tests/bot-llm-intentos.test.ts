// Pruebas del registro de intentos a modelos de IA (sql/126, supabase/functions/_shared/bot-llm.ts `logIntento`). Sin red.
// Correr: deno run --allow-env tests/bot-llm-intentos.test.ts   (sale con código 1 si algo falla)
// bot-llm.ts importa _shared/supabase.ts, que arma el cliente al cargar: URL y clave falsas, y `fetch` pisado para ver qué se mandaría.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");

const enviados: { url: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("/rest/v1/bot_llm_intentos")) {
    enviados.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(new Response(null, { status: 201 }));
  }
  return Promise.reject(new Error(`fetch inesperado: ${url}`));
}) as typeof fetch;

const { limpiarErrorLlm, logIntento } = await import("../supabase/functions/_shared/bot-llm.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// La clave de Google no se guarda: Deno pone la URL del request en el mensaje de un error de red.
const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=AIzaSyFAKE-clave_123";
igual("saca ?key= de la URL", limpiarErrorLlm(`error sending request for url (${url}): connection reset`).includes("AIzaSy"), false);
igual("deja la marca", limpiarErrorLlm(`x (${url})`).includes("?key=***"), true);
igual("saca &key= en medio", limpiarErrorLlm("https://x.test/a?alt=json&key=SECRETA&z=1"), "https://x.test/a?alt=json&key=***&z=1");
igual("un 503 de Google queda igual", limpiarErrorLlm("Google 503: UNAVAILABLE"), "Google 503: UNAVAILABLE");
igual("corta a 800", limpiarErrorLlm("x".repeat(1000)).length, 800);
igual("un error de 700 no se corta", limpiarErrorLlm("y".repeat(700)).length, 700);

// La fila que se manda: éxito y falla.
logIntento({ funcion: "lk_bot-simular", modeloId: -1, proveedor: "google", modelo: "gemini-3.5-flash-lite", tarea: "conversacion",
  iteracion: 1, ok: true, duracionMs: 1234.6, inputTokens: 7555, outputTokens: 23 });
logIntento({ funcion: "lk_whatsapp-webhook", modeloId: 29, proveedor: "google", modelo: "gemini-3.5-flash-lite", tarea: "conversacion",
  iteracion: 2, ok: false, httpStatus: 429, error: `Google 429: RESOURCE_EXHAUSTED (${url})`, duracionMs: 480 });
logIntento({ funcion: "lk_whatsapp-webhook", modeloId: 29, proveedor: "google", modelo: "gemini-3.5-flash-lite",
  iteracion: 1, ok: false, error: "Timeout 30000ms", duracionMs: 30001 });
await new Promise((r) => setTimeout(r, 50)); // el insert no se espera: se le da un respiro

igual("se mandaron 3 filas", enviados.length, 3);
igual("fila ok", enviados[0]?.body, {
  funcion: "lk_bot-simular", modelo_id: -1, proveedor: "google", modelo: "gemini-3.5-flash-lite", tarea: "conversacion",
  iteracion: 1, ok: true, http_status: null, error: null, duracion_ms: 1235, input_tokens: 7555, output_tokens: 23,
});
igual("fila 429: código y sin clave", [enviados[1]?.body.http_status, String(enviados[1]?.body.error).includes("AIzaSy")], [429, false]);
igual("timeout: sin código, con duración", [enviados[2]?.body.http_status, enviados[2]?.body.duracion_ms, enviados[2]?.body.tarea], [null, 30001, null]);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
