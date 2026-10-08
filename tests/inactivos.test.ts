// Pruebas de qué se le dice al cliente de un artículo inactivo (supabase/functions/_shared/inactivos.ts, tarea 5283, 08/10): «SIN STOCK» ya no se dice "discontinuado". Sin red.
// Correr: node --experimental-strip-types --no-warnings tests/inactivos.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import { estadoDeInactivo, REGLA_DISCONTINUADO, REGLA_SIN_STOCK, reglaDeInactivos } from "../supabase/functions/_shared/inactivos.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── Estado según la etiqueta ──
igual("«SIN STOCK» no es discontinuado", estadoDeInactivo("SIN STOCK"), "sin_stock");
igual("en minúscula y con espacios", estadoDeInactivo("  sin stock "), "sin_stock");
igual("sin tildes ni mayúsculas importan igual", estadoDeInactivo("Sin Stock"), "sin_stock");
igual("sin etiqueta sigue siendo discontinuado", estadoDeInactivo(null), "discontinuado");
igual("etiqueta vacía", estadoDeInactivo(""), "discontinuado");
igual("indefinida", estadoDeInactivo(undefined), "discontinuado");
// Decisión de alcance (08/10): LIQUIDACIÓN y NUEVO inactivos NO cambian hasta que Pablo diga qué significan. Si esto se cambia, que sea a propósito.
igual("«LIQUIDACIÓN» inactivo sigue como antes (discontinuado)", estadoDeInactivo("LIQUIDACIÓN"), "discontinuado");
igual("«NUEVO» inactivo sigue como antes (discontinuado): el Automate 597", estadoDeInactivo("NUEVO"), "discontinuado");
igual("una etiqueta que sólo contiene 'stock' no cuenta", estadoDeInactivo("STOCK LIMITADO"), "discontinuado");

// ── La regla que acompaña a la respuesta ──
const disc = { discontinuado: true }, sin = { sin_stock: true };
igual("sólo discontinuados: la regla de siempre, sin tocar", reglaDeInactivos([disc, disc]), REGLA_DISCONTINUADO);
igual("sólo sin stock: la regla nueva", reglaDeInactivos([sin]), REGLA_SIN_STOCK);
igual("de los dos tipos: las dos reglas, la de siempre primero", reglaDeInactivos([disc, sin]), `${REGLA_DISCONTINUADO} ${REGLA_SIN_STOCK}`);
igual("lista vacía: ninguna regla", reglaDeInactivos([]), "");
igual("un item sin marca (como los de antes) se trata como discontinuado", reglaDeInactivos([{}]), REGLA_DISCONTINUADO);
igual("la regla de sin stock NO le pide decir 'está discontinuado'", /Decile que ese código está discontinuado/.test(REGLA_SIN_STOCK), false);
igual("la regla de sin stock lo aclara y manda a consultar_stock", [/NO está discontinuado/.test(REGLA_SIN_STOCK), /consultar_stock/.test(REGLA_SIN_STOCK)], [true, true]);
igual("la regla de siempre no cambió (texto de Pablo, 30/09)", REGLA_DISCONTINUADO.startsWith("Decile que ese código está discontinuado (nombrándolo con su descripción)"), true);

// ── Guardas sobre el código: los tres puntos donde buscar_productos devuelve la regla usan la función, y la etiqueta viaja desde la base ──
const bot = readFileSync(new URL("../supabase/functions/_shared/bot-conversation.ts", import.meta.url), "utf8");
igual("buscar_productos nunca devuelve la regla fija de discontinuado", /regla:\s*REGLA_DISCONTINUADO/.test(bot), false);
igual("los tres puntos usan reglaDeInactivos", (bot.match(/regla:\s*reglaDeInactivos\(discontinuados\)/g) ?? []).length, 3);
igual("las dos consultas de inactivos traen badge_status", (bot.match(/select\("cod, description, category, badge_status"\)/g) ?? []).length, 2);
igual("conParecidos marca el estado con estadoDeInactivo", /estadoDeInactivo\(p\.badge_status\)/.test(bot), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
