// Pruebas de pagoPosterior (supabase/functions/_shared/recordatorio-pagos.ts): ¿pagó después de la última carga de saldos?
// Sin red. Correr: deno run tests/recordatorio-pagos.test.ts   (sale con código 1 si algo falla)
import { pagoPosterior, type ReciboMin } from "../supabase/functions/_shared/recordatorio-pagos.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Carga de saldos del 02/10; hoy 05/10 (los datos son del 05/10: 11 de los 12 clientes que pagaron seguían con saldo).
const recibos: ReciboMin[] = [
  { cod_cliente: "862", fecha_pago: "2026-10-01", pagado: 11687939 },   // antes de la carga: el saldo ya lo tiene
  { cod_cliente: "500", fecha_pago: "2026-10-02", pagado: 1000 },       // el mismo día de la carga
  { cod_cliente: "501", fecha_pago: "2026-10-04", pagado: 2000 },
  { cod_cliente: "501", fecha_pago: "2026-10-05", pagado: 3000 },
  { cod_cliente: "502", fecha_pago: "2026-12-18", pagado: 4000 },       // cheque diferido: todavía no es un pago hecho
  { cod_cliente: "0503", fecha_pago: "2026-10-03T00:00:00+00:00", pagado: null },
];
const hoy = "2026-10-05", carga = "2026-10-02";

igual("recibo anterior a la carga: no cuenta", pagoPosterior(recibos, "862", carga, hoy), null);
igual("recibo del día de la carga: cuenta", pagoPosterior(recibos, "500", carga, hoy)?.pagado, 1000);
igual("varios recibos: el más reciente", pagoPosterior(recibos, "501", carga, hoy)?.pagado, 3000);
igual("cheque diferido: no cuenta", pagoPosterior(recibos, "502", carga, hoy), null);
igual("el código con ceros a la izquierda es el mismo", pagoPosterior(recibos, "503", carga, hoy)?.fecha_pago, "2026-10-03T00:00:00+00:00");
igual("cliente sin recibos", pagoPosterior(recibos, "999", carga, hoy), null);
igual("sin ningún recibo", pagoPosterior([], "501", carga, hoy), null);
igual("hasta es inclusivo", pagoPosterior(recibos, "501", "2026-10-05", "2026-10-05")?.pagado, 3000);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
