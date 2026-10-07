// Que la regla NO INVENTES TIEMPOS NI CÓMO FUNCIONA EL SISTEMA (Pablo Olejavetzky, 07/10/2026, corrección m1: «por lo general demora unos minutos en aparecer en el sistema» era un dato inventado)
// siga en el prompt del agente, con o sin pedidos por WhatsApp. Es una prueba del TEXTO del prompt (agente-fijos.ts): no prueba al modelo, sólo evita que la regla se pierda sin que nadie se entere.
// Correr: node --experimental-strip-types --no-warnings tests/regla-no-inventa-tiempos.test.ts   (sale con código 1 si algo falla)
import { reglasOperativas } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
for (const [modo, txt] of [["con pedidos por WhatsApp", reglasOperativas(true)], ["sin pedidos por WhatsApp", reglasOperativas(false)]] as const) {
  ok(`${modo}: la regla está`, /- NO INVENTES TIEMPOS NI C[OÓ]MO FUNCIONA EL SISTEMA \(Pablo, 07\/10, m1/.test(txt));
  ok(`${modo}: no explica por qué un pedido no aparece ni cuánto tarda (con el ejemplo prohibido)`, /nunca expliques por qu[eé] un pedido no aparece ni cu[aá]nto tarda en aparecer/.test(txt) && txt.includes("«por lo general demora unos minutos en aparecer en el sistema»"));
  ok(`${modo}: los pedidos de la web se ven en cuanto se hacen`, /los pedidos de la web se ven en cuanto se hacen/.test(txt));
  ok(`${modo}: si no figura el pedido que dice, lo dice sin explicar y deriva con pedido_no_encontrado en ese turno`, /decile que no te figura ese pedido, sin explicar por qu[eé]/.test(txt) && /en ESE mismo turno con derivar_a_persona \(motivo «pedido_no_encontrado»\)/.test(txt));
  ok(`${modo}: si figura otro pedido, cuenta ése y aclara que el otro no figura`, /Si figura otro pedido, contale [eé]se \(con su estado y su fecha\) y aclarale que el que dice no te figura/.test(txt));
  ok(`${modo}: nunca promete que va a aparecer`, /Nunca prometas que va a aparecer/.test(txt));
  ok(`${modo}: sin backticks (rompen la plantilla)`, !txt.includes("`"));
}
ok("la regla es UNA sola línea (reglasOperativas reemplaza línea por línea)", reglasOperativas(false).split("\n").filter((l) => l.startsWith("- NO INVENTES TIEMPOS")).length === 1);
if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
