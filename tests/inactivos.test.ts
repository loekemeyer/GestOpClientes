// Pruebas de qué se le dice al cliente de un artículo inactivo (supabase/functions/_shared/inactivos.ts, tareas 5283 y 5448, 08/10): sólo «SIN STOCK» se dice sin stock, todo el resto "no disponible por el momento", nunca "discontinuado". Sin red.
// Correr: node --experimental-strip-types --no-warnings tests/inactivos.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import { estadoDeInactivo, REGLA_NO_DISPONIBLE, REGLA_SIN_STOCK, reglaDeInactivos } from "../supabase/functions/_shared/inactivos.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── Estado según la etiqueta ──
igual("«SIN STOCK» se dice sin stock", estadoDeInactivo("SIN STOCK"), "sin_stock");
igual("en minúscula y con espacios", estadoDeInactivo("  sin stock "), "sin_stock");
igual("sin tildes ni mayúsculas importan igual", estadoDeInactivo("Sin Stock"), "sin_stock");
// Pablo (08/10): «si no está en la página, no disponible» → sin etiqueta también.
igual("sin etiqueta: no disponible (antes discontinuado)", estadoDeInactivo(null), "no_disponible");
igual("etiqueta vacía", estadoDeInactivo(""), "no_disponible");
igual("indefinida", estadoDeInactivo(undefined), "no_disponible");
igual("«LIQUIDACIÓN» inactivo: no disponible", estadoDeInactivo("LIQUIDACIÓN"), "no_disponible");
igual("«LIQUIDACION» sin tilde", estadoDeInactivo("liquidacion"), "no_disponible");
igual("«NUEVO» inactivo: no disponible (el Automate 597)", estadoDeInactivo("NUEVO"), "no_disponible");
igual("una etiqueta que sólo contiene 'stock' no es «SIN STOCK»", estadoDeInactivo("STOCK LIMITADO"), "no_disponible");

// ── La regla que acompaña a la respuesta ──
const sin = { sin_stock: true }, nodisp = { no_disponible: true };
igual("sólo sin stock: la regla de sin stock", reglaDeInactivos([sin]), REGLA_SIN_STOCK);
igual("sólo no disponibles: la regla neutral", reglaDeInactivos([nodisp, nodisp]), REGLA_NO_DISPONIBLE);
igual("de los dos tipos: las dos reglas, sin stock primero", reglaDeInactivos([nodisp, sin]), `${REGLA_SIN_STOCK} ${REGLA_NO_DISPONIBLE}`);
igual("lista vacía: ninguna regla", reglaDeInactivos([]), "");
igual("un item sin marca (como los de antes) se trata como no disponible", reglaDeInactivos([{}]), REGLA_NO_DISPONIBLE);
igual("ninguna de las dos reglas le pide decir 'discontinuado'", [REGLA_SIN_STOCK, REGLA_NO_DISPONIBLE].map((r) => /Decile que ese código está discontinuado/.test(r)), [false, false]);
igual("las dos prohíben decir 'discontinuado'", [REGLA_SIN_STOCK, REGLA_NO_DISPONIBLE].map((r) => /No digas que está discontinuado/.test(r)), [true, true]);
igual("la de no disponible tampoco afirma 'no hay stock'", /No digas que está discontinuado ni que no hay stock/.test(REGLA_NO_DISPONIBLE), true);
igual("las dos prohíben decir 'no lo encontré'", [REGLA_SIN_STOCK, REGLA_NO_DISPONIBLE].map((r) => /no lo encontraste/.test(r)), [true, true]);
igual("la de sin stock manda a consultar_stock", /consultar_stock/.test(REGLA_SIN_STOCK), true);

// ── Guardas sobre el código: los tres puntos donde buscar_productos devuelve la regla usan la función, y la etiqueta viaja desde la base ──
const bot = readFileSync(new URL("../supabase/functions/_shared/bot-conversation.ts", import.meta.url), "utf8");
igual("buscar_productos no importa ni usa la regla vieja de discontinuado", /REGLA_DISCONTINUADO/.test(bot), false);
igual("los tres puntos usan reglaDeInactivos", (bot.match(/regla:\s*reglaDeInactivos\(inactivos\)/g) ?? []).length, 3);
igual("la lista sale con la clave no_disponibles (no 'discontinuados')", [(bot.match(/no_disponibles: inactivos/g) ?? []).length, /\{\s*discontinuados[,\s]/.test(bot)], [3, false]);
igual("las dos consultas de inactivos traen badge_status", (bot.match(/select\("cod, description, category, badge_status"\)/g) ?? []).length, 2);
igual("conParecidos marca el estado con estadoDeInactivo", /estadoDeInactivo\(p\.badge_status\)/.test(bot), true);
igual("conParecidos marca sólo sin_stock y no_disponible (ya no hay 'discontinuado: true')", [/sin_stock: true/.test(bot), /no_disponible: true/.test(bot), /discontinuado: true/.test(bot)], [true, true, false]);

// ── Guarda sobre el prompt del agente: ya no le manda decir "discontinuado" ──
const fijos = readFileSync(new URL("../supabase/functions/_shared/agente-fijos.ts", import.meta.url), "utf8");
igual("el prompt habla de no_disponibles", /buscar_productos devuelve un código en no_disponibles/.test(fijos), true);
igual("el prompt ya no manda decir que un código está discontinuado", /marca un código como discontinuado/.test(fijos), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
