// Pruebas del texto de la fecha de un pedido que se retira (supabase/functions/_shared/fecha-retiro.ts): m21 y m25, "programado para el lunes 05/10".
// Correr: node --experimental-strip-types --no-warnings tests/fecha-retiro.test.ts   (sale con código 1 si algo falla)
import { textoFechaRetiro } from "../supabase/functions/_shared/fecha-retiro.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

igual("programado: 'programado para el lunes 05/10' (el texto que aprobó Pablo)", "🚚 programado" + textoFechaRetiro("programado", "lunes 05/10"), "🚚 programado para el lunes 05/10");
igual("facturado: sigue diciendo el estado y la fecha, sin 'retirar'", "🧾 facturado, listo para salir" + textoFechaRetiro("facturado", "martes 06/10"), "🧾 facturado, listo para salir: programado para el martes 06/10");
igual("en preparación", "🛠️ en preparación en el depósito" + textoFechaRetiro("en preparacion", "miércoles 07/10"), "🛠️ en preparación en el depósito: programado para el miércoles 07/10");
for (const e of ["programado", "facturado", "en preparacion"]) igual(`ningún caso dice "retirar" (${e})`, /retir/i.test(textoFechaRetiro(e, "lunes 05/10")), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
