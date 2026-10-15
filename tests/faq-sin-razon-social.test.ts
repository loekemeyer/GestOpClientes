// Las respuestas fijas wa_faq #8 (descuentos) y #42 (datos para transferir) y los saludos no empiezan con la razón social del cliente.
// Pablo Olejavetzky, 15/10/2026 (tanda de pruebas, mensaje 1, tarea de Planify 5926): «Sí, cambiá también la #41 sin nombre» y «Sí, sacala también de #8 y #42».
// La base sólo tiene la razón social de 1.264 clientes y muchas son personas con el apellido primero («Quispe Gabriel Dario Josue»).
// Sin red: lee los sql/161 y sql/162 (lo que se aplicó en vivo) y el código de faq.ts. Lo aplicado en la base se verificó con un SELECT y con el Simulador.
// Correr: deno run --allow-env --allow-read tests/faq-sin-razon-social.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { renderTemplate } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const leer = (p: string) => Deno.readTextFileSync(new URL(`../${p}`, import.meta.url));
const RAZON = "Quispe Gabriel Dario Josue";

// ── sql/162: cada respuesta cambia sólo su primera frase, con replace, y el rollback hace el camino inverso ──
const s162 = leer("sql/162_wa_faq_sin_razon_social_al_inicio.sql");
const r162 = leer("sql/rollback/162_wa_faq_sin_razon_social_al_inicio.sql");
const PARES: Array<[number, string, string]> = [
  [8, "{{nombre_cliente}}, tus descuentos son:", "Tus descuentos son:"],
  [42, "{{nombre_cliente}}, estos son los datos para transferir:", "Estos son los datos para transferir:"],
];
for (const [id, viejo, nuevo] of PARES) {
  igual(`sql/162 cambia #${id} con replace de «${viejo}» a «${nuevo}», sólo si todavía empieza con el texto viejo`,
    s162.includes(`replace(bot_response, '${viejo}', '${nuevo}')`) && s162.includes(`where id = ${id}\n   and bot_response like '${viejo}%'`), true);
  igual(`el rollback de #${id} lo devuelve`, r162.includes(`replace(bot_response, '${nuevo}', '${viejo}')`) && r162.includes(`where id = ${id}\n   and bot_response like '${nuevo}%'`), true);
  igual(`el texto nuevo de #${id} no lleva la razón social ni el token`, nuevo.includes("{{nombre_cliente}}"), false);
}
igual("ningún texto libre de sql/161 ni sql/162 lleva punto y coma (cuelga el MCP de Supabase)", [leer("sql/161_wa_faq_saludo_sin_nombre.sql"), s162].map((s) => s.split("\n").filter((l) => !l.startsWith("--")).join("\n").replace(/;\s*$/gm, "").includes(";")), [false, false]);

// ── Las plantillas nuevas, renderizadas como lo hace faq.ts, no muestran la razón social ──
const NUEVAS = [
  "Tus descuentos son:\n📦 *Por volumen*: {{descuento_volumen}}% (ya incluido en tus precios de la web)",
  "Estos son los datos para transferir:\n\n*Alias:* {{alias}}\n*CBU:* {{cbu}}",
  "¡Hola! ¿En qué te puedo ayudar?",
];
for (const tpl of NUEVAS) {
  const r = renderTemplate(tpl, { nombre_cliente: RAZON, descuento_volumen: 10, alias: "loeke.srl", cbu: "1910027855002702387450" });
  igual(`renderizada no nombra al cliente: ${tpl.slice(0, 32).replace(/\n/g, " ")}`, r.includes(RAZON), false);
}

// ── Código: las dos variantes de #8 que arma faq.ts tampoco empiezan con la razón social ──
const faq = leer("supabase/functions/_shared/faq.ts");
igual("faq.ts: «Tu última factura:» sin razón social", faq.includes("return `Tu última factura:\\n${ultima}") && !faq.includes("${customer.business_name}, tu última factura"), true);
igual("faq.ts: texto por defecto «Tus descuentos son:» sin razón social", faq.includes("return `Tus descuentos son:\\n📦 *Por volumen*") && !faq.includes("${customer.business_name}, tus descuentos son"), true);

// ── Las 3 respuestas de estado de pedidos que arma el código tampoco empiezan con la razón social (Pablo: «Sí, sacala también de esas 3») ──
igual("faq.ts: «No tenés pedidos recientes…» sin razón social", faq.includes('return `No tenés pedidos recientes (últimos 90 días).') && !faq.includes("${customer.business_name}, no tenés pedidos recientes"), true);
igual("faq.ts: «Todos tus pedidos están entregados…» sin razón social", faq.includes("return `Todos tus pedidos están entregados. El último,") && !faq.includes("${customer.business_name}, todos tus pedidos"), true);
igual("faq.ts: el listado de pedidos arranca con el título con mayúscula, sin razón social",
  faq.includes('return `${conMayuscula(titulo)}:\\n\\n${lines.join("\\n")}${notaExpreso}') && !faq.includes("${customer.business_name}, ${titulo}"), true);
igual("conMayuscula sólo sube la primera letra", faq.includes("const conMayuscula = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);"), true);
// Ninguna respuesta que arma faq.ts empieza con la razón social del cliente.
igual("faq.ts: ninguna respuesta empieza con ${customer.business_name}", /return `\$\{customer\.business_name\}/.test(faq), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
