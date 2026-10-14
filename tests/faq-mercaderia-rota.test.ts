// Pruebas de cuándo una consulta es "me llegó mercadería rota/fallada" (reclamo) vs "¿me PODRÍA venir dañada?" (duda a futuro).
// supabase/functions/_shared/faq.ts, esMercaderiaRota. Sin red.
// Correr: deno run --allow-env tests/faq-mercaderia-rota.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { esMercaderiaRota } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Reclamo real: algo YA recibido que vino roto/fallado → abre reclamo.
for (const t of [
  "Los coladores vinieron todos rotos",
  "me llegó un producto roto",
  "recibí la caja con todo dañado",
  "me mandaron 3 pelapapas fallados",
  "abrí la caja y estaba todo quebrado",
  "llegó en mal estado",
  "se me rompieron dos cajas en el envío que recibí",
  "me van a tener que reponer lo que llegó roto",   // futuro + "llegó" → sigue siendo reclamo
]) igual(`reclamo: ${t}`, esMercaderiaRota(t), true);

// Duda a futuro / hipotética: todavía no recibió nada, sólo pregunta/teme → NO es reclamo (lo atiende el agente).
for (const t of [
  "me van a entregar productos dañados?",
  "¿me van a mandar algo roto?",
  "y si viene dañado?",
  "espero que no venga roto",
  "¿puede llegar fallado el pedido?",
  "ojalá no lleguen rotos",
]) igual(`duda a futuro: ${t}`, esMercaderiaRota(t), false);

// Sin rotura: ni se considera.
for (const t of [
  "¿cuándo llega mi pedido?",
  "quiero 48 unidades del 208",
  "hola, buen día",
]) igual(`no rotura: ${t}`, esMercaderiaRota(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
