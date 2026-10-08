// Pruebas del caché de prompt de Anthropic en el agente (supabase/functions/_shared/bot-llm.ts, cuerpoAnthropic y costoEstimado). Sin red.
// Pablo Olejavetzky, 08/10/2026: con más mensajes yendo al agente (los compuestos y los repetidos), el caché es lo que lo hace pagable. Medido el 08/10
// en bot_token_usage: las 29 llamadas de producción con Sonnet 4.6 de los últimos 14 días mandaron 11.167 tokens de entrada en promedio (US$ 0,0347
// cada una) y 10 de 14 turnos hicieron 2 llamadas o más (herramientas): desde la segunda, el prompt y las herramientas se leen del caché a 0,1×.
// Correr: deno run --allow-env tests/cache-anthropic.test.ts   (sale con código 1 si algo falla)
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { cuerpoAnthropic, costoEstimado, systemTexto, CACHE_ESCRITURA, CACHE_LECTURA } = await import("../supabase/functions/_shared/bot-llm.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const EPH = { type: "ephemeral" };
const tools = [
  { name: "consultar_mis_pedidos", description: "a", input_schema: { type: "object", properties: {} } },
  { name: "consultar_stock", description: "b", input_schema: { type: "object", properties: {} } },
];
// deno-lint-ignore no-explicit-any
const marcas = (b: any) => JSON.stringify(b).split('"cache_control"').length - 1;

// Turno con una herramienta: usuario → asistente con tool_use → resultado.
const hist = [
  { role: "user" as const, text: "¿Tenés hieleras?" },
  { role: "assistant" as const, text: "", toolCalls: [{ id: "t1", name: "consultar_stock", input: { q: "hielera" } }] },
  { role: "tool" as const, results: [{ id: "t1", name: "consultar_stock", content: "{\"encontrados\":0}" }] },
];
const b = cuerpoAnthropic("claude-sonnet-4-6", { estable: "REGLAS", variable: "NOTA DE TIEMPO" }, tools, hist);
igual("system en dos bloques, el estable con caché", b.system, [{ type: "text", text: "REGLAS", cache_control: EPH }, { type: "text", text: "NOTA DE TIEMPO" }]);
igual("la última herramienta con caché", b.tools[1].cache_control, EPH);
igual("las otras herramientas sin caché", b.tools[0].cache_control, undefined);
igual("no se toca el arreglo de herramientas compartido", (tools[1] as Record<string, unknown>).cache_control, undefined);
igual("el último mensaje (resultado de herramienta) con caché", b.messages.at(-1).content.at(-1).cache_control, EPH);
igual("no más de 4 marcas (límite de Anthropic)", marcas(b) <= 4, true);
igual("3 marcas", marcas(b), 3);

const b2 = cuerpoAnthropic("claude-sonnet-4-6", "TODO JUNTO", tools, [{ role: "user", text: "hola" }]);
igual("prompt de un solo texto: un bloque con caché", b2.system, [{ type: "text", text: "TODO JUNTO", cache_control: EPH }]);
igual("mensaje de texto del usuario pasa a bloque con caché", b2.messages[0].content, [{ type: "text", text: "hola", cache_control: EPH }]);
const b3 = cuerpoAnthropic("claude-sonnet-4-6", { estable: "REGLAS", variable: "  " }, [], [{ role: "user", text: "hola" }]);
igual("parte variable vacía: no se manda un bloque vacío", b3.system.length, 1);
igual("sin herramientas: 2 marcas", marcas(b3), 2);
igual("max_tokens sigue en 1024", b.max_tokens, 1024);

igual("systemTexto junta las dos partes igual que antes", systemTexto({ estable: "A", variable: "B" }), "A\n\nB");
igual("systemTexto sin parte variable", systemTexto({ estable: "A", variable: "" }), "A");

// Costo: Sonnet 4.6 a US$ 3 / 15 por millón.
const r = { input: 3, output: 15 };
igual("sin caché, igual que antes", costoEstimado({ inputTokens: 11_167, outputTokens: 81 }, r), (11_167 * 3 + 81 * 15) / 1e6);
igual("multiplicadores", [CACHE_ESCRITURA, CACHE_LECTURA], [1.25, 0.1]);
// Primera llamada del turno: escribe 11.000 en caché; segunda: lee esos 11.000 y escribe 300 nuevos.
const c1 = costoEstimado({ inputTokens: 11_167, outputTokens: 81, cacheWriteTokens: 11_000, cacheReadTokens: 0 }, r);
const c2 = costoEstimado({ inputTokens: 11_467, outputTokens: 81, cacheWriteTokens: 300, cacheReadTokens: 11_000 }, r);
igual("1ª llamada: 1,25× lo escrito", Math.round(c1 * 1e6), Math.round(167 * 3 + 11_000 * 3 * 1.25 + 81 * 15));
igual("2ª llamada: 0,1× lo leído", Math.round(c2 * 1e6), Math.round(167 * 3 + 300 * 3 * 1.25 + 11_000 * 3 * 0.1 + 81 * 15));
igual("un turno de 2 llamadas cuesta menos que sin caché", c1 + c2 < 2 * costoEstimado({ inputTokens: 11_300, outputTokens: 81 }, r), true);
igual("free tier sigue en 0", costoEstimado({ inputTokens: 5000, outputTokens: 50, cacheReadTokens: 4000 }, { input: 0, output: 0 }), 0);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
