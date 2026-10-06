// Pruebas del plazo de entrega general (supabase/functions/_shared/plazo-entrega.ts): 14 días hábiles fijos, con feriados.
// Correr: node --experimental-strip-types --no-warnings tests/plazo-entrega.test.ts   (sale con código 1 si algo falla)
import { esDiaHabil, PLAZO_DIAS_HABILES, sumarDiasHabiles, textoFecha, textoPedidoParaFecha, textoPlazo } from "../supabase/functions/_shared/plazo-entrega.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

igual("el plazo es 14 días hábiles", PLAZO_DIAS_HABILES, 14);
igual("lunes a viernes son hábiles", ["2026-10-05", "2026-10-06", "2026-10-09"].map((d) => esDiaHabil(d)), [true, true, true]);
igual("sábado y domingo no", ["2026-10-10", "2026-10-11"].map((d) => esDiaHabil(d)), [false, false]);
igual("un feriado no es hábil", esDiaHabil("2026-10-12", ["2026-10-12"]), false);

// Pedido de hoy martes 06/10/2026.
igual("14 hábiles desde el martes 06/10 sin feriados → lunes 26/10", sumarDiasHabiles("2026-10-06", 14), "2026-10-26");
igual("con el feriado del lunes 12/10 → martes 27/10", sumarDiasHabiles("2026-10-06", 14, ["2026-10-12"]), "2026-10-27");
igual("con el feriado y un puente → un día más", sumarDiasHabiles("2026-10-06", 14, ["2026-10-12", "2026-10-13"]), "2026-10-28");
igual("0 días devuelve el mismo día", sumarDiasHabiles("2026-10-06", 0), "2026-10-06");
igual("1 hábil desde el viernes → lunes (salta el finde)", sumarDiasHabiles("2026-10-09", 1), "2026-10-12");
igual("desde un sábado el día del pedido no cuenta: 1 hábil → lunes", sumarDiasHabiles("2026-10-10", 1), "2026-10-12");
igual("cruza fin de año con feriados", sumarDiasHabiles("2026-12-18", 5, ["2026-12-25"]), "2026-12-28");
igual("negativos o decimales no rompen", [sumarDiasHabiles("2026-10-06", -3), sumarDiasHabiles("2026-10-06", 1.9)], ["2026-10-06", "2026-10-07"]);

igual("texto de fecha: martes 27/10", textoFecha("2026-10-27"), "martes 27/10");
igual("texto de fecha: miércoles con ceros", textoFecha("2026-11-04"), "miércoles 04/11");
igual("plazo general", textoPlazo(), "El plazo de entrega hoy es de 14 días hábiles desde que hacés el pedido.");
igual("m62: texto completo", textoPedidoParaFecha("2026-10-06", ["2026-10-12"]),
  "Hoy la entrega estimada es de 14 días hábiles: si hacés el pedido hoy, sería el martes 27/10.\n" +
  "Para la fecha que necesitás lo consulta una persona de Ventas y te escribe por acá. ¿Qué artículos necesitás?");

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
