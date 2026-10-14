// Pruebas del corte de historial por cuenta (supabase/functions/_shared/ventana-historial.ts › filtrarDesde).
// Un número reasignado de un cliente a otro no arrastra la charla del dueño anterior al contexto del cliente nuevo.
// Sin red, sin IA. Correr: deno run tests/ventana-cuenta.test.ts   (sale con código 1 si algo falla)
import { type Fila, filtrarDesde } from "../supabase/functions/_shared/ventana-historial.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const f = (rol: string, contenido: string, creado_en: string): Fila => ({ rol, contenido, creado_en });

// Caso Cuccinarte: junio (dueño anterior) + hoy (dueño actual). El vínculo arrancó el 14/10 12:55.
const historial: Fila[] = [
  f("assistant", "Buenas tardes, Cuccinarte S.R.L.", "2026-06-05T17:32:18Z"),
  f("user", "hola", "2026-06-05T19:54:40Z"),
  f("assistant", "Hola Garbarino Franco Tomas", "2026-10-14T15:39:00Z"),
  f("user", "no soy garbarino, soy carrefour", "2026-10-14T15:39:37Z"),
];
const desde = "2026-10-14T12:55:17Z";

igual("recorta la charla del dueño anterior (junio)",
  filtrarDesde(historial, desde).map((x) => x.contenido),
  ["Hola Garbarino Franco Tomas", "no soy garbarino, soy carrefour"]);

igual("desde null = no recorta nada", filtrarDesde(historial, null).length, historial.length);
igual("desde ilegible = no recorta nada", filtrarDesde(historial, "no-es-fecha").length, historial.length);

igual("mantiene el orden de entrada",
  filtrarDesde(historial, desde).map((x) => x.creado_en),
  ["2026-10-14T15:39:00Z", "2026-10-14T15:39:37Z"]);

// El borde incluye al mensaje que cae exactamente en `desde` (>=, no >).
const borde = [f("user", "justo", "2026-10-14T12:55:17Z"), f("user", "un ms antes", "2026-10-14T12:55:16Z")];
igual("el límite es inclusivo (>=)", filtrarDesde(borde, desde).map((x) => x.contenido), ["justo"]);

// Una fila con fecha ilegible no se descarta (el corte no la inventó).
const conMala = [f("user", "sin fecha", "xxx"), f("user", "vieja", "2026-01-01T00:00:00Z")];
igual("fecha ilegible se conserva, la vieja se corta", filtrarDesde(conMala, desde).map((x) => x.contenido), ["sin fecha"]);

igual("todo anterior a desde = vacío", filtrarDesde([f("user", "vieja", "2026-06-01T00:00:00Z")], desde), []);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
