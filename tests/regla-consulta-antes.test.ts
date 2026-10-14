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
  // 13/10, «precio del automate» (m72 en versión corta): Haiku 5.5 acertó 1 de 4 y, con una sola frase de regla, 4 de 10: en el resto pidió el nombre o el código sin llamar a buscar_productos.
  // 14/10: la regla pasa a llevar un ejemplo (con modelos chicos pesa más que la instrucción sola).
  ok(`${modo}: «el X» / «la X» que podría ser un artículo, aunque no lo conozca o suene raro: busca con buscar_productos ANTES de preguntar el nombre o el código`, /Si pide el precio, el stock o un dato de «el X» o «la X» y X podr[ií]a ser un art[ií]culo, aunque no lo conozcas o te suene raro, llam[aá] buscar_productos con X ANTES de preguntarle el nombre o el c[oó]digo/.test(txt));
  ok(`${modo}: la búsqueda reconoce artículos inactivos por nombre y cuesta una sola consulta`, /reconoce tambi[eé]n art[ií]culos inactivos por nombre y cuesta una sola consulta/.test(txt));
  ok(`${modo}: trae el ejemplo «precio del X» → buscar_productos sin preguntar nada`, /Ejemplo: el cliente escribe «precio del X» → llam[aá]s buscar_productos con query «X» sin preguntarle nada/.test(txt));
  ok(`${modo}: el ejemplo cubre el artículo inactivo («no está disponible por el momento»)`, /«El X \(c[oó]d\. N\) no est[aá] disponible por el momento» si trae no_disponibles/.test(txt));
  ok(`${modo}: sólo si la búsqueda no devuelve nada pide otro nombre o el código`, /s[oó]lo si no devuelve nada le ped[ií]s otro nombre o el c[oó]digo/.test(txt));
  ok(`${modo}: pregunta sólo lo que ninguna herramienta puede decir`, /Preguntale s[oó]lo lo que ninguna herramienta te puede decir/.test(txt));
  // 13/10, ronda 2 con Haiku 5.5: m16 («Anulá todo el pedido») y m37 («El jueves lo retiro») seguían preguntando de qué pedido se trataba.
  ok(`${modo}: «el pedido» sin decir cuál: no pregunta de cuál ni la fecha`, /Si habla de «el pedido» sin decir cu[aá]l \(anular, retirar, cambiar, preguntar cu[aá]ndo llega\), NO le preguntes de cu[aá]l se trata ni de qu[eé] fecha es/.test(txt));
  ok(`${modo}: toma el más reciente que no salió y lo nombra por su fecha`, /miralo con consultar_mis_pedidos, tom[aá] el m[aá]s reciente que todav[ií]a no sali[oó] y nombralo por su fecha/.test(txt));
  ok(`${modo}: sólo pregunta entre VARIOS pedidos pendientes`, /a cu[aá]l de VARIOS pedidos pendientes se refiere/.test(txt));
  // 13/10, ronda 2 con Haiku 5.5: con la regla ya no derivaba el cambio de artículo (m7) y en m73 ofrecía derivar en vez de derivar.
  ok(`${modo}: no reemplaza a las de derivación (cambio, anulación, dato que ninguna herramienta tiene)`, /Esta regla NO reemplaza a las de derivaci[oó]n: si es un cambio o una anulaci[oó]n de pedido, o ninguna herramienta tiene el dato que pide, der[ií]v[aá] igual con derivar_a_persona en ese mismo turno/.test(txt));
  ok(`${modo}: no pregunta si quiere que derive`, /no le preguntes si quer[eé]s que lo derives/.test(txt));
  ok(`${modo}: sin backticks (rompen la plantilla)`, !txt.includes("`"));
}
ok("la regla es UNA sola línea", reglasOperativas(false).split("\n").filter((l) => l.startsWith("- CONSULTÁ ANTES DE PREGUNTAR")).length === 1);
if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
