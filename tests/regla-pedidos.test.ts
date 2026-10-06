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

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
