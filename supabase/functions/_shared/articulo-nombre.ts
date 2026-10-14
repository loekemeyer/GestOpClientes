// ¿El cliente NOMBRÓ un artículo en su pregunta de precio o de stock? (Pablo Olejavetzky, 06/10/2026, corrección m72 del artifact: "Te consulto, ¿me dirías el
// precio de lista? Me refiero al automate" → el bot contestaba "¿De qué artículo? Pasame el código o el nombre" aunque ya había dicho "automate".)
// Módulo puro, sin imports: lo usa faq.ts y lo prueba tests/articulo-nombre.test.ts.
//
// Causa: la búsqueda por NOMBRE de la respuesta fija (RPC wa_product_match) falla con "UNION types bigint and uuid cannot be matched" en CADA llamada
// (product_aliases.product_id es bigint y products.id es uuid), y además esa RPC sólo mira artículos activos: "Automate" (cód. 597) está inactivo. Si el cliente
// nombró algo y no se lo encontró por código, la respuesta fija no pregunta de nuevo: lo toma la IA (buscar_productos), que sabe decir que no está disponible.
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

// Pablo Olejavetzky, 14/10/2026: "¿cuánto sale el automate?" recibía el link de la lista de precios (FAQ #11, `consultar_precios`) y nunca llegaba a la IA. Causa: en
// wa_faq_match "cuanto sale" empata 2 a 2 entre #11 (prioridad 72) y #12 `consulta_precio_articulo` (68) y el desempate por prioridad es para #11; "precio automate" y
// "qué precio tiene el 597" también las gana #11 (la palabra "precio" sólo la tiene ella). La guarda del m72 sólo mira #12 y #13. Pablo: "la IA tendría que buscar el precio y darlo".
// Un mensaje es "el precio de un artículo" si pide un precio y, sacadas las palabras de un pedido de LISTA (lista, catálogo, web, vigente, nueva, Chef…), queda un código de
// artículo o un nombre. "¿Me pasás la lista de precios?", "¿Qué precio tienen?" o "¿cuánto sale la caja de 12 unidades?" no nombran nada: siguen en la respuesta fija.
// Los tiempos del verbo cuentan: wa_faq_match engancha "cuánto salió", "cuanto salio el 505" y "cuánto saldría" con la FAQ #11 por el rescate difuso (puntaje 1,001), así que
// "¿cuánto salió el pelador de mi último pedido?" (Simulador, 14/10) recibía el link de la lista. Con "me" o "nos" en el medio ("cuánto me salió") la FAQ no puntúa, pero se acepta igual.
const RE_PIDE_PRECIO = /(?<![a-záéíóúüñ])(?:cu[aá]nto\s+(?:me\s+|nos\s+)?(?:sal(?:e|en|i[oó]|ieron|dr[ií]a|dr[ií]an)|va(?:n)?\s+a\s+salir|cuest(?:a|an)|cost[oó]|costaron|val(?:e|en|[ií]a|[ií]an))|precios?)(?![a-záéíóúüñ])/i;
const RE_PALABRAS_DE_LISTA = /(?<![a-záéíóúüñ])(?:listas?|cotizador|cotizaci[oó]n(?:es)?|cat[aá]logos?|p[aá]ginas?|web|vigentes?|actualizad[ao]s?|nuev[ao]s?|complet[ao]s?|[uú]ltim[ao]s?|novedades|productos|art[ií]culos|mercader[ií]a|chef|loekemeyer|pdf|excel|sigue|siguen|hubo|aumentos?|aumentaron|subieron|cambiaron|actualizaron|sali[oó]|salieron|saldr[ií]an?|cost[oó]|costaron|val[ií]an?)(?![a-záéíóúüñ])/gi;
// Igual que articuloDeLaFrase (faq.ts): 3 a 5 caracteres, con una letra al final a lo sumo. Un año (2026) no es un código: ningún artículo de LK empieza con 19 o 20 y tiene 4 dígitos.
const RE_CODIGO_DE_ARTICULO = /(?<![a-z0-9])(?!(?:19|20)\d\d(?![a-z0-9]))\d{3,5}[a-z]?(?![a-z0-9])/i;

/** true si el mensaje pide el precio de un artículo (por código o por nombre) y no la lista de precios. */
export function preguntaPrecioDeArticulo(mensaje: string): boolean {
  const m = mensaje ?? "";
  if (!RE_PIDE_PRECIO.test(m)) return false;
  const sinLista = m.replace(RE_PALABRAS_DE_LISTA, " ");
  return RE_CODIGO_DE_ARTICULO.test(sinLista) || hayNombreDeArticulo(sinLista);
}
