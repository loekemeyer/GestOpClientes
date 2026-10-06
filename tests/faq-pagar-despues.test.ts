// Pruebas de cuándo una consulta es "quiero pagar en otra fecha" (supabase/functions/_shared/faq.ts, pidePagarDespues). Sin red.
// Correr: deno run --allow-env tests/faq-pagar-despues.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { pidePagarDespues } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Pide o avisa que paga en otra fecha: lo ve Cobranzas.
for (const t of [
  "Hola, ¿se podrá efectuar el pago el próximo viernes?", "¿Puedo pagar el viernes?", "Podemos pagar la semana que viene?",
  "¿les puedo pagar más adelante?", "Pagamos el lunes", "Te aviso que abonamos mañana", "Les pago el 15", "¿Puedo abonar el 15/10?",
  "Hacemos el pago a fin de mes", "¿Podemos transferir el próximo lunes?", "voy a pagar la quincena",
]) igual(`deriva: ${t}`, pidePagarDespues(t), true);

// No: otra consulta de pagos o fecha pasada, siguen su camino.
for (const t of [
  "Ya pagué el viernes", "Les pagamos el viernes pasado", "¿Recibieron el pago del viernes?", "Pagué ayer, ¿lo ven?",
  "¿Cuáles son los medios de pago?", "Si pago hoy, ¿tengo el 25%?", "Dame el CBU para pagar", "¿Cuándo me entregan el pedido del viernes?",
  "Quiero hacer un pedido para el viernes", "Hola, buen día", "ya transferí el lunes",
]) igual(`no deriva: ${t}`, pidePagarDespues(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
