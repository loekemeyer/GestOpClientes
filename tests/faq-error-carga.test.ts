// Pruebas de cuándo un mensaje avisa un error de carga de un pedido ya hecho (supabase/functions/_shared/faq.ts, avisaErrorDeCarga). Sin red.
// Correr: deno run --allow-env tests/faq-error-carga.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { avisaErrorDeCarga } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Avisa que cargó mal un pedido: alerta para Ventas.
for (const t of [
  "Cargué todo por unidad y después lo edité por caja", "Me equivoqué al cargar el pedido", "Nos equivocamos en las cantidades del pedido",
  "Cargué por unidades pero eran cajas", "Puse unidades y quería cajas, lo cambié", "Me confundí con las cajas y las unidades",
]) igual(`error de carga: ${t}`, avisaErrorDeCarga(t), true);

// No: informar un pedido, preguntar por cajas o querer pedir.
for (const t of [
  "Ya cargué el pedido en la web", "Puse 10 cajas de abrelatas", "¿Cuántas unidades trae la caja?", "Quiero 10 unidades del 501", "Me equivoqué de día, vengo mañana",
  "Hola, buen día", "Edité mi perfil", "Cargué el comprobante de pago",
]) igual(`no es error de carga: ${t}`, avisaErrorDeCarga(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
