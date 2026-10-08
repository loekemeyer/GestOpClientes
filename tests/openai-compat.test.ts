// Pruebas de la traducción del historial al formato de OpenAI y compatibles (supabase/functions/_shared/openai-compat.ts). Sin red, sin IA.
// Correr: deno run tests/openai-compat.test.ts   (sale con código 1 si algo falla)
import { idToolMistral, OPENAI_COMPAT, toOpenAIMessages } from "../supabase/functions/_shared/openai-compat.ts";
import type { NormMsg } from "../supabase/functions/_shared/bot-llm.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const NUEVE = /^[a-zA-Z0-9]{9}$/;
const uuid = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f8a9b0c";   // lo que pone bot-llm a un functionCall de Gemini
const toolu = "toolu_01A09q90qw90lq917835lq9";          // un id de Anthropic

igual("Mistral está entre los compatibles, con su URL", OPENAI_COMPAT.mistral?.url, "https://api.mistral.ai/v1/chat/completions");
igual("un id de Gemini (UUID) sale con 9 alfanuméricos", NUEVE.test(idToolMistral(uuid)), true);
igual("un id de Anthropic sale con 9 alfanuméricos", NUEVE.test(idToolMistral(toolu)), true);
igual("un id vacío también", NUEVE.test(idToolMistral("")), true);
igual("el mismo id da siempre lo mismo (aparea pedido y resultado)", idToolMistral(uuid), idToolMistral(uuid));
igual("un id que ya es de Mistral pasa igual", idToolMistral("D681PevKs"), "D681PevKs");
igual("ids distintos dan valores distintos", idToolMistral(uuid) !== idToolMistral(toolu), true);
// 2.000 UUID: sin choques (dos herramientas del mismo turno con el mismo id se aparearían mal).
const vistos = new Set<string>();
for (let i = 0; i < 2000; i++) vistos.add(idToolMistral(crypto.randomUUID()));
igual("2.000 UUID dan 2.000 ids distintos", vistos.size, 2000);

const historia: NormMsg[] = [
  { role: "user", text: "¿Tenés el 505?" },
  { role: "assistant", text: "", toolCalls: [{ id: uuid, name: "consultar_stock", input: { codigo: "505" } }] },
  { role: "tool", results: [{ id: uuid, name: "consultar_stock", content: "{\"stock\":12}" }] },
];

const mis = toOpenAIMessages("sistema", historia, "mistral");
igual("Mistral: el pedido y el resultado de la herramienta llevan el mismo id de 9",
  [NUEVE.test(mis[2].tool_calls[0].id), mis[2].tool_calls[0].id === mis[3].tool_call_id], [true, true]);
igual("Mistral: el asistente que sólo pide herramientas va con content \"\" (no null)", mis[2].content, "");
igual("Mistral: el resultado lleva el nombre de la herramienta", mis[3].name, "consultar_stock");

const oai = toOpenAIMessages("sistema", historia, "openai");
igual("OpenAI y Groq: sin cambios (id original, content null, sin name)",
  [oai[2].tool_calls[0].id, oai[2].content, oai[3].tool_call_id, "name" in oai[3]], [uuid, null, uuid, false]);
igual("sin proveedor: como OpenAI", toOpenAIMessages("sistema", historia), oai);
igual("el sistema va primero", oai[0], { role: "system", content: "sistema" });

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
