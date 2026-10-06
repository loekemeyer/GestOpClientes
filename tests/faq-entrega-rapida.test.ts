// Pruebas de cuándo una consulta pide entrega rápida o adelantar la entrega (supabase/functions/_shared/faq.ts, pideEntregaRapida). Sin red.
// Correr: deno run --allow-env tests/faq-entrega-rapida.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { pideEntregaRapida } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Pide acelerar o adelantar: lo ve Logística.
for (const t of [
  "En el caso que se confirme, ¿hay posibilidades de entrega rápida?", "¿Pueden hacer una entrega urgente?", "Necesito envío express",
  "¿Se puede adelantar la entrega?", "¿Podrían adelantar mi pedido?", "¿Hay forma de que llegue antes?", "¿Pueden entregarlo antes del viernes?",
  "¿Se puede mandar lo antes posible?", "Hay chance de entrega rápida?", "adelantame la fecha por favor",
]) igual(`deriva: ${t}`, pideEntregaRapida(t), true);

// No: estado, plazo, reclamo o fecha puntual, siguen su camino.
for (const t of [
  "¿Cuándo llega mi pedido?", "¿Puede estar para el viernes?", "No me llegó el pedido, lo necesito urgente", "¿Qué plazo de entrega están manejando?",
  "Hace 10 días hice un pedido, quería saber el estado", "Hola, buen día", "¿Cuánto tarda el envío a Rosario?", "Quiero hacer un pedido",
  "Avísenme antes de salir", "¿Tienen entrega a domicilio?",
]) igual(`no deriva: ${t}`, pideEntregaRapida(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
