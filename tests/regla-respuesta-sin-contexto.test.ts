// Que la regla RESPUESTA SIN CONTEXTO (Pablo Olejavetzky, 07/10/2026, corrección m74: «Hola, sí, sí, lo pueden reemplazar») siga en el prompt del agente, con o sin pedidos por WhatsApp, y con
// el texto que aprobó Pablo. Es una prueba del TEXTO del prompt (agente-fijos.ts): no prueba al modelo, sólo evita que la regla se pierda sin que nadie se entere.
// Correr: node --experimental-strip-types --no-warnings tests/regla-respuesta-sin-contexto.test.ts   (sale con código 1 si algo falla)
import { reglasOperativas } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
for (const [modo, txt] of [["con pedidos por WhatsApp", reglasOperativas(true)], ["sin pedidos por WhatsApp", reglasOperativas(false)]] as const) {
  ok(`${modo}: la regla está`, /- RESPUESTA SIN CONTEXTO \(Pablo, 07\/10, m74/.test(txt));
  ok(`${modo}: contesta a un mensaje de una persona que el bot no ve`, /un mensaje que le mand[oó] una persona del equipo y que vos NO ves en la charla/.test(txt));
  ok(`${modo}: no pide contexto ni adivina`, /NO le pidas contexto ni adivines \(nunca digas «contame más», «contame un poco más tu consulta» ni «no tengo contexto»\)/.test(txt));
  ok(`${modo}: deriva en ese mismo turno con cambio_pedido y sus palabras textuales`, /en ESE mismo turno llam[aá] a derivar_a_persona \(motivo «cambio_pedido», con sus palabras textuales en el resumen\)/.test(txt));
  ok(`${modo}: responde SÓLO el texto aprobado`, /respondele S[OÓ]LO esto, casi literal/.test(txt));
  ok(`${modo}: el texto que aprobó Pablo`, txt.includes("«Gracias por avisarnos. Una persona de Ventas ve tu respuesta y te escribe por acá para confirmarte. 🙏»"));
  ok(`${modo}: no vale para un ok, dale o sí que contesta una pregunta del bot, ni para un gracias solo`, /No vale para un «ok», «dale» o «sí» que contesta una pregunta que acab[aá]s de hacerle vos, ni para un «gracias» solo/.test(txt));
  ok(`${modo}: sin backticks (rompen la plantilla)`, !txt.includes("`"));
}
ok("la regla es UNA sola línea (reglasOperativas reemplaza línea por línea)", reglasOperativas(false).split("\n").filter((l) => l.startsWith("- RESPUESTA SIN CONTEXTO")).length === 1);
if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
