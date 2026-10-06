// Que el motivo `tope_ia` quede registrado donde el resto del sistema lo busca (categoría, origen en Derivaciones y semáforo).
// Sin red. Correr: deno run --allow-env tests/tope-ia-alerta.test.ts   (sale con código 1 si algo falla)
// Los módulos importan _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { CATEGORIAS, categoria } = await import("../supabase/functions/_shared/alertas-vencimiento.ts");
const { ORIGEN } = await import("../supabase/functions/_shared/derivaciones.ts");
const { nivelAuto } = await import("../supabase/functions/_shared/semaforo.ts");
const { contextoAlertaTope } = await import("../supabase/functions/_shared/tope-ia.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const alerta = { tipo: "otro", contexto: contextoAlertaTope(20, "hola", "Bazar Farimar", new Date("2026-10-06T17:15:00Z")) };
igual("la alerta del tope cae en la categoría tope_ia", categoria(alerta), "tope_ia");
igual("la categoría tiene nombre para el Panel", typeof CATEGORIAS.tope_ia?.label === "string" && CATEGORIAS.tope_ia.label.length > 0, true);
igual("la categoría tiene tiempo de respuesta en minutos", CATEGORIAS.tope_ia?.min > 0, true);
igual("Derivaciones dice quién dispara el motivo", typeof ORIGEN.tope_ia === "string" && ORIGEN.tope_ia.length > 0, true);
igual("semáforo Auto: amarillo", nivelAuto("tope_ia", {}, false), "amarillo");
igual("semáforo Auto: rojo si la alerta se marcó urgente", nivelAuto("tope_ia", { urgente: true }, false), "rojo");
igual("las alertas viejas sin motivo no se confunden con tope_ia", categoria({ tipo: "otro", contexto: {} }) === "tope_ia", false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
