// Pruebas de cuándo una consulta es "quiero devolver mercadería" (supabase/functions/_shared/faq.ts, quiereDevolver). Sin red.
// Correr: deno run --allow-env tests/faq-devolucion.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { quiereDevolver } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const derivaADevolucion = quiereDevolver;

// Quiere devolver mercadería: lo toma Ventas.
for (const t of [
  "Vamos a devolver unas cucharas que no pedimos, es el código 208 y son 48 unidades",
  "Quiero devolver una caja de coladores", "Necesitamos hacer una devolución", "¿Cómo es el tema de las devoluciones?",
  "les devuelvo 3 cajas, no las pedí", "Te devuelvo el pedido completo", "Podemos devolverles lo que sobró?", "queremos devolverlo",
  "Hola, quería hacer una devolución del pedido del 30/09", "devolvemos la mercadería mañana",
]) igual(`deriva: ${t}`, derivaADevolucion(t), true);

// No es una devolución de mercadería: sigue su camino.
for (const t of [
  "Devolveme la llamada por favor", "Cuando puedas devolvé el llamado", "¿Me devolvés el mensaje?", "Me devolvieron el cheque",
  "¿Cuál es el pedido mínimo?", "Cargué todo por unidad y después lo edité por caja", "quiero 48 unidades del 208", "Hola, buen día",
]) igual(`no deriva: ${t}`, derivaADevolucion(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
