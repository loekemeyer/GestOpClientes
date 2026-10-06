// Pruebas del texto de stock para el cliente (supabase/functions/_shared/stock.ts, textoStock): singular y plural de "caja". Sin red.
// Correr: deno run --allow-env tests/stock-texto.test.ts   (sale con código 1 si algo falla)
// stock.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { textoStock } = await import("../supabase/functions/_shared/stock.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
// deno-lint-ignore no-explicit-any
const hay: any = { cod: "501", libre: 50, comprometido: 5, disponible: 45, nivel: "hay" };
// deno-lint-ignore no-explicit-any
const poco: any = { cod: "501", libre: 3, comprometido: 1, disponible: 2, nivel: "limitado" };

igual("1 caja con stock", textoStock("Abrelatas", "501", hay, 1), "Sí, *Abrelatas* (cód. 501) tiene stock para la caja. ✅");
igual("6 cajas con stock", textoStock("Pelador", "505", hay, 6), "Sí, *Pelador* (cód. 505) tiene stock para las 6 cajas. ✅");
igual("stock limitado y pide 1 caja", /puede no alcanzar para 1 caja\./.test(textoStock("Abrelatas", "501", { ...poco, disponible: 0 }, 1)), true);
igual("stock limitado y pide 5 cajas", /puede no alcanzar para 5 cajas\./.test(textoStock("Abrelatas", "501", poco, 5)), true);
igual("nunca 'las 1 cajas'", /las 1 cajas/.test(textoStock("Abrelatas", "501", hay, 1)), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
