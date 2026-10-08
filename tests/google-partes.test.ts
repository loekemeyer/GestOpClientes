// Pruebas de partesGoogle (supabase/functions/_shared/bot-llm.ts): qué parte de la respuesta de Google llega al cliente. Sin red.
// Pablo Olejavetzky, 08/10/2026: Gemma 4 (pesos abiertos, por la misma API de Google) devuelve su razonamiento como parts con
// `thought: true`, en inglés. Antes se pegaba adelante de la respuesta al cliente.
// Correr: deno run --allow-env tests/google-partes.test.ts   (sale con código 1 si algo falla)
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { partesGoogle } = await import("../supabase/functions/_shared/bot-llm.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Respuesta real de gemma-4-31b-it del 08/10 (recortada): razonamiento + pedido de herramienta.
const gemma = [
  { text: "*   User asks: \"Hola, tienen abrelatas rojos?\"\n    *   Tool: `buscar_producto`", thought: true },
  { functionCall: { id: "call_935682", args: { texto: "abrelatas rojos" }, name: "buscar_producto" }, thoughtSignature: "EiYK" },
];
const r1 = partesGoogle(gemma);
igual("Gemma: el razonamiento no llega al cliente", r1.text, "");
igual("Gemma: el pedido de herramienta sí sale", r1.toolCalls.map((t) => [t.name, t.input, t.thoughtSignature]),
  [["buscar_producto", { texto: "abrelatas rojos" }, "EiYK"]]);

// Gemma cuando contesta texto: razonamiento + respuesta.
const r2 = partesGoogle([{ text: "*   The user greets.", thought: true }, { text: "¡Hola! ¿En qué te ayudo?" }]);
igual("Gemma con texto: sólo la respuesta", r2.text, "¡Hola! ¿En qué te ayudo?");

// Gemini (sin parts de razonamiento): igual que antes.
const r3 = partesGoogle([{ text: "Hola, " }, { text: "te paso el estado." }]);
igual("Gemini: se unen los textos como antes", r3.text, "Hola, te paso el estado.");
igual("sin parts: vacío", partesGoogle([]), { text: "", toolCalls: [] });
igual("thought en false no se filtra", partesGoogle([{ text: "ok", thought: false }]).text, "ok");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
else console.log("\ntodo bien");
