// Que las dos reglas de «preguntar y no adivinar» (Pablo Olejavetzky, 15/10/2026, auditoría 835) sigan en el prompt del agente, con o sin pedidos por WhatsApp:
// (1) CONSULTÁ ANTES DE PREGUNTAR: si pidió UN artículo y encajan varios, no se da stock ni precio de todos: se pregunta cuál. (2) CHARLAS ANTERIORES: lo ofrecido
// en una charla de otro día no es «lo que te ofrecí» en esta, y ante «los otros» poco claro se pregunta. Es una prueba del TEXTO del prompt (agente-fijos.ts): no prueba al modelo.
// Correr: deno run tests/regla-preguntar-no-adivinar.test.ts   (sale con código 1 si algo falla)
import { reglasOperativas } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
for (const [modo, txt] of [["con pedidos por WhatsApp", reglasOperativas(true)], ["sin pedidos por WhatsApp", reglasOperativas(false)]] as const) {
  ok(`${modo}: CONSULTÁ ANTES DE PREGUNTAR tiene la excepción de varios candidatos`,
    /si pidi[oó] UN art[ií]culo y buscar_productos devuelve varios que podr[ií]an ser, no le des el stock ni el precio de todos ni elijas uno/.test(txt));
  ok(`${modo}: la excepción remite a PEDIDO SIN ERRORES y respeta el pedido de «todos»`, /preguntale cu[aá]l \(regla PEDIDO SIN ERRORES\)\. Cuando pide «todos»/.test(txt));
  ok(`${modo}: la regla de consultar antes sigue entera`, /CONSULT[AÁ] ANTES DE PREGUNTAR \(Pablo, 13\/10/.test(txt) && /Esta regla NO reemplaza a las de derivaci[oó]n/.test(txt));
  ok(`${modo}: CHARLAS ANTERIORES dice que lo de otro día no es «lo que te ofrecí» en esta charla`,
    /Lo que ofreciste en una charla anterior \(marca de otro d[ií]a\) no es «lo que te ofrec[ií]» en ESTA charla/.test(txt));
  ok(`${modo}: ante «los otros» poco claro, se pregunta a cuáles`, /si pregunta por «los otros», «los dem[aá]s» o «los de antes»[^.]*preguntale a cu[aá]les/.test(txt));
  ok(`${modo}: PEDIDO SIN ERRORES sigue (preferí preguntar de más)`, /Prefer[ií] SIEMPRE preguntar de m[aá]s a cargar el art[ií]culo equivocado/.test(txt));
}
if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
