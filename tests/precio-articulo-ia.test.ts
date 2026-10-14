// El precio de un artículo lo da la IA y siempre lleva "+ IVA" (Pablo Olejavetzky, 14/10/2026: «La IA tendría que buscar el precio y darlo» y «agregale más IVA»).
// Antes la respuesta fija #12 cotizaba por código: el artículo inactivo 597 a $ 8.888 en vez de "no disponible por el momento" y por UNIDAD con un 2 % de descuento web fijo,
// mientras la IA da el precio por caja con el descuento por volumen del cliente. Son pruebas del TEXTO del prompt y del código (no prueban al modelo): evitan que se pierda sin que nadie se entere.
// Correr: node --experimental-strip-types --no-warnings tests/precio-articulo-ia.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import { REGLAS_OPERATIVAS, REGLA_PEDIDOS_WA } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
const fuente = (ruta: string) => readFileSync(new URL(ruta, import.meta.url), "utf8");

// La regla del prompt: una sola línea, con el aviso de que son sin IVA y la excepción de las facturas.
const lineas = REGLAS_OPERATIVAS.split("\n").filter((l) => l.startsWith("- PRECIO DE UN ARTÍCULO"));
ok("hay una regla PRECIO DE UN ARTÍCULO y es de una sola línea", lineas.length === 1);
const regla = lineas[0] ?? "";
ok("dice que los precios de buscar_productos son SIN IVA", /buscar_productos/.test(regla) && /SIN IVA/.test(regla));
ok("pide agregar «+ IVA» a cada precio de un artículo, también en una lista", /«\+ IVA»/.test(regla) && /varios en una lista/.test(regla));
ok("nombra los tres campos de precio de buscar_productos", ["precio_cliente_por_caja", "precio_lista_por_caja", "precio_lista_por_unidad"].every((c) => regla.includes(c)));
ok("no toca los importes de facturas y deuda (ya vienen con IVA)", /facturas y de la deuda ya vienen con IVA/.test(regla) && /consultar_mis_facturas/.test(regla));
ok("no lleva punto y coma (regla del MCP de Supabase)", !regla.includes(";"));

// La descripción de la herramienta y los pasos del pedido por WhatsApp.
const conv = fuente("../supabase/functions/_shared/bot-conversation.ts");
const desc = conv.slice(conv.indexOf('name: "buscar_productos"'), conv.indexOf('name: "buscar_productos"') + 1500);
ok("la herramienta buscar_productos avisa que sus precios son SIN IVA", /son SIN IVA: al decírselos al cliente agregá «\+ IVA»/.test(desc));
ok("el pedido por WhatsApp dice el precio por caja siempre «+ IVA»", /precio POR CAJA de cada uno, siempre «\+ IVA»/.test(REGLA_PEDIDOS_WA));

// La respuesta fija por código se fue: ya no hay lookupProductPrice y el precio de un artículo, con cliente, va a la IA.
const faq = fuente("../supabase/functions/_shared/faq.ts");
ok("faq.ts ya no tiene lookupProductPrice", !/lookupProductPrice/.test(faq));
ok("faq.ts: con cliente, el precio de un artículo (product_price) devuelve null y lo toma la IA",
  /else if \(customer\) \{[^}]*?if \(top\.db_lookup_type === "product_price"\) return null;/s.test(faq));
ok("faq.ts no cotiza con un descuento web fijo", !/webDiscount\s*=\s*0\.02/.test(faq));

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
