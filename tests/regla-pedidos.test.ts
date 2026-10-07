// Que la regla de pedidos por WhatsApp siga pidiendo, en el mismo mensaje en que se confirman los artículos, la disponibilidad y el precio del cliente
// (Pablo Olejavetzky, 06/10/2026, corrección m12 del artifact: "tendría que chequear disponibilidad y dar el precio" → "el precio del cliente con su descuento").
// Es una prueba del TEXTO del prompt (agente-fijos.ts): no prueba al modelo, sólo evita que la regla se pierda sin que nadie se entere.
// Correr: node --experimental-strip-types --no-warnings tests/regla-pedidos.test.ts   (sale con código 1 si algo falla)
import { REGLA_PEDIDOS_WA } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
ok("chequea la disponibilidad de cada artículo con consultar_stock", /consultar_stock/.test(REGLA_PEDIDOS_WA) && /CADA art[ií]culo/.test(REGLA_PEDIDOS_WA));
ok("da el precio del cliente por caja (con su descuento por volumen)", /precio_cliente_por_caja/.test(REGLA_PEDIDOS_WA) && /descuento por volumen/.test(REGLA_PEDIDOS_WA));
ok("si no viene el del cliente, el de lista", /precio_lista_por_caja/.test(REGLA_PEDIDOS_WA));
ok("el total lo da armar_pedido, no el modelo", /NO calcules el total/.test(REGLA_PEDIDOS_WA) && /armar_pedido/.test(REGLA_PEDIDOS_WA));
ok("sigue preguntando siempre forma de pago y entrega", /Forma de pago: preguntala SIEMPRE/.test(REGLA_PEDIDOS_WA) && /Entrega: preguntala SIEMPRE/.test(REGLA_PEDIDOS_WA));
ok("con varias direcciones pregunta SIEMPRE para cuál es el pedido y no elige sola", /M[AÁ]S DE UNA direcci[oó]n/.test(REGLA_PEDIDOS_WA) && /nunca elijas una por tu cuenta/.test(REGLA_PEDIDOS_WA));
ok("si el cotizador ya se lo preguntó, usa la respuesta (slot) y no se la repite", /slot/.test(REGLA_PEDIDOS_WA) && /no se la repitas/.test(REGLA_PEDIDOS_WA));
// Pablo, 07/10 (m18 y m19): la web es la prioridad, pero si lo mandan por WhatsApp se toma.
ok("la web es la vía preferida: invita primero a la web", /la web es la v[ií]a preferida/.test(REGLA_PEDIDOS_WA) && /invitalo primero a la web/.test(REGLA_PEDIDOS_WA));
ok("dice que por la web hay un descuento extra, sin decir cuánto", /descuento extra \(sin decir cu[aá]nto\)/.test(REGLA_PEDIDOS_WA));
ok("si prefiere pasarlo por acá, también se toma", /tambi[eé]n lo tom[aá]s/.test(REGLA_PEDIDOS_WA));
ok("nunca dice que 'no hace falta' entrar a la web", /NUNCA le digas que "no hace falta" entrar a la web/.test(REGLA_PEDIDOS_WA));
ok("el pedido por WhatsApp sigue con sus pasos", /Cuando el pedido se hace por ac[aá], pod[eé]s tomarlo, siguiendo estos pasos sin saltear ninguno/.test(REGLA_PEDIDOS_WA));
ok("la regla sigue empezando con la marca que reemplaza a la línea de PEDIDOS", REGLA_PEDIDOS_WA.startsWith("- PEDIDOS POR WHATSAPP:"));
ok("prohíbe decir el porcentaje del descuento web al invitar a la web", /NUNCA digas el porcentaje ni la cifra del descuento/.test(REGLA_PEDIDOS_WA));
ok("primero la web, no las dos vías al mismo nivel", /Primero la web/.test(REGLA_PEDIDOS_WA) && /no pongas las dos v[ií]as al mismo nivel/.test(REGLA_PEDIDOS_WA));
ok("trae el modelo aprobado de m19 (¿tengo que entrar a la web?)", REGLA_PEDIDOS_WA.includes("Lo mejor es que lo hagas en la web: entrá a loekemeyer.com › Pedidos Mayorista con tu CUIT y tu clave."));
ok("trae el modelo aprobado de m18 (¿por acá o por otro medio?)", REGLA_PEDIDOS_WA.includes("La prioridad es la web (loekemeyer.com › Pedidos Mayorista, con tu CUIT y tu clave)"));
ok("los modelos de respuesta no llevan el porcentaje", !/\b2\s?%/.test(REGLA_PEDIDOS_WA.slice(REGLA_PEDIDOS_WA.indexOf("PRIORIDAD"), REGLA_PEDIDOS_WA.indexOf("Cuando el pedido se hace por ac"))));
// Pablo, 07/10 (m12): las formas de pago se muestran numeradas con "opcion" y sin los códigos internos; no se ofrece "Prefiero no decidir ahora"; si retira, se pregunta todo en el mismo mensaje.
ok("muestra las formas de pago numeradas con 'opcion' y nunca el condicion_code", /campo "opcion"/.test(REGLA_PEDIDOS_WA) && /nunca muestres el "condicion_code"/.test(REGLA_PEDIDOS_WA));
ok("al armar usa el condicion_code de la opción elegida", /usá el condicion_code de la opci[oó]n que eligi[oó]/.test(REGLA_PEDIDOS_WA));
ok("no ofrece 'Prefiero no decidir ahora'", /No ofrezcas "Prefiero no decidir ahora"/.test(REGLA_PEDIDOS_WA));
ok("si el cliente ya dijo que retira, pregunta en el mismo mensaje forma de pago, día y franja", /YA dijo que retira/.test(REGLA_PEDIDOS_WA) && /ESE mismo mensaje la forma de pago y el d[ií]a y la franja del retiro/.test(REGLA_PEDIDOS_WA));
ok("trae las frases aprobadas de m12 (artículos, forma de pago numerada, retiro)", REGLA_PEDIDOS_WA.includes("Confirmame los artículos:") && REGLA_PEDIDOS_WA.includes("¿Qué día y franja te quedan bien?") && REGLA_PEDIDOS_WA.includes("Y para el retiro: desde el <retiro_desde>"));
ok("el modelo de m12 no lleva los códigos de pago ni la opción 'no decidir'", !/\b(8|9|18) - /.test(REGLA_PEDIDOS_WA));

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
