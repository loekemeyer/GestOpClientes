// Haiku 5.5 en lugar de Haiku 4.5 (supabase/functions/_shared/anthropic-extras.ts). Pablo Olejavetzky, 09/10/2026. Sin red, sin IA, US$ 0.
// Correr: deno run tests/anthropic-extras.test.ts   (sale con código 1 si algo falla)
import { devuelvePensamiento, extrasAnthropic, sinMuestreo, textoAnthropic } from "../supabase/functions/_shared/anthropic-extras.ts";

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

// Sonnet 5.5: pensamiento adaptativo (no se manda "thinking": "disabled" da 400) con esfuerzo bajo, y devuelve bloques de pensamiento.
igual("sonnet 5.5: esfuerzo bajo, 4096 de salida, sin thinking", extrasAnthropic("claude-sonnet-5-5"), { max_tokens: 4096, output_config: { effort: "low" } });
igual("sin temperature: haiku 5.5 y sonnet 5.5 sí, 4.x no", [sinMuestreo("claude-haiku-5-5"), sinMuestreo("claude-sonnet-5-5"), sinMuestreo("claude-sonnet-4-6"), sinMuestreo("claude-haiku-4-5")], [true, true, false, false]);
igual("devuelve pensamiento: sólo sonnet 5.5", [devuelvePensamiento("claude-sonnet-5-5"), devuelvePensamiento("claude-haiku-5-5"), devuelvePensamiento("claude-sonnet-4-6")], [true, false, false]);

// El texto se toma de los bloques "text", no del primero (con el pensamiento prendido el primero puede ser un bloque de pensamiento).
igual("texto con un bloque de pensamiento adelante", textoAnthropic([{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: "{\"ok\":1}" }]), "{\"ok\":1}");
igual("varios bloques de texto se juntan", textoAnthropic([{ type: "text", text: "a" }, { type: "tool_use", id: "t" }, { type: "text", text: "b" }]), "ab");
igual("sin contenido", textoAnthropic(undefined), "");
igual("bloque sin type con text cuenta", textoAnthropic([{ text: "hola" }]), "hola");
igual("bloque de pensamiento con texto no cuenta", textoAnthropic([{ type: "thinking", thinking: "x", text: "no" }, { type: "text", text: "sí" }]), "sí");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
