// Pruebas de cuándo "paso un pedido y lo quiero para tal día" lo contesta el bot con la fecha estimada (supabase/functions/_shared/faq.ts, pedidoParaFecha). Sin red.
// Correr: deno run --allow-env tests/faq-pedido-fecha.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { pedidoParaFecha, RE_PLAZO_ENTREGA } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Pasa un pedido NUEVO y pregunta si puede estar para una fecha: fecha estimada + Ventas.
for (const t of [
  "Paso un pedidito. ¿Puede estar para el viernes?", "Te paso un pedido, ¿pueden entregarlo antes del 15?", "Hago un pedido, ¿llega para mañana?",
  "Quiero hacer un pedido, ¿podrían tenerlo para el lunes?", "Mando un pedido hoy, ¿está para el 20/10?", "Cargo un pedido ahora, ¿puede estar hasta el jueves?",
]) igual(`pedido nuevo + fecha: ${t}`, pedidoParaFecha(t), true);

// No: un pedido ya hecho, un pedido sin fecha, una fecha sin pedido nuevo.
for (const t of [
  "¿Puede llegar el viernes mi pedido?", "Paso un pedidito", "Quiero hacer un pedido", "¿Cuándo llega mi pedido?", "Agregame 2 cajas al pedido, ¿puede estar para el viernes?",
  "Hola, buen día", "¿Se puede entregar antes del viernes?", "Quiero hacer un pedido para el viernes",
]) igual(`no: ${t}`, pedidoParaFecha(t), false);

// m61: el plazo general lo atrapa RE_PLAZO_ENTREGA (sin cambios); el texto nuevo va en plazo-entrega.ts.
igual("m61 lo detecta el plazo", RE_PLAZO_ENTREGA.test("Quería consultar qué período de tiempo están contemplando actualmente para entregas"), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
