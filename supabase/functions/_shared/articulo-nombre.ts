// ¿El cliente NOMBRÓ un artículo en su pregunta de precio o de stock? (Pablo Olejavetzky, 06/10/2026, corrección m72 del artifact: "Te consulto, ¿me dirías el
// precio de lista? Me refiero al automate" → el bot contestaba "¿De qué artículo? Pasame el código o el nombre" aunque ya había dicho "automate".)
// Módulo puro, sin imports: lo usa faq.ts y lo prueba tests/articulo-nombre.test.ts.
//
// Causa: la búsqueda por NOMBRE de la respuesta fija (RPC wa_product_match) falla con "UNION types bigint and uuid cannot be matched" en CADA llamada
// (product_aliases.product_id es bigint y products.id es uuid), y además esa RPC sólo mira artículos activos: "Automate" (cód. 597) está inactivo. Si el cliente
// nombró algo y no se lo encontró por código, la respuesta fija no pregunta de nuevo: lo toma la IA (buscar_productos), que sabe decir "discontinuado".
// 07/10 (Pablo): la llamada a wa_product_match se SACÓ de faq.ts en vez de arreglar la RPC. Arreglada y con limit 1, el "automate" devolvía la bombilla 654
// (score 0,16) y "bombilla" / "cuchara" empatan 3 a 3: cotizaría un artículo equivocado. Por nombre resuelve la IA. Lo guarda tests/articulo-nombre.test.ts.

// Palabras de la pregunta que NO nombran un artículo (se comparan ya en minúscula y sin signos).
const PALABRAS_DE_LA_PREGUNTA = new Set([
  "tienen", "tenes", "tenés", "tiene", "hay", "stock", "disponible", "disponibles", "disponibilidad", "precio", "precios", "lista", "cuanto", "cuánto", "cual", "cuál",
  "cuales", "cuáles", "que", "qué", "sale", "salen", "cuesta", "cuestan", "vale", "valen", "me", "te", "se", "nos", "pasas", "pasás", "pasame", "pasar", "decime", "decis",
  "decís", "dirias", "dirías", "consulto", "consultar", "consulta", "quiero", "quisiera", "necesito", "saber", "favor", "por", "hola", "buen", "buenos", "buenas", "dia",
  "día", "dias", "días", "tarde", "tardes", "noche", "noches", "gracias", "refiero", "referis", "referís", "es", "son", "el", "la", "los", "las", "un", "una", "unos",
  "unas", "de", "del", "al", "a", "en", "y", "o", "con", "para", "queda", "quedan", "quedaron", "todavia", "todavía", "articulo", "artículo", "producto", "codigo", "código",
  "numero", "número", "mas", "más", "actual", "actualizado", "sin", "iva", "unidad", "caja", "cajas", "unidades",
]);

/** true si, sacadas las palabras de la pregunta, queda alguna palabra de 4 letras o más que no sea un número (un código ya se busca aparte). */
export function hayNombreDeArticulo(mensaje: string): boolean {
  const palabras = (mensaje ?? "").toLowerCase().match(/[a-záéíóúüñ0-9]+/g) ?? [];
  return palabras.some((w) => w.length >= 4 && !/^\d+[a-z]?$/.test(w) && !PALABRAS_DE_LA_PREGUNTA.has(w));
}

/** La palabra que mejor nombra el artículo: la más larga (4 letras o más) que no sea de la pregunta ni un número. null si no hay. */
export function palabraDeBusqueda(mensaje: string): string | null {
  const palabras = (mensaje ?? "").toLowerCase().match(/[a-záéíóúüñ0-9]+/g) ?? [];
  const candidatas = palabras.filter((w) => w.length >= 4 && !/^\d+[a-z]?$/.test(w) && !PALABRAS_DE_LA_PREGUNTA.has(w));
  return candidatas.sort((x, y) => y.length - x.length)[0] ?? null;
}

/** El plural sin la "s" / "es" final, para buscar "tostadores" en "Tostador Enlozado" (nunca deja menos de 4 letras). */
export function raizDeBusqueda(palabra: string): string {
  const sinEs = palabra.replace(/(?<=[a-záéíóúüñ]{4,})es$/, "");
  const sinS = palabra.replace(/(?<=[a-záéíóúüñ]{4,})s$/, "");
  return /(?:[^aeiou]es)$/.test(palabra) && sinEs.length >= 4 ? sinEs : sinS;
}
