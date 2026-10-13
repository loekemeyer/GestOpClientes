// Pruebas del detector pideCargarPedido de supabase/functions/_shared/faq.ts (Pablo Olejavetzky, 13/10/2026, Simulador): "Hola, quiero 6 cajas del pelapapas 505, pago contado y que me lo
// manden por expreso a mi dirección" salía con la respuesta fija de medios de pago (#15, el CBU) y no tomaba el pedido. Sin red. Correr: deno run --allow-env --allow-read tests/faq-pide-cargar-pedido.test.ts
// (sale con código 1 si algo falla)
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { pideCargarPedido } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

for (const t of [
  "Hola, quiero 6 cajas del pelapapas 505, pago contado y que me lo manden por expreso a mi dirección",
  "Quiero 6 cajas del 505", "necesito 10 cajas del abrelatas 501", "Necesitamos 3 docenas de cucharones", "me llevo 3 docenas del 067",
  "Mandame 6 cajas del 505 por favor", "enviame 12 cajas del 505, pago contado", "Quiero pedir 6 cajas del 505", "quisiera comprar 20 unidades del 505",
  "Pedimos 8 cajas de pelapapas, contado y por expreso", "Anotame 4 cajas del 501", "quiero unas 6 cajas del pelador", "Hola buen día, necesito 2 cajas de la 505 y 3 de la 501",
])
  igual(`dispara: ${t}`, pideCargarPedido(t), true);

for (const t of [
  "¿Cuánto sale la caja de 12 unidades?", "El mínimo son 12 cajas?", "Quiero saber si aceptan pago contado", "¿Aceptan pago contado?", "Hola, buen día", "¿Cuándo llega mi pedido?",
  "Quiero hacer un pedido", "pago contado", "¿Cómo hago para pagar contado?", "¿Hacen entregas de menos de 10 cajas?", "Necesito el CBU para transferir", "Quiero la lista de precios",
  "Quiero saber el stock de 6 cajas", "Ya pagué las 6 cajas del 505", "Les paso el cotizador con el pedido", "¿Puedo pedir 6 cajas sueltas?",
])
  igual(`no dispara: ${t}`, pideCargarPedido(t), false);

// Guarda sobre el código: vaALaIA tiene que consultar el detector (si no, el mensaje vuelve a caer en la respuesta fija de medios de pago).
const fuente = await Deno.readTextFile(new URL("../supabase/functions/_shared/faq.ts", import.meta.url));
const cuerpo = fuente.slice(fuente.indexOf("function vaALaIA(text: string): boolean {"), fuente.indexOf("async function pedidosDuplicados"));
igual("código: vaALaIA consulta pideCargarPedido", cuerpo.includes("pideCargarPedido(text)"), true);
igual("código: handleFaq manda a la IA lo que vaALaIA marca, para clientes", /if \(customer && vaALaIA\(text\)\) return null;/.test(fuente), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
