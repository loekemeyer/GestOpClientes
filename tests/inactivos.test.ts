// Pruebas de qué se le dice al cliente de un artículo inactivo (supabase/functions/_shared/inactivos.ts, tareas 5283, 5448 y 5456, 08/10): TODOS los inactivos, con o sin etiqueta («SIN STOCK», «NUEVO»,
// «LIQUIDACIÓN»), se dicen "no disponible por el momento", nunca "discontinuado" ni "no hay stock". Sin red.
// Correr: node --experimental-strip-types --no-warnings tests/inactivos.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import * as inactivos from "../supabase/functions/_shared/inactivos.ts";

const { REGLA_NO_DISPONIBLE } = inactivos;

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── La regla única ──
igual("el módulo exporta sólo la regla (no hay estados por etiqueta)", Object.keys(inactivos), ["REGLA_NO_DISPONIBLE"]);
igual("dice 'no está disponible por el momento'", /no está disponible por el momento/.test(REGLA_NO_DISPONIBLE), true);
igual("prohíbe decir 'discontinuado' y 'no hay stock'", /No digas que está discontinuado ni que no hay stock/.test(REGLA_NO_DISPONIBLE), true);
igual("no le pide decir que está discontinuado", /Decile que ese código está discontinuado/.test(REGLA_NO_DISPONIBLE), false);
igual("prohíbe decir 'no lo encontré' y pedir que revise el código", /no lo encontraste ni que revise el código/.test(REGLA_NO_DISPONIBLE), true);
igual("ofrece el parecido con la foto", /parecidos_activos/.test(REGLA_NO_DISPONIBLE) && /link de su foto/.test(REGLA_NO_DISPONIBLE), true);
// Pablo (08/10, «sí, hacelo así»): el stock se consulta sólo si el cliente insiste.
igual("manda a consultar_stock sólo si el cliente insiste en saber si hay stock", /Sólo si el cliente insiste en saber si hay stock, usá consultar_stock/.test(REGLA_NO_DISPONIBLE), true);

// ── Guardas sobre el código: los tres puntos donde buscar_productos devuelve la regla usan la misma, y la etiqueta NO viaja ──
const bot = readFileSync(new URL("../supabase/functions/_shared/bot-conversation.ts", import.meta.url), "utf8");
igual("buscar_productos importa la regla única", /import \{ REGLA_NO_DISPONIBLE \} from "\.\/inactivos\.ts"/.test(bot), true);
igual("los tres puntos devuelven REGLA_NO_DISPONIBLE", (bot.match(/regla:\s*REGLA_NO_DISPONIBLE/g) ?? []).length, 3);
igual("la lista sale bajo no_disponibles (nunca 'discontinuados')", [(bot.match(/no_disponibles: inactivos/g) ?? []).length, /\{\s*discontinuados[,\s]/.test(bot)], [3, false]);
igual("ya no hay reglas ni estados por etiqueta", [/REGLA_DISCONTINUADO/.test(bot), /REGLA_SIN_STOCK/.test(bot), /estadoDeInactivo|reglaDeInactivos/.test(bot), /discontinuado: true/.test(bot)], [false, false, false, false]);
igual("las dos consultas de inactivos ya no traen badge_status", (bot.match(/select\("cod, description, category"\)\.in\("cod", codigos\)\.eq\("active", false\)|select\("cod, description, category"\)\.eq\("active", false\)\.ilike/g) ?? []).length, 2);
igual("conParecidos marca todos como no_disponible", /out\.push\(\{ cod: p\.cod, descripcion: p\.description, no_disponible: true, parecidos_activos \}\)/.test(bot), true);

// ── Guarda sobre el prompt del agente: ya no le manda decir "discontinuado" ──
const fijos = readFileSync(new URL("../supabase/functions/_shared/agente-fijos.ts", import.meta.url), "utf8");
igual("el prompt habla de no_disponibles", /buscar_productos devuelve un código en no_disponibles/.test(fijos), true);
igual("el prompt ya no manda decir que un código está discontinuado", /marca un código como discontinuado/.test(fijos), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
