// Pruebas de sql/158 (Pablo Olejavetzky, 15/10/2026, P8 del plan de los 8 puntos): la lista de motivos que la vista
// v_wa_resultado_charla cuenta como «derivada» tiene que ser la misma que la memoria de la charla (_shared/hechos-charla.ts,
// MOTIVOS) más bot_pausa, tope_ia y tope_gasto. Si alguien suma un motivo en un lado y no en el otro, esto falla.
// Sin red. Correr: deno run --allow-read --allow-env tests/resultado-charla-derivaciones.test.ts   (sale con código 1 si algo falla)
// hechos-charla.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { MOTIVOS } = await import("../supabase/functions/_shared/hechos-charla.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const sql = await Deno.readTextFile(new URL("../sql/158_wa_resultado_charla_derivaciones.sql", import.meta.url));
const fn = sql.slice(sql.indexOf("create or replace function public.wa_alerta_es_derivacion"), sql.indexOf("revoke all on function"));
const [motivosSql, tiposSql] = [...fn.matchAll(/array\[([^\]]*)\]/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));

const EXTRA = ["bot_pausa", "tope_ia", "tope_gasto"];
const esperado = [...Object.keys(MOTIVOS), ...EXTRA].sort();
igual("los motivos de la vista son los de hechos-charla.ts más bot_pausa, tope_ia y tope_gasto", [...motivosSql].sort(), esperado);
for (const no of ["whitelist_gate", "faq_no_match", "envio_fallido", "foto_producto", "download_meta"]) {
  igual(`${no} no cuenta como derivación`, motivosSql.includes(no) || tiposSql.includes(no), false);
}
igual("la IA caída cuenta como derivación (sin motivo, por tipo)", ["llm_timeout", "llm_error"].every((t) => tiposSql.includes(t)), true);
igual("las alertas del simulador no cuentan", /simulador', ''\) = 'true' then false/.test(fn), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
