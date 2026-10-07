// Pruebas del detector pidePedidoPorWeb de supabase/functions/_shared/faq.ts (Pablo Olejavetzky, 07/10/2026, corrección m77): "¿Puedo hacer el pedido directo de la web? ¿Mismos precios, mismo todo?"
// → sí, con el acceso, y se le cuenta el descuento extra por hacerlo por la web (sin decir cuánto). Sin red.
// Correr: deno run --allow-env tests/faq-pedido-web.test.ts   (sale con código 1 si algo falla)
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { pidePedidoPorWeb } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

for (const t of ["¿Puedo hacer el pedido directo de la web? ¿Mismos precios, mismo todo?", "¿Puedo pedir directo por la página?", "Podemos hacer el pedido en la web?", "¿Se puede hacer el pedido por la web?",
  "Hola, ¿puedo cargar el pedido en la página web?", "¿Es posible hacer pedidos online?", "¿Puedo hacer mi pedido por la web con los mismos descuentos?"])
  igual(`dispara: ${t}`, pidePedidoPorWeb(t), true);
for (const t of ["No puedo hacer el pedido en la web", "No me deja hacer el pedido por la web, me da error", "¿Puedo hacer el pedido? No tengo la clave de la web", "No sé mi usuario para pedir en la web",
  "¿Puedo hacer el pedido por WhatsApp?", "¿Puedo hacer el pedido con el cotizador o por la web?", "Te paso el pedido que hice en la web", "¿Puedo pasar el pedido por mail?", "¿Puedo hacer un pedido?",
  "¿Cuándo llega mi pedido de la web?", "Hola, buen día", "¿Cuál es la página web?", "Quiero ser cliente, ¿puedo registrarme en la web?"])
  igual(`no dispara: ${t}`, pidePedidoPorWeb(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
