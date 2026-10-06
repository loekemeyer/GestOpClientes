// Pruebas de cuándo un mensaje es una NOTA del cliente con su horario de recepción (supabase/functions/_shared/faq.ts, avisaHorarioRecepcion). Sin red.
// Correr: deno run --allow-env tests/faq-nota-recepcion.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { avisaHorarioRecepcion } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Avisa su horario de recepción: nota para Ventas.
for (const t of [
  "Por favor recuerden que recibimos hasta las 14 hs, por lo que deben llegar un ratito antes", "Recibimos de 8 a 14 hs", "Atendemos hasta las 17",
  "Les aviso que el horario de recepción es de 9 a 13", "Reciben mercadería desde las 8:30", "Recepcionamos hasta las 15", "abrimos de 9 a 18, avisen antes de venir",
]) igual(`nota: ${t}`, avisaHorarioRecepcion(t), true);

// No: faltantes, preguntas, pedidos ya recibidos u otras consultas.
for (const t of [
  "Recibimos 59 aceiteras de 60", "¿Hasta qué hora reciben pedidos?", "¿Recibieron mi pedido?", "Recibimos el pedido a las 10, gracias", "Hola, buen día",
  "¿A qué hora llega mi pedido?", "Recibimos 3 cajas de 10 unidades y faltan 2", "Quiero hacer un pedido para el viernes",
]) igual(`no es nota: ${t}`, avisaHorarioRecepcion(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
