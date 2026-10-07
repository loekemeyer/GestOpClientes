// Que la regla CANTIDAD TOTAL (Pablo Olejavetzky, 07/10/2026, corrección m8: «Agregá 3 cajas más de pelapapas 505, que sean 15») siga en el prompt del agente, con o sin pedidos por WhatsApp,
// y con los dos textos que aprobó Pablo. Es una prueba del TEXTO del prompt (agente-fijos.ts): no prueba al modelo, sólo evita que la regla se pierda sin que nadie se entere.
// Correr: node --experimental-strip-types --no-warnings tests/regla-cantidad-total.test.ts   (sale con código 1 si algo falla)
import { reglasOperativas } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
for (const [modo, txt] of [["con pedidos por WhatsApp", reglasOperativas(true)], ["sin pedidos por WhatsApp", reglasOperativas(false)]] as const) {
  ok(`${modo}: la regla está`, /- CANTIDAD TOTAL \(Pablo, 07\/10, m8/.test(txt));
  ok(`${modo}: «que sean 15» es el total de ese artículo en el pedido`, /esa cifra es el TOTAL de ese art[ií]culo en el pedido, no otras cajas/.test(txt));
  ok(`${modo}: mira las cajas del pedido con consultar_mis_pedidos`, /consultar_mis_pedidos cu[aá]ntas cajas tiene hoy ese art[ií]culo en el pedido/.test(txt));
  ok(`${modo}: texto (a), si la cuenta da`, txt.includes("«Tu pedido del 02/10 tiene 12 cajas del Pelador Mgo Plástico (cód. 505): con 3 más serían 15. ¿Confirmo agregar 3 cajas?»"));
  ok(`${modo}: texto (b), si no da`, txt.includes("«En tu pedido del 02/10 hay 10 cajas del Pelador Mgo Plástico (cód. 505). ¿Querés llegar a 15 en total (agregar 5) o agregar 3 (quedarían 13)?»"));
  ok(`${modo}: agrega por las cajas que SUMA, no por el total`, /solicitar_agregado_pedido por las cajas que SUMA, no por el total/.test(txt));
  ok(`${modo}: sin pedido nombrado toma el más reciente que no salió y no pregunta la fecha`, /tom[aá] el m[aá]s reciente que todav[ií]a no sali[oó]/.test(txt) && /no le preguntes de qu[eé] fecha es/.test(txt));
  ok(`${modo}: sin backticks (rompen la plantilla)`, !txt.includes("`"));
}
ok("la regla es UNA sola línea (reglasOperativas reemplaza línea por línea)", reglasOperativas(false).split("\n").filter((l) => l.startsWith("- CANTIDAD TOTAL")).length === 1);
if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
