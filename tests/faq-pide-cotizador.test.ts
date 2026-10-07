// Pruebas de cuándo un cliente PIDE el cotizador (supabase/functions/_shared/faq.ts, pideElCotizador). Sin red.
// Pablo Olejavetzky, 06/10/2026 (corrección m41): los pedidos ya no van por el cotizador sino por la web; si lo pide se le recuerda y se le da el acceso.
// Si lo MANDA (adjunto o "te paso el cotizador con el pedido") entra por el lector de archivos, no por acá.
// Correr: deno run --allow-env tests/faq-pide-cotizador.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { pideElCotizador } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Lo PIDE: se le recuerda que los pedidos van por la web.
for (const t of [
  "Me pasás el cotizador actualizado", "Me pasas el cotizador actualizado?", "¿Me podés mandar el cotizador?", "mandame el cotizador", "pasame el cotizador de octubre",
  "Necesito el cotizador nuevo", "Quiero el cotizador", "¿Tienen el cotizador actualizado?", "Hay cotizador nuevo?", "Buen día, me envían el cotizador por favor",
  "¿Podrían enviarnos el cotizador de este mes?", "Buscaba el cotizador", "Me mandan el cotizador actualizado?", "queremos hacer un pedido, me pasan el cotizador",
]) igual(`lo pide: ${t}`, pideElCotizador(t), true);

// No lo pide: sigue su camino (lector de archivos, respuesta de lista de precios, Cobranzas o la IA).
for (const t of [
  "Te paso el cotizador con el pedido", "Les mando el cotizador completo", "Adjunto el cotizador", "te envío el cotizador por mail",
  "El cotizador no me abre", "No me deja subir el cotizador", "No puedo cargar el cotizador", "me da error el cotizador",
  "¿Hay descuento sin cotizador?", "El pago es a 30 días, sin cotizador", "¿qué descuento tiene el cotizador?",
  "¿Me pasás la lista de precios?", "¿Cuánto sale el abrelatas?", "¿Sigue vigente la lista de septiembre 2025?", "Hola, buen día", "Quiero 5 cajas del 512",
]) igual(`no lo pide: ${t}`, pideElCotizador(t), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
