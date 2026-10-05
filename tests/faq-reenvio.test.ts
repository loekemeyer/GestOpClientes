// Pruebas de cuándo la respuesta fija #10 reenvía la factura (supabase/functions/_shared/faq.ts). Sin red.
// Correr: deno run --allow-env tests/faq-reenvio.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { RE_PIDE_FACTURA, RE_QUIERE_FACTURA } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const reenvia = (t: string) => RE_PIDE_FACTURA.test(t) || RE_QUIERE_FACTURA.test(t);

// La pide: se reenvía.
for (const t of ["No me llegó la factura, ¿me la mandás por acá?", "Buen día, ¿me pasás la factura así podemos abonar?",
  "Necesito la factura", "quiero las facturas del 25/09", "No recibí la factura", "¿Necesitás la factura? Sí, necesitamos la factura", "No encuentro mi factura",
  "¿Dónde está la factura?", "la factura?", "Factura por favor", "¿Y las facturas?"]) igual(`reenvía: ${t}`, reenvia(t), true);

// Pregunta sobre facturas: va a la IA (caso de Pablo del 05/10 y la 4.9 de "Respuestas del bot por causa").
for (const t of ["¿Eso son las 3 facturas?", "Eso son las 3 facturas?",
  "¿Son estas cuatro facturas? ¿Cuánto debo pagar? El total de estas cuatro facturas es lo que debo pagar, ¿verdad?",
  "¿La factura tiene el descuento?", "Necesito saber si la factura tiene el descuento", "En las últimas facturas no veo el descuento"])
  igual(`va a la IA: ${t}`, reenvia(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
