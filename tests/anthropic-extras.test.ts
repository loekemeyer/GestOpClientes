// Haiku 5.5 en lugar de Haiku 4.5 (supabase/functions/_shared/anthropic-extras.ts). Pablo Olejavetzky, 09/10/2026. Sin red, sin IA, US$ 0.
// Correr: deno run tests/anthropic-extras.test.ts   (sale con código 1 si algo falla)
import { extrasAnthropic, textoAnthropic } from "../supabase/functions/_shared/anthropic-extras.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

igual("haiku 5.5: pensamiento apagado, esfuerzo bajo, 2048 de salida", extrasAnthropic("claude-haiku-5-5"),
  { max_tokens: 2048, thinking: { type: "disabled" }, output_config: { effort: "low" } });
igual("haiku 4.5 sin cambios", extrasAnthropic("claude-haiku-4-5-20251001"), {});
igual("sonnet 4.6 sin cambios", extrasAnthropic("claude-sonnet-4-6"), {});
igual("el cuerpo con los extras no lleva temperature", "temperature" in { model: "claude-haiku-5-5", max_tokens: 300, ...extrasAnthropic("claude-haiku-5-5") }, false);
igual("los extras pisan el max_tokens del que llama", { max_tokens: 300, ...extrasAnthropic("claude-haiku-5-5") }.max_tokens, 2048);

// El texto se toma de los bloques "text", no del primero (con el pensamiento prendido el primero puede ser un bloque de pensamiento).
igual("texto con un bloque de pensamiento adelante", textoAnthropic([{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: "{\"ok\":1}" }]), "{\"ok\":1}");
igual("varios bloques de texto se juntan", textoAnthropic([{ type: "text", text: "a" }, { type: "tool_use", id: "t" }, { type: "text", text: "b" }]), "ab");
igual("sin contenido", textoAnthropic(undefined), "");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
