// catalogo-chef — "¿tienen X?" de un cliente de Chef (Pablo Olejavetzky, 01/10, D008 fase 4, paso A).
//
// Hasta acá, un cliente de Chef que preguntaba por un producto iba a una persona: el bot sólo conoce el catálogo de Loekemeyer
// (bot_buscar_productos busca en `products`) y 100 de los 104 artículos activos de Chef no existen ahí. Este módulo busca en el
// catálogo PROPIO de Chef (chef_ext.products, la base de Chef vía FDW) con la RPC bot_buscar_productos_chef (sql/121), sin IA:
//   · código, descripción de Chef, unidades por caja y stock de Chef (stockArticulo con empresa "CH"; "hay", "limitado" o "sin");
//   · SIN precio — REGLA VIGENTE (Pablo, 01/10): hasta que Thommy confirme la fórmula (lista de Chef × unidades por caja ×
//     (1 − descuento de clientes_dto) + IVA; consulta c-20261001-1557-1) el bot no muestra precios de Chef. Si lo pide, lo pasa una
//     persona (alerta cliente_chef). No implementar precios acá sin esa respuesta (D008);
//   · SIN foto (todavía, paso C): la columna images de Chef está vacía pero las fotos EXISTEN: 104 de 104 artículos activos tienen un
//     JPEG por código (<cod>.jpg) en el bucket público products-images de la base de Chef. No consultarlo en ráfaga: ~100 pedidos
//     seguidos dan 429 too_many_connections (01/10).
// Regla (Pablo, 01/10): el producto de un código dual (437E, 438E, 439E, 809E) es el mismo en las dos empresas pero el precio es
// distinto: la descripción y el precio salen SIEMPRE del catálogo de la empresa que consulta, nunca del otro.
//
// Cuándo contesta: sólo ante una pregunta clara de producto (tienen/hay/venden/stock/precio/código/catálogo + un nombre o código).
// Ante la duda devuelve null y el cliente sigue a una persona: un falso negativo es seguro, un falso positivo no.
import { supabase } from "./supabase.ts";
import { type StockArticulo, stockArticulo, stockNecesitaHumano, textoStock } from "./stock.ts";

export type ProductoChef = { cod: string; category: string | null; subcategory: string | null; description: string; uxb: number };
export type RespuestaProductos = { reply: string; via: string; alerta?: { motivo: string; detalle: string } };

const sinAcentos = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Pregunta de producto, sobre el texto sin acentos. No incluye "necesito / quiero / busco": eso suele ser un pedido, que no se toma por acá.
const RE_CUE = /\b(tienen|tienes|tenes|tiene|hay|venden|vende|manejan|trabajan|ofrecen|consigo|precio|precios|cuanto (sale|salen|cuesta|cuestan|vale|valen)|a cuanto|stock|disponible|disponibles|disponibilidad|codigo|cod|catalogo|lista de precios)\b/;
const RE_PRECIO = /\b(precio|precios|cuanto (sale|salen|cuesta|cuestan|vale|valen)|a cuanto|lista de precios)\b/;
const RE_CATALOGO = /\b(catalogo|lista de precios|lista)\b/;
// Cosas que NO son una búsqueda de producto aunque traigan una palabra de la lista de arriba.
const RE_OTRO_TEMA = /\b(pedido|pedidos|factura|facturas|pago|pagos|transferencia|envio|envios|entrega|remito|saldo|reclamo|devolucion|nota de credito|cuit|clave|contrasena)\b/;

const STOP = new Set(("a al algo alguna alguno algunos algunas alguien ante aca aqui ahi ahora buen buena buenas buenos dia dias tarde tardes noche hola che " +
  "de del la las el los lo un una unos unas y o e u en por para con sin que es son me te se mi tu su nos les le si no ya muy mas como cual cuales " +
  "favor porfa gracias queria quiero quisiera necesito busco buscando tienen tienes tenes tiene tener hay venden vende manejan trabajan ofrecen consigo conseguir " +
  "ver saber comprar pedir precio precios cuanto sale salen cuesta cuestan vale valen stock disponible disponibles disponibilidad codigo cod catalogo lista " +
  "articulo articulos producto productos chef medida tamano tambien persona personas ayuda ayudar hablar comunicar comunicarme atencion consulta consultas " +
  "duda dudas problema urgente hoy manana mensaje responder respuesta").split(" "));
