// Pruebas de cuándo "pedido repetido o rechazado" habla de un pedido por MAIL (supabase/functions/_shared/faq.ts, pedidoPorMailRepetido). Sin red.
// Correr: deno run --allow-env tests/faq-pedido-mail.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { pedidoPorMailRepetido } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Pedido por mail que vino repetido o rechazado: va a Ventas.
for (const t of [
  "Pasé por mail un pedido para un cliente pero me vino dos veces rechazado. ¿Te llegó a vos?",
  "Mandé el pedido por correo y me lo rechazaron dos veces", "Te envié el pedido por e-mail y salió duplicado",
  "El pedido que mandé por mail me llegó repetido",
]) igual(`mail: ${t}`, pedidoPorMailRepetido(t), true);

// No: duplicado en la web (sin mail) o mail sin duplicado, siguen su camino.
for (const t of [
  "Me facturaron el mismo pedido dos veces", "Apreté confirmar varias veces y se me duplicó el pedido", "se cargó dos veces mi pedido",
  "Mandé el pedido por mail", "Te paso el pedido por mail", "Hola, buen día", "Mi mail es juan@gmail.com",
]) igual(`sin mail: ${t}`, pedidoPorMailRepetido(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
