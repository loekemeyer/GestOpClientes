// Que la regla NO REPITAS EL ARTÍCULO (Pablo Olejavetzky, 08/10/2026, Chef 411: «Ahí es como que sos redundante, repetís varias veces el nombre del producto») siga en el
// prompt del agente, con o sin pedidos por WhatsApp, con el texto que aprobó Pablo. Con Sonnet 4.6 el agente contestaba «Sobre el Pelador Mgo Plástico (cód. 505): Pelador Mgo
// Plástico (cód. 505) tiene stock disponible», porque la regla STOCK le pedía pasar el texto de consultar_stock «tal cual» y ese texto ya trae el nombre.
// Es una prueba del TEXTO del prompt (agente-fijos.ts): no prueba al modelo, sólo evita que la regla se pierda sin que nadie se entere.
// Correr: node --experimental-strip-types --no-warnings tests/regla-no-repite-articulo.test.ts   (sale con código 1 si algo falla)
import { reglasOperativas } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
const APROBADO = "«No tenés pedidos registrados en este momento. El Pelador Mgo Plástico (cód. 505) tiene stock disponible. ✅ Ahora bien, viene en cajas de 12 unidades. 200 docenas son 2.400 unidades, lo que equivale a 200 cajas exactas. ¿Querés que te tomemos el pedido?»";
for (const [modo, txt] of [["con pedidos por WhatsApp", reglasOperativas(true)], ["sin pedidos por WhatsApp", reglasOperativas(false)]] as const) {
  ok(`${modo}: la regla está`, /- NO REPITAS EL ART[IÍ]CULO \(Pablo, 08\/10, Chef 411/.test(txt));
  ok(`${modo}: una sola vez por mensaje, con nombre y código la primera vez`, /nombr[aá] cada art[ií]culo UNA sola vez por mensaje, con su nombre y su c[oó]digo la primera vez/.test(txt));
  ok(`${modo}: no antepone «Sobre el …:» al texto de una herramienta`, txt.includes("no le antepongas «Sobre el …:» ni lo repitas"));
  ok(`${modo}: el texto que aprobó Pablo`, txt.includes(APROBADO));
  ok(`${modo}: el ejemplo nombra el 505 una sola vez`, APROBADO.split("Pelador Mgo Plástico").length - 1 === 1);
  ok(`${modo}: el ejemplo es de redacción, no cambia cuándo derivar`, /qu[eé] contestar y si derivar lo deciden las dem[aá]s reglas/.test(txt));
  ok(`${modo}: STOCK ya no pide pasar el texto «tal cual»`, !/pas[aá] su texto tal cual/.test(txt) && /si en el mismo mensaje ya nombraste el art[ií]culo, sin volver a nombrarlo/.test(txt));
  ok(`${modo}: STOCK sigue sin números y sin cambiar el resultado`, /pas[aá] lo que dice su texto sin cambiar el resultado y sin n[uú]meros/.test(txt));
  ok(`${modo}: sin backticks (rompen la plantilla)`, !txt.includes("`"));
}
ok("la regla es UNA sola línea (reglasOperativas reemplaza línea por línea)", reglasOperativas(false).split("\n").filter((l) => l.startsWith("- NO REPITAS EL ARTÍCULO")).length === 1);
if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
