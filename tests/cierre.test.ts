// Pruebas del filtro de cierres genéricos ("¿Necesitás algo más?") de supabase/functions/_shared/cierre.ts. Sin red, sin IA.
// Correr: deno run tests/cierre.test.ts   (sale con código 1 si algo falla)
import { sinCierreGenerico } from "../supabase/functions/_shared/cierre.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── Lo que TIENE que sacar ──
// Respuestas reales del 01/10 (Claude Sonnet 4.6) y del 05/10 (Gemini 3.5 Flash-Lite) en el simulador.
igual("Sonnet 1.3: '¿Necesitás algo más?' en párrafo aparte",
  sinCierreGenerico("Tu pedido del 30/09 está programado para el *lunes 5 de octubre*. 📦\n\n¿Necesitás algo más?"),
  "Tu pedido del 30/09 está programado para el *lunes 5 de octubre*. 📦");
igual("Sonnet 2.9: '¿Puedo ayudarte con algo más?'",
  sinCierreGenerico("El *Automate (cód. 597)* está discontinuado y no tenemos un reemplazo disponible en este momento, por eso no aparece en la web.\n\n¿Puedo ayudarte con algo más?"),
  "El *Automate (cód. 597)* está discontinuado y no tenemos un reemplazo disponible en este momento, por eso no aparece en la web.");
igual("Sonnet 1.5: '¿Hay algo más en lo que te pueda ayudar?'",
  sinCierreGenerico("Anotado, gracias por avisarnos. Le voy a comentar al equipo para que lo tengan en cuenta.\n\n¿Hay algo más en lo que te pueda ayudar?"),
  "Anotado, gracias por avisarnos. Le voy a comentar al equipo para que lo tengan en cuenta.");
igual("Gemini 1.5: '¿Te podemos ayudar con algo más?' al final de la misma línea",
  sinCierreGenerico("Registrado, Franco. Tomamos nota de que reciben hasta las 14 hs para que las entregas lleguen con margen. ¿Te podemos ayudar con algo más?"),
  "Registrado, Franco. Tomamos nota de que reciben hasta las 14 hs para que las entregas lleguen con margen.");
igual("Sonnet 7.1: pregunta y cierre", sinCierreGenerico("Sí, el pedido está recibido.\n\n¿Necesitás algo más?"), "Sí, el pedido está recibido.");
igual("con emoji después", sinCierreGenerico("Listo. ¿Necesitás algo más? 😊"), "Listo.");
igual("'¿En qué más te puedo ayudar?'", sinCierreGenerico("Perfecto, quedó anotado. ¿En qué más te puedo ayudar?"), "Perfecto, quedó anotado.");
igual("'¿Algo más?'", sinCierreGenerico("Te lo paso por acá en un rato. ¿Algo más?"), "Te lo paso por acá en un rato.");
igual("'¿Alguna otra consulta?'", sinCierreGenerico("El mínimo es de $500.000.\n¿Alguna otra consulta?"), "El mínimo es de $500.000.");
igual("'Ante cualquier duda, escribinos.'", sinCierreGenerico("Ya está cargado. Ante cualquier duda, escribinos."), "Ya está cargado.");
igual("'Cualquier otra consulta avisame' con emoji", sinCierreGenerico("Dale, gracias. Cualquier otra consulta avisame 🙌"), "Dale, gracias.");
igual("'Si necesitás algo más, avisame.'", sinCierreGenerico("El stock entra el 07/10. Si necesitás algo más, avisame."), "El stock entra el 07/10.");
igual("'Quedo a disposición.'", sinCierreGenerico("Tu pedido sale hoy. Quedo a disposición."), "Tu pedido sale hoy.");
igual("dos cierres seguidos", sinCierreGenerico("Listo. ¿Necesitás algo más? ¿Hay algo más en lo que te pueda ayudar?"), "Listo.");
igual("cierre con 'por hoy'", sinCierreGenerico("Anotado. ¿Necesitás algo más por hoy?"), "Anotado.");

// ── Lo que NO tiene que tocar ──
const quedan = [
  "Para 60 unidades serían 2 cajas (100 unidades). ¿Agregamos 2 cajas a tu pedido del 30/09?",
  "Anotado el artículo. ¿Querés agregar algo más al pedido?",
  "Los próximos ingresos estimados son para el *07/10*. ¿Te interesa alguno en particular?",
  "Tenés el Despolvillador de Yerba (cód. 591). ¿Querés saber el stock disponible o sumarlo a un pedido?",
  "¡Hola! 👋 ¿En qué te puedo ayudar?",
  "Ese artículo viene en cajas de 12. ¿Necesitás algo más de ese artículo?",
  "Si necesitás comunicarte directamente con ellos, podés hacerlo por WhatsApp al 11 6557-4113.",
  "Para cualquier otra consulta te responde una persona del equipo.",
  "Tenés algo más pendiente de pago: $249.281.",
  "¿Necesitás algo más? Tu pedido sale el lunes.",   // el cierre no está al final: no se toca
  "Una persona del equipo te escribe por acá para revisar el pedido.",
  "",
];
for (const t of quedan) igual(`queda igual: ${t.slice(0, 50)}`, sinCierreGenerico(t), t);
igual("si todo el texto es un cierre, no se deja vacío", sinCierreGenerico("¿Necesitás algo más?"), "¿Necesitás algo más?");

// ── En un turno de PEDIDO "¿Algo más?" puede ser una pregunta de verdad (¿más artículos?): sólo se sacan los cierres de ayuda ──
igual("pedido: '¿Algo más?' se deja", sinCierreGenerico("Anotado: 6 cajas del 505. ¿Algo más?", true), "Anotado: 6 cajas del 505. ¿Algo más?");
igual("pedido: '¿Necesitás algo más?' se deja", sinCierreGenerico("Anotado: 6 cajas del 505. ¿Necesitás algo más?", true), "Anotado: 6 cajas del 505. ¿Necesitás algo más?");
igual("pedido: '¿Te podemos ayudar con algo más?' sí se saca", sinCierreGenerico("Anotado: 6 cajas del 505. ¿Te podemos ayudar con algo más?", true), "Anotado: 6 cajas del 505.");
igual("pedido: 'cualquier consulta avisame' sí se saca", sinCierreGenerico("Pedido cargado. Cualquier consulta avisame.", true), "Pedido cargado.");
igual("fuera de un pedido el mismo '¿Algo más?' se saca", sinCierreGenerico("Anotado: 6 cajas del 505. ¿Algo más?"), "Anotado: 6 cajas del 505.");

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
