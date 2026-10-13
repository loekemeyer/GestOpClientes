// Que la regla CONSULTÁ ANTES DE PREGUNTAR (Pablo Olejavetzky, 13/10/2026) siga en el prompt del agente, con o sin pedidos por WhatsApp. Nace de la comparación de modelos del 13/10:
// Haiku 5.5 le pedía al cliente un dato que el sistema ya tiene (m4, m16, m37, m72 y m73) y Sonnet 4.6 lo consultaba. Es una prueba del TEXTO del prompt (agente-fijos.ts): no prueba al modelo, sólo evita que la regla se pierda.
// Correr: node --experimental-strip-types --no-warnings tests/regla-consulta-antes.test.ts   (sale con código 1 si algo falla)
import { reglasOperativas } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
for (const [modo, txt] of [["con pedidos por WhatsApp", reglasOperativas(true)], ["sin pedidos por WhatsApp", reglasOperativas(false)]] as const) {
  ok(`${modo}: la regla está`, /- CONSULT[AÁ] ANTES DE PREGUNTAR \(Pablo, 13\/10, casos m4, m16, m37, m72 y m73/.test(txt));
  ok(`${modo}: manda a usar la herramienta ANTES de preguntar`, /usala ANTES de preguntarle al cliente/.test(txt));
  ok(`${modo}: nombra las cuatro herramientas de consulta`, ["consultar_mis_pedidos", "consultar_mi_entrega", "buscar_productos", "consultar_kb"].every((h) => txt.includes(h)));
  ok(`${modo}: no pide la fecha del pedido ni el código ni el nombre completo del artículo`, /No le pidas la fecha del pedido, el c[oó]digo ni el nombre completo de un art[ií]culo si pod[eé]s buscarlos vos/.test(txt));
  ok(`${modo}: pregunta sólo lo que ninguna herramienta puede decir`, /Preguntale s[oó]lo lo que ninguna herramienta te puede decir/.test(txt));
  ok(`${modo}: sin backticks (rompen la plantilla)`, !txt.includes("`"));
}
ok("la regla es UNA sola línea", reglasOperativas(false).split("\n").filter((l) => l.startsWith("- CONSULTÁ ANTES DE PREGUNTAR")).length === 1);
if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
