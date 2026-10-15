// Cliente de Loekemeyer con cuenta de Chef pero sin compras recientes que NOMBRA Chef (Pablo Olejavetzky, 14/10/2026). Simulador, LK 1987 (cuenta de Chef 1891, 0 pedidos en 90 días):
// «¿qué pedidos tengo en Chef?» recibía los pedidos de Loekemeyer sin decir de qué marca eran, porque la cuenta inactiva cortaba la puerta de marca (marca.ts) antes de mirar si el mensaje
// nombraba la marca. Sin red: prueba qué frases cuentan como «nombra Chef» y que la puerta use esa señal. Lo que contesta el flujo de Chef se mide en el Simulador.
// Correr: deno run --allow-env --allow-read tests/marca-chef-inactiva.test.ts   (sale con código 1 si algo falla)
// pedidos-marca.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { marcaNombrada } = await import("../supabase/functions/_shared/pedidos-marca.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Nombra Chef: va al flujo de Chef aunque la cuenta no tenga compras recientes.
for (const t of ["¿qué pedidos tengo en Chef?", "¿Cuál es mi último pedido de Chef?", "el pedido de Chef todavía no llegó", "¿cómo va mi pedido de la marca Chef?", "quiero saber del lado Chef"]) {
  igual(`nombra Chef: ${t}`, marcaNombrada(t), "chef");
}
// No nombra ninguna marca, o nombra Loekemeyer, o las dos: sigue el flujo de siempre (la puerta devuelve null con la cuenta inactiva).
for (const [t, esperado] of [["¿cuál es mi último pedido?", null], ["¿cuánto debo?", null], ["¿qué pedidos tengo de Loekemeyer?", "lk"], ["el pedido de Loeke", "lk"],
  ["los pedidos de Chef y de Loeke", "ambas"], ["precio del cuchillo chef", null], ["hola", null]] as Array<[string, string | null]>) {
  igual(`${esperado ?? "ninguna"}: ${t}`, marcaNombrada(t), esperado);
}

// La puerta usa esa señal: sin cuenta activa, sólo sigue por Chef si NOMBRA Chef y el CUIT tiene cuenta de Chef (cuentaChefPorCuit).
const marca = Deno.readTextFileSync(new URL("../supabase/functions/_shared/marca.ts", import.meta.url));
const bloque = marca.slice(marca.indexOf("const cuenta = await cuentaChefDeCliente(customer);"), marca.indexOf("const h = leerHistorial("));
igual("puertaMarca: sin cuenta activa, si no nombra Chef devuelve null", /if \(!cuenta\) \{[\s\S]*?if \(marcaNombrada\(t\) !== "chef"\) return null;/.test(bloque), true);
igual("puertaMarca: nombra Chef y hay cuenta por CUIT, lo resuelve el flujo de Chef", /const sinActividad = await cuentaChefPorCuit\(customer\);\s*if \(!sinActividad\) return null;\s*return await resolver\("chef", t, phone, sinActividad\);/.test(bloque), true);
igual("cuentaChefPorCuit busca por CUIT en bot_cuentas CH y no por código (el 1987 de Chef es otra empresa)",
  /export async function cuentaChefPorCuit[\s\S]*?\.eq\("empresa", "CH"\)\.eq\("cuit", cuit\)/.test(marca) && !/cuentaChefPorCuit[\s\S]{0,400}cod_cliente\)\.eq/.test(marca.slice(marca.indexOf("export async function cuentaChefPorCuit"), marca.indexOf("export async function cuentaChefPorCuit") + 700)), true);
igual("cuentaChefDeCliente sigue descartando la cuenta inactiva (sin esto la puerta le preguntaría la marca a todos)", /decidirActividadChef\(facs === null \? null : facs\.length, pedidos\);\s*if \(act !== "inactivo"\) cuenta = /.test(marca), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
