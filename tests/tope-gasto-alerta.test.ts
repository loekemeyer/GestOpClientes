// Que el motivo `tope_gasto` quede registrado donde el resto del sistema lo busca (categoría, origen en Derivaciones, semáforo y medidas de seguridad).
// Sin red, sin IA. Correr: deno run --allow-env tests/tope-gasto-alerta.test.ts   (sale con código 1 si algo falla)
// Los módulos importan _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { CATEGORIAS, categoria } = await import("../supabase/functions/_shared/alertas-vencimiento.ts");
const { ORIGEN } = await import("../supabase/functions/_shared/derivaciones.ts");
const { nivelAuto } = await import("../supabase/functions/_shared/semaforo.ts");
const { contextoAlertaGasto } = await import("../supabase/functions/_shared/tope-gasto.ts");
const { MEDIDAS_SEGURIDAD } = await import("../supabase/functions/_shared/agente-fijos.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const t = { tope: 2, aviso: 1 };
for (const nivel of ["aviso", "tope"] as const) {
  const alerta = { tipo: "otro", contexto: contextoAlertaGasto(nivel, nivel === "aviso" ? 1.2 : 2.1, t, "hola", "Bazar Farimar") };
  igual(`la alerta de ${nivel} cae en la categoría tope_gasto`, categoria(alerta), "tope_gasto");
}
igual("la categoría tiene nombre para el Panel", typeof CATEGORIAS.tope_gasto?.label === "string" && CATEGORIAS.tope_gasto.label.length > 0, true);
igual("la categoría tiene tiempo de respuesta en minutos", CATEGORIAS.tope_gasto?.min > 0, true);
igual("Derivaciones dice quién dispara el motivo", typeof ORIGEN.tope_gasto === "string" && ORIGEN.tope_gasto.length > 0, true);
igual("semáforo Auto: amarillo", nivelAuto("tope_gasto", {}, false), "amarillo");
igual("semáforo Auto: rojo si la alerta se marcó urgente", nivelAuto("tope_gasto", { urgente: true }, false), "rojo");
igual("no se confunde con el tope por hora", categoria({ tipo: "otro", contexto: { motivo: "tope_ia" } }), "tope_ia");

const medida = MEDIDAS_SEGURIDAD.find((m) => m.medida === "Tope de gasto global diario");
igual("la medida de seguridad figura como activa", medida?.estado, "activa");
igual("la medida dice los montos y que cuenta sólo clientes", /US\$ 2/.test(medida?.que_hace ?? "") && /US\$ 1/.test(medida?.que_hace ?? "") && /clientes/i.test(medida?.que_hace ?? ""), true);
igual("ya no queda como pendiente", MEDIDAS_SEGURIDAD.filter((m) => m.medida === "Tope de gasto global diario" && m.estado === "pendiente").length, 0);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
