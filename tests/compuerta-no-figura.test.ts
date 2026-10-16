// Pruebas de la compuerta «no figura ese pedido» (supabase/functions/_shared/compuerta-no-figura.ts). Sin red, sin IA.
// Correr: deno run tests/compuerta-no-figura.test.ts   (sale con código 1 si algo falla)
import { AVISO_VENTAS_NO_FIGURA, conAvisoDeVentas, debeDerivarNoFigura, diceQueHizoPedido, respuestaNoFigura } from "../supabase/functions/_shared/compuerta-no-figura.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// diceQueHizoPedido: el cliente dice que hizo o mandó un pedido (casos reales de wa_agente_evals).
igual("m1 «Pasé un pedido por la web»", diceQueHizoPedido("Pasé un pedido por la web, ¿lo recibieron?"), true);
igual("m4 «metí un pedido el 17/9»", diceQueHizoPedido("Te aviso que metí un pedido el 17/9 por la página"), true);
igual("m58 «pedido realizado el día 18 de marzo»", diceQueHizoPedido("Tenemos un pedido realizado el día 18 de marzo y todavía no nos llegó la mercadería"), true);
igual("m3 «Recién cargué un pedido»", diceQueHizoPedido("Recién cargué un pedido por la página, me avisás cuándo lo puedo pasar a buscar"), true);
igual("«hicimos un pedido»", diceQueHizoPedido("hicimos un pedido el lunes"), true);
igual("«¿cuándo llega mi pedido NP-123?» no", diceQueHizoPedido("¿Cuándo llega mi pedido NP-123?"), false);
igual("«quiero hacer un pedido» no", diceQueHizoPedido("Quiero hacer un pedido, ¿tengo que entrar en la página?"), false);
igual("«te paso el cotizador con el pedido» no (pasar algo ahora no es haberlo hecho)", diceQueHizoPedido("Te paso el cotizador con el pedido"), false);

// respuestaNoFigura: la respuesta dice que el pedido no figura.
igual("texto aprobado «No me figura ese pedido»", respuestaNoFigura("No me figura ese pedido. Lo que veo es tu pedido del 02/10, que ya fue retirado el 07/10."), true);
igual("«No te figura ningún pedido del 17/9»", respuestaNoFigura("No te figura ningún pedido del 17/9. Tus pedidos más recientes son:"), true);
igual("«no veo ningún pedido del 18 de marzo»", respuestaNoFigura("No veo ningún pedido del 18 de marzo en tu cuenta."), true);
igual("«en ese pedido no figura la paleta» no", respuestaNoFigura("Además, en ese pedido no figura la paleta batidora."), false);
igual("lista de pedidos normal no", respuestaNoFigura("Este es tu pedido que falta retirar:\n\n1️⃣ Pedido del 15/10: facturado."), false);

// debeDerivarNoFigura: las tres condiciones juntas, sin derivación en el turno y fuera de la toma de pedidos.
const m4 = "Te aviso que metí un pedido el 17/9 por la página";
const r4 = "No te figura ningún pedido del 17/9. Tus pedidos más recientes son:\n\n- Tu pedido del 15/10: facturado.\n\n¿El pedido del 17/9 es alguno de estos, o es uno que no aparece? Si no figura, le paso el aviso a una persona de Ventas para que lo revise y te escriba por este medio.";
igual("m4 sin derivar: derivar por código", debeDerivarNoFigura(m4, r4, ["consultar_mis_pedidos"], false), true);
igual("ya derivó: no", debeDerivarNoFigura(m4, r4, ["consultar_mis_pedidos", "derivar_a_persona"], false), false);
igual("turno de pedido: no", debeDerivarNoFigura(m4, r4, [], true), false);
igual("NP-123 (no dice que lo hizo): no", debeDerivarNoFigura("¿Cuándo llega mi pedido NP-123?", "No te figura ningún pedido con la referencia NP-123.", ["consultar_mis_pedidos"], false), false);
igual("respuesta que encontró el pedido: no", debeDerivarNoFigura("Pasé un pedido por la web, ¿lo recibieron?", "Sí, recibimos tu pedido del 15/10: está facturado y listo para retirar desde el martes 20/10.", ["consultar_mis_pedidos"], false), false);

// conAvisoDeVentas: saca la pregunta «¿es alguno de estos?» y deja el aviso aprobado una sola vez.
const conAviso = conAvisoDeVentas(r4);
igual("m4: se va la pregunta condicional", conAviso.includes("¿El pedido del 17/9 es alguno"), false);
igual("m4: termina con el aviso aprobado", conAviso.endsWith(AVISO_VENTAS_NO_FIGURA), true);
igual("m4: conserva los pedidos que figuran", conAviso.includes("Tu pedido del 15/10: facturado."), true);
const aprobado = "No me figura ese pedido. Lo que veo es tu pedido del 02/10, que ya fue retirado el 07/10. Le aviso a una persona de Ventas para que lo revise y te escriba por este medio.";
igual("texto aprobado: queda igual (ya avisa)", conAvisoDeVentas(aprobado), aprobado);
igual("sin aviso: se suma al final", conAvisoDeVentas("No te figura ningún pedido del 17/9."), `No te figura ningún pedido del 17/9.\n\n${AVISO_VENTAS_NO_FIGURA}`);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
