// Pruebas del detector avisaOrdenDeCompra de supabase/functions/_shared/faq.ts (Pablo Olejavetzky, 07/10/2026, corrección m11): "Adjunto orden de compra, quedo a la espera de confirmación
// de recepción" → respuesta fija y alerta `pedido_archivo` para Ventas. Sin red. Correr: deno run --allow-env tests/faq-orden-compra.test.ts   (sale con código 1 si algo falla)
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { avisaOrdenDeCompra } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

for (const t of ["Adjunto orden de compra, quedo a la espera de confirmación de recepción", "Les envío la orden de compra 4521", "Te mando la orden de compra de esta semana", "Paso orden de compra adjunta",
  "Adjuntamos nuestra orden de compra para el pedido de octubre", "Ahí va la orden de compra", "La orden de compra adjunta es la 778", "Hola, les paso las órdenes de compra de hoy"])
  igual(`dispara: ${t}`, avisaOrdenDeCompra(t), true);
for (const t of ["¿Cómo les mando una orden de compra?", "¿Dónde envío la orden de compra?", "No puedo adjuntar la orden de compra", "¿Necesitan una orden de compra?", "¿Puedo mandar la orden de compra por mail?",
  "Hace falta orden de compra para pedir?", "¿Cuándo llega mi pedido?", "Adjunto el comprobante de pago", "Quiero hacer un pedido", "Hola, buen día", "Les paso el pedido de la semana", "Pedido sin orden de compra"])
  igual(`no dispara: ${t}`, avisaOrdenDeCompra(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
