// Pruebas de supabase/functions/_shared/pasar-excel.ts (Pablo Olejavetzky, 07/10/2026, corrección m42): "¿Hay forma de pasarla a Excel?" → se pregunta qué quiere pasar y se deriva según la
// respuesta (lista de precios y pedidos a Ventas, facturas a Cobranzas, otra cosa a Ventas). Módulo puro, sin red. Correr: deno run tests/pasar-excel.test.ts   (sale con código 1 si algo falla)
import { claseNombrada, derivacionExcel, esRespuestaAExcel, pideExcel, PREGUNTA_EXCEL } from "../supabase/functions/_shared/pasar-excel.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

for (const t of ["¿Hay forma de pasarla a Excel?", "¿Me la podés pasar en Excel?", "¿Se puede bajar en Excel?", "¿Tienen la lista de precios en Excel?", "¿Puedo exportar mis pedidos a Excel?", "Quisiera tenerla en excel"])
  igual(`pide Excel: ${t}`, pideExcel(t), true);
for (const t of ["Te paso el Excel con el pedido", "Les mando el excel", "Adjunto el Excel", "No puedo abrir el Excel", "El Excel me da error", "¿Me pasás el cotizador en Excel?", "Hola, buen día", "¿Cuándo llega mi pedido?", "Quiero la lista de precios"])
  igual(`no pide Excel: ${t}`, pideExcel(t), false);

igual("nombra facturas", claseNombrada("mis facturas"), "facturas");
igual("nombra cuenta corriente = facturas", claseNombrada("la cuenta corriente"), "facturas");
igual("nombra pedidos", claseNombrada("mis pedidos"), "pedidos");
igual("nombra la lista de precios", claseNombrada("la lista de precios"), "lista");
igual("nombra el catálogo = lista", claseNombrada("el catálogo"), "lista");
igual("pedidos y facturas: gana facturas (Cobranzas)", claseNombrada("mis pedidos y facturas"), "facturas");
igual("no nombra nada", claseNombrada("¿Hay forma de pasarla a Excel?"), null);
igual("otra cosa", claseNombrada("un informe de ventas"), null);

for (const t of ["la lista de precios", "mis pedidos", "las facturas", "un informe de ventas"]) igual(`es respuesta: ${t}`, esRespuestaAExcel(t), true);
for (const t of ["¿Cuándo llega mi pedido?", "gracias", "Ok", "Hola", "", "x".repeat(81)]) igual(`no es respuesta: ${t.slice(0, 30)}`, esRespuestaAExcel(t), false);

igual("la pregunta aprobada", PREGUNTA_EXCEL, "¿Qué querés pasar a Excel: la lista de precios, tus pedidos, tus facturas u otra cosa?");
const L = derivacionExcel("lista", "la lista de precios"), P = derivacionExcel("pedidos", "mis pedidos"), F = derivacionExcel("facturas", "las facturas"), O = derivacionExcel("otra", "un informe");
igual("lista → Ventas, nota_cliente", [L.reply, L.motivo], ["Le paso tu pedido de la lista de precios en Excel a Ventas para que te escriban por acá a la brevedad. 🙏", "nota_cliente"]);
igual("pedidos → Ventas, nota_cliente", [P.reply, P.motivo], ["Le paso tu pedido de tus pedidos en Excel a Ventas para que te escriban por acá a la brevedad. 🙏", "nota_cliente"]);
igual("facturas → Cobranzas, pago", [F.reply, F.motivo], ["Le paso tu pedido de tus facturas en Excel a Cobranzas para que te escriban por acá a la brevedad. 🙏", "pago"]);
igual("otra cosa → Ventas, nota_cliente", [O.reply, O.motivo], ["Le paso tu consulta a Ventas para que te escriban por acá a la brevedad. 🙏", "nota_cliente"]);
igual("la alerta lleva lo que escribió el cliente", F.detalle, "Pidió sus facturas en Excel: las facturas");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
