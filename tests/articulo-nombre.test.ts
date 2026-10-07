// Pruebas de cuándo una pregunta de precio o de stock nombra un artículo (supabase/functions/_shared/articulo-nombre.ts, corrección m72). Sin red.
// Correr: node --experimental-strip-types --no-warnings tests/articulo-nombre.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import { hayNombreDeArticulo, palabraDeBusqueda, raizDeBusqueda } from "../supabase/functions/_shared/articulo-nombre.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Nombró un artículo: lo toma la IA (que lo busca, incluso si está discontinuado).
for (const t of [
  "Te consulto, ¿me dirías el precio de lista? Me refiero al automate", "¿Tienen tostadores enlozados?", "precio de las ollas", "¿cuánto sale el abrelatas?",
  "¿Hay stock de cucharas?", "Me pasás el precio del colador chino", "¿Tienen sacacorchos?",
]) igual(`nombra: ${t}`, hayNombreDeArticulo(t), true);

// No nombró nada (o sólo un código, que se busca aparte): se le pregunta de qué artículo.
for (const t of [
  "¿Cuánto sale?", "¿Cuál es el precio?", "Hola, ¿me pasás el precio?", "¿Tienen stock?", "precio del 506", "¿Cuánto cuesta el 501A?", "Buen día, ¿me decís el precio de lista?",
  "¿Cuánto sale por unidad?", "",
]) igual(`no nombra: ${JSON.stringify(t)}`, hayNombreDeArticulo(t), false);

// La palabra que se busca entre los artículos inactivos.
igual("palabra: automate", palabraDeBusqueda("Te consulto, ¿me dirías el precio de lista? Me refiero al automate"), "automate");
igual("palabra: la más larga", palabraDeBusqueda("¿Tienen tostadores enlozados?"), "tostadores");
igual("palabra: sin nombre", palabraDeBusqueda("¿Cuánto sale?"), null);
igual("palabra: sólo un código", palabraDeBusqueda("precio del 506"), null);

// La raíz: el plural no impide hallar el artículo.
for (const [pl, raiz] of [["tostadores", "tostador"], ["ollas", "olla"], ["cucharas", "cuchara"], ["sacacorchos", "sacacorcho"], ["automate", "automate"], ["coladores", "colador"], ["bombillas", "bombilla"], ["tazas", "taza"]]) igual(`raíz: ${pl}`, raizDeBusqueda(pl), raiz);

// Guarda sobre el código: la respuesta fija NO busca por nombre con la RPC wa_product_match (Pablo, 07/10). Falla en cada llamada (bigint vs uuid) y, arreglada,
// con limit 1 y sin umbral cotizaba el artículo equivocado ("automate" → bombilla 654). Si alguien la vuelve a conectar, que lo decida a propósito.
const faqTs = readFileSync(new URL("../supabase/functions/_shared/faq.ts", import.meta.url), "utf8");
igual("faq.ts no llama a la RPC wa_product_match", /\.rpc\(\s*["']wa_product_match/.test(faqTs), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
