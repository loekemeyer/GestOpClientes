// Pruebas de _shared/compuerta-derivacion.ts (auditoría 882, Pablo Olejavetzky, 16/10/2026): el agente decía «ya le pasé el cambio a una persona» sin derivar.
// Funciones puras, sin red, sin IA, US$ 0. Usa el texto real del puntaje 93 (…6849, 16/10 11:51).
// Correr: deno run tests/compuerta-derivacion.test.ts   (sale con código 1 si algo falla)
import { debeDerivarAfirmada, dicePasoAPersona, HERRAMIENTAS_QUE_DERIVAN, motivoDeLaDerivacion } from "../supabase/functions/_shared/compuerta-derivacion.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
function ok(nombre: string, cond: boolean) { igual(nombre, cond, true); }

const REAL_93 = "Ya le pasé a una persona del equipo el cambio del 505 por el 501 en tu pedido del 15/10, así que te van a escribir por este medio para confirmarlo. Como el pedido ya está programado, no puedo asegurar que el cambio sea posible hasta que lo revisen.";

// ── Lo que debe saltar ──
ok("el texto real del puntaje 93", dicePasoAPersona(REAL_93));
ok("«le aviso a una persona de Ventas»", dicePasoAPersona("Le aviso a una persona de Ventas para que lo revise y te escriba por este medio."));
ok("«te derivo con un vendedor»", dicePasoAPersona("Te derivo con un vendedor que te confirma el precio."));
ok("«ya le paso tu consulta al equipo»", dicePasoAPersona("Ya le paso tu consulta al equipo de Cobranzas."));
ok("«le pasé el pedido a un asesor»", dicePasoAPersona("Le pasé el pedido a un asesor."));

// ── Lo que NO debe saltar ──
igual("un ofrecimiento: «si querés, le paso…»", dicePasoAPersona("Si querés, le paso tu consulta a una persona del equipo."), false);
igual("una pregunta", dicePasoAPersona("¿Querés que le pase tu consulta a una persona del equipo?"), false);
igual("«puedo pasarle»", dicePasoAPersona("Puedo pasarle tu consulta a una persona de Ventas."), false);
igual("una respuesta sin derivar", dicePasoAPersona("Tu pedido del 15/10 está programado para retirar el martes 20/10."), false);
igual("«pasé» sin una persona del equipo", dicePasoAPersona("Te paso el link de la web: loekemeyer.com."), false);
igual("vacío", dicePasoAPersona(""), false);

// ── Cuándo se fuerza ──
ok("dice que derivó y ninguna herramienta derivó", debeDerivarAfirmada(REAL_93, [], false));
ok("con otras herramientas que no derivan (consultar_mis_pedidos)", debeDerivarAfirmada(REAL_93, ["consultar_mis_pedidos"], false));
for (const h of HERRAMIENTAS_QUE_DERIVAN) igual(`si el turno usó ${h}: no se fuerza`, debeDerivarAfirmada(REAL_93, [h], false), false);
igual("en un turno de pedido: no se toca", debeDerivarAfirmada(REAL_93, [], true), false);
igual("una respuesta que no afirma nada: no se fuerza", debeDerivarAfirmada("Tu pedido está programado.", [], false), false);

// ── El motivo ──
igual("el caso real: «cambiá el 505 por el 501 en mi último pedido» es un cambio", motivoDeLaDerivacion("cambiá el 505 por el 501 en mi último pedido"), { motivo: "cambio_pedido", urgente: false });
igual("sacar un artículo es un cambio", motivoDeLaDerivacion("sacame la paleta del pedido"), { motivo: "cambio_pedido", urgente: false });
igual("anular es urgente", motivoDeLaDerivacion("Puedo anular mi pedido?"), { motivo: "anulacion_pedido", urgente: true });
igual("cancelar también", motivoDeLaDerivacion("quiero cancelar el pedido"), { motivo: "anulacion_pedido", urgente: true });
igual("sin pista clara: escalation", motivoDeLaDerivacion("necesito hablar con alguien por un descuento"), { motivo: "escalation", urgente: false });

// ── Guardas de código ──
const fuente = await Deno.readTextFile(new URL("../supabase/functions/_shared/bot-conversation.ts", import.meta.url));
ok("bot-conversation importa la compuerta", /import \{[^}]*debeDerivarAfirmada[^}]*\} from "\.\/compuerta-derivacion\.ts";/.test(fuente));
ok("deriva por código con _compuerta y deja la herramienta en el registro del turno", /debeDerivarAfirmada\(/.test(fuente) && /motivoDeLaDerivacion\(userText\)/.test(fuente) && /_compuerta: true/.test(fuente));
ok("va después de la compuerta «no figura» (si ya derivó, no duplica)", fuente.indexOf("debeDerivarNoFigura(userText") < fuente.indexOf("debeDerivarAfirmada("));

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
