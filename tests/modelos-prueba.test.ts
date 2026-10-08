// Pruebas de la lista de modelos de prueba (supabase/functions/_shared/modelos-prueba.ts). Sin red, sin IA.
// Correr: deno run tests/modelos-prueba.test.ts   (sale con código 1 si algo falla)
import { idModeloPrueba, listaModelosPrueba, MAX_MODELOS_PRUEBA } from "../supabase/functions/_shared/modelos-prueba.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

igual("un solo modelo (como hasta el 08/10)", listaModelosPrueba("gemini-3.5-flash-lite"), ["gemini-3.5-flash-lite"]);
igual("varios, en orden", listaModelosPrueba("gemini-3.5-flash-lite,mistral-small-latest"), ["gemini-3.5-flash-lite", "mistral-small-latest"]);
igual("con espacios y comas de más", listaModelosPrueba(" gemini-3.5-flash-lite , ,mistral-small-latest, "), ["gemini-3.5-flash-lite", "mistral-small-latest"]);
igual("repetido: una vez", listaModelosPrueba("a,b,a"), ["a", "b"]);
igual("sin clave o vacía: ninguno (la prueba usa la cadena, como antes)", [listaModelosPrueba(null), listaModelosPrueba(undefined), listaModelosPrueba("  ")], [[], [], []]);
igual(`a lo sumo ${MAX_MODELOS_PRUEBA}`, listaModelosPrueba("a,b,c,d,e,f,g").length, MAX_MODELOS_PRUEBA);

const ids = Array.from({ length: MAX_MODELOS_PRUEBA }, (_, i) => idModeloPrueba(i));
igual("el primero sigue siendo -1", ids[0], -1);
igual("todos negativos (markModelDown no los marca caídos)", ids.every((i) => i < 0), true);
igual("todos distintos (el loop saltea por id el que falló)", new Set(ids).size, ids.length);
igual("ninguno es -2 (reintento del modelo fijo de pedidos) ni 0 (respaldo del env)", ids.includes(-2) || ids.includes(0), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