const UNIDADES = new Set(["cm", "mm", "mt", "mts", "lt", "lts", "kg", "gr", "grs", "ml", "unidad", "unidades", "caja", "cajas", "pulgadas", "x"]);

/** "coladores" → "colador", "cuchillos" → "cuchillo": ILIKE '%colador%' encuentra el singular y el plural. */
function singular(p: string): string {
  if (p.length > 5 && /[drlnz]es$/.test(p)) return p.slice(0, -2);
  if (p.length > 3 && p.endsWith("s")) return p.slice(0, -1);
  return p;
}

/**
 * Qué buscar en un mensaje: hasta 3 términos (palabras del producto o códigos tipo "437E") y las medidas sueltas ("16"), que sólo
 * desempatan. Todo sin acentos y en minúscula.
 */
export function terminosDeBusqueda(text: string): { terminos: string[]; numeros: string[] } {
  const palabras = sinAcentos(text).replace(/(\d)([a-z]{2,})/g, "$1 $2").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const terminos: string[] = [], numeros: string[] = [];
  for (const p of palabras) {
    if (STOP.has(p) || UNIDADES.has(p)) continue;
    if (/^\d{1,2}$/.test(p)) { if (!numeros.includes(p)) numeros.push(p); continue; }
    if (/^\d{3,4}[a-z]?$/.test(p)) { if (!terminos.includes(p)) terminos.push(p); continue; }   // código: 043, 437E, 1010
    if (p.length < 3 || /^\d/.test(p)) continue;
    const s = singular(p);
    if (!terminos.includes(s)) terminos.push(s);
  }
  return { terminos: terminos.slice(0, 3), numeros: numeros.slice(0, 2) };
}

/** ¿Es una pregunta de producto (y no un pedido, una factura, un saludo…)? Conservador a propósito. */
export function esConsultaProducto(text: string): boolean {
  const n = sinAcentos(text);
  return RE_CUE.test(n) && !RE_OTRO_TEMA.test(n);
}

/**
 * Junta los resultados de cada término: un producto vale por la cantidad de términos que cumple (+0,5 por cada medida que figura en
 * su descripción) y se queda con los de mayor puntaje, o sea "colador 16" muestra sólo el de 16 cm si existe.
 */
export function rankearProductos(porTermino: ProductoChef[][], numeros: string[]): ProductoChef[] {
  const m = new Map<string, { p: ProductoChef; score: number }>();
  for (const lista of porTermino) {
    for (const p of lista) {
      const e = m.get(p.cod) ?? { p, score: 0 };
      e.score += 1;
      m.set(p.cod, e);
    }
  }
  for (const e of m.values()) {
    const d = sinAcentos(e.p.description);
    for (const n of numeros) if (new RegExp(`(^|\\D)${n}(\\D|$)`).test(d)) e.score += 0.5;
  }
  const todos = [...m.values()];
  const max = Math.max(0, ...todos.map((e) => e.score));
  return todos.filter((e) => e.score === max).map((e) => e.p).sort((a, b) => a.description.localeCompare(b.description, "es"));
}

const MAX_LISTA = 8;      // productos que se listan
const MAX_CON_STOCK = 5;  // hasta acá se consulta el stock de cada uno

const nombreProd = (p: ProductoChef) => `*${String(p.description).trim()}* (cód. ${p.cod})`;
const cajaDe = (p: ProductoChef) => `caja de ${p.uxb}`;
const etiquetaStock = (s: StockArticulo | null | undefined) =>
  !s ? "" : s.incierto ? " · stock a confirmar" : s.nivel === "hay" ? " · hay stock ✅" : s.nivel === "limitado" ? " · stock limitado" : " · sin stock por ahora";

