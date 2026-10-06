// ¿El cliente NOMBRÓ un artículo en su pregunta de precio o de stock? (Pablo Olejavetzky, 06/10/2026, corrección m72 del artifact: "Te consulto, ¿me dirías el
// precio de lista? Me refiero al automate" → el bot contestaba "¿De qué artículo? Pasame el código o el nombre" aunque ya había dicho "automate".)
// Módulo puro, sin imports: lo usa faq.ts y lo prueba tests/articulo-nombre.test.ts.
//
// Causa: la búsqueda por NOMBRE de la respuesta fija (RPC wa_product_match) falla con "UNION types bigint and uuid cannot be matched" en CADA llamada
// (product_aliases.product_id es bigint y products.id es uuid), y además esa RPC sólo mira artículos activos: "Automate" (cód. 597) está inactivo. Si el cliente
// nombró algo y no se lo encontró por código, la respuesta fija no pregunta de nuevo: lo toma la IA (buscar_productos), que sabe decir "discontinuado".

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
