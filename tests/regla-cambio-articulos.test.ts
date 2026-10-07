// Que la regla CAMBIO DE ARTÍCULOS (Pablo Olejavetzky, 07/10/2026, corrección m7: «Si no salió, cambiar a batidor pera y sacar paleta batidora») siga en el prompt del agente, con o sin pedidos por
// WhatsApp, y con el texto que aprobó Pablo. Es una prueba del TEXTO del prompt (agente-fijos.ts): no prueba al modelo, sólo evita que la regla se pierda sin que nadie se entere.
// Correr: node --experimental-strip-types --no-warnings tests/regla-cambio-articulos.test.ts   (sale con código 1 si algo falla)
import { reglasOperativas } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
for (const [modo, txt] of [["con pedidos por WhatsApp", reglasOperativas(true)], ["sin pedidos por WhatsApp", reglasOperativas(false)]] as const) {
  ok(`${modo}: la regla está`, /- CAMBIO DE ART[IÍ]CULOS \(Pablo, 07\/10, m7/.test(txt));
  ok(`${modo}: cambiar, sacar, o sacar y sumar es un CAMBIO, no un agregado`, /cambiar un art[ií]culo por otro, sacar uno, o sacar y sumar en el mismo mensaje es un CAMBIO, no un agregado/.test(txt) && /no uses solicitar_agregado_pedido/.test(txt));
  ok(`${modo}: no pide confirmar el pedido ni la fecha`, /no le pidas que confirme el pedido ni le preguntes la fecha/.test(txt));
  ok(`${modo}: sin pedido nombrado toma el más reciente que no salió`, /tom[aá] el m[aá]s reciente que todav[ií]a no sali[oó] y nombralo por su fecha/.test(txt));
  ok(`${modo}: deriva en ese mismo turno con cambio_pedido, urgente si está programado o facturado`, /Deriv[aá] en ESE mismo turno con derivar_a_persona \(motivo «cambio_pedido»/.test(txt) && /urgente: true si el pedido est[aá] programado o facturado/.test(txt));
  ok(`${modo}: el texto que aprobó Pablo`, txt.includes("«Le paso el cambio a Ventas: si tu pedido del 02/10 todavía no salió, sacan la paleta batidora y suman el batidor pera, y te confirman por acá. 🙏»"));
  ok(`${modo}: sin backticks (rompen la plantilla)`, !txt.includes("`"));
}
ok("la regla es UNA sola línea (reglasOperativas reemplaza línea por línea)", reglasOperativas(false).split("\n").filter((l) => l.startsWith("- CAMBIO DE ARTÍCULOS")).length === 1);
if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