/** Texto de la respuesta, sin tocar la red. `stocks` = stock de Chef por código (null = no se pudo leer). */
export function textoProductosChef(
  prods: ProductoChef[], stocks: Map<string, StockArticulo | null>, precio: boolean,
): { reply: string; alerta?: { motivo: string; detalle: string } } {
  const cierrePrecio = precio ? "\n\nEl precio te lo pasa una persona del equipo por acá. 🙏" : "";
  const alertaPrecio = precio ? { motivo: "cliente_chef", detalle: `Cliente de Chef pide el precio de: ${prods.slice(0, 3).map((p) => `${p.description.trim()} (${p.cod})`).join("; ")}.` } : undefined;
  if (prods.length === 1) {
    const p = prods[0], s = stocks.get(p.cod);
    // Si pregunta el precio no se le habla de stock: "stock limitado, te confirmo la cantidad" no era lo que pidió.
    if (precio) return { reply: `${nombreProd(p)} está en el catálogo de Chef. Viene en ${cajaDe(p)}.${cierrePrecio}`, alerta: alertaPrecio };
    const cuerpo = s ? textoStock(String(p.description).trim(), p.cod, s) : `${nombreProd(p)} está en el catálogo de Chef.`;
    const alertaStock = s && stockNecesitaHumano(s)
      ? { motivo: "consulta_stock", detalle: `Consulta de stock de Chef: ${String(p.description).trim()} (${p.cod})` } : undefined;
    return { reply: `${cuerpo} Viene en ${cajaDe(p)}.`, alerta: alertaStock };
  }
  const lista = prods.slice(0, MAX_LISTA);
  const conStock = lista.length <= MAX_CON_STOCK;
  const lineas = lista.map((p) => `• ${nombreProd(p)} — ${cajaDe(p)}${conStock ? etiquetaStock(stocks.get(p.cod)) : ""}`);
  const mas = prods.length > MAX_LISTA ? `\nHay más resultados: decime la medida o el tipo para afinar.` : "";
  return {
    reply: `Encontré estos productos de *Chef*:\n\n${lineas.join("\n")}${mas}\n\n` +
      `Decime el código del que te interesa y te confirmo ${conStock ? "el detalle" : "el stock"}.${cierrePrecio}`,
    alerta: alertaPrecio,
  };
}

async function buscarEnChef(q: string): Promise<ProductoChef[]> {
  const { data, error } = await supabase.rpc("bot_buscar_productos_chef", { p_query: q, p_limit: 20 });
  if (error) throw new Error(error.message);
  return (data ?? []) as ProductoChef[];
}

/**
 * La respuesta a "¿tienen X?" de un cliente de Chef, o null si no es una pregunta de producto o si algo falla (entonces sigue a una
 * persona). `alerta` = lo que hay que avisar a una persona, lo manda chef.ts con los datos de la cuenta.
 */
export async function responderProductosChef(text: string): Promise<RespuestaProductos | null> {
  const t = text.trim();
  if (!esConsultaProducto(t)) return null;
  const n = sinAcentos(t);
  const { terminos, numeros } = terminosDeBusqueda(t);
  const precio = RE_PRECIO.test(n);

  if (!terminos.length) {
    // "¿Tienen catálogo?" / "pasame la lista de precios": Chef no tiene un PDF cargado en el bot.
    if (RE_CATALOGO.test(n)) {
      return { reply: "El catálogo y la lista de precios de Chef te los pasa una persona del equipo por acá. 🙏", via: "chef_catalogo_persona",
        alerta: { motivo: "cliente_chef", detalle: "Cliente de Chef pide el catálogo o la lista de precios." } };
    }
    return null;
  }
  let prods: ProductoChef[];
  try {
    prods = rankearProductos(await Promise.all(terminos.map(buscarEnChef)), numeros);
  } catch (e) {
    console.error("responderProductosChef:", e instanceof Error ? e.message : e);
    return null;
  }
  if (!prods.length) {
    return { reply: "No encontré ese producto en el catálogo de Chef. Le paso tu consulta a una persona del equipo para que te confirme. 🙏",
      via: "chef_producto_sin_resultado",
      alerta: { motivo: "cliente_chef", detalle: `Cliente de Chef busca "${terminos.join(" ")}" y no figura en el catálogo de Chef.` } };
  }
  // Stock de Chef de los primeros resultados; si Gestión no responde para uno, se muestra sin la etiqueta.
  const stocks = new Map<string, StockArticulo | null>();
  if (prods.length <= MAX_CON_STOCK) {
    const r = await Promise.allSettled(prods.map((p) => stockArticulo(p.cod, "CH")));
    r.forEach((x, i) => stocks.set(prods[i].cod, x.status === "fulfilled" ? x.value : null));
  }
  const { reply, alerta } = textoProductosChef(prods, stocks, precio);
  return { reply, via: "chef_productos", ...(alerta ? { alerta } : {}) };
}
