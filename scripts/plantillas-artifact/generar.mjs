// Genera el artifact "Plantillas de WhatsApp" (para el equipo, pedido de Pablo Olejavetzky 29/09).
//
//   node --experimental-strip-types scripts/plantillas-artifact/generar.mjs <datos.json> <salida.html>
//
// <datos.json> es la foto de Meta + uso que arma la consulta de LEEME.md: { generado, llave, plantillas[], uso{} }.
// Junta eso con disparadores.json (qué dispara cada una, a mano) y con el texto definido en el sistema
// (supabase/functions/_shared/plantillas-meta.ts) para marcar diferencias, y lo mete en pagina.html.
// Avisa por stderr lo que no cierra (plantilla de Meta sin disparador cargado, o al revés).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const aca = dirname(fileURLToPath(import.meta.url));
const [, , entrada, salida] = process.argv;
if (!entrada || !salida) {
  console.error("uso: node --experimental-strip-types generar.mjs <datos.json> <salida.html>");
  process.exit(2);
}

const datos = JSON.parse(readFileSync(entrada, "utf8"));
const disp = JSON.parse(readFileSync(join(aca, "disparadores.json"), "utf8"));
const { PLANTILLAS } = await import(join(aca, "../../supabase/functions/_shared/plantillas-meta.ts"));
const definido = Object.fromEntries(PLANTILLAS.map((p) => [p.name, p.body]));

if (!Array.isArray(datos.plantillas) || !datos.plantillas.length) {
  console.error("datos.json sin plantillas: no genero nada (¿falló la consulta a Meta?)");
  process.exit(1);
}

const avisos = [];
const plantillas = datos.plantillas.map((t) => {
  const d = disp.plantillas[t.name];
  if (!d) avisos.push(`sin disparador cargado: ${t.name}`);
  const def = definido[t.name];
  return {
    ...t,
    grupo: d?.grupo ?? "sin_clasificar",
    orden: d?.orden ?? 99,
    estado: d?.estado ?? "sin_clasificar",
    para: d?.para ?? "",
    sale: d?.sale ?? "Todavía no está documentado qué la dispara.",
    difiere: def !== undefined && def.trim() !== String(t.body ?? "").trim(),
    definido: def ?? null,
    uso: datos.uso?.[t.name] ?? null,
  };
});
for (const n of Object.keys(disp.plantillas)) {
  if (!datos.plantillas.some((t) => t.name === n)) avisos.push(`documentada pero no está en Meta: ${n}`);
}

const grupos = [...disp.grupos];
if (plantillas.some((p) => p.grupo === "sin_clasificar")) {
  grupos.push({ id: "sin_clasificar", titulo: "Sin clasificar", bajada: "Están en Meta pero todavía no se documentó qué las manda." });
}

const payload = { generado: datos.generado, llave: datos.llave, grupos, plantillas };
const html = readFileSync(join(aca, "pagina.html"), "utf8")
  .replace("/*__DATOS__*/null", JSON.stringify(payload).replace(/</g, "\\u003c"));
writeFileSync(salida, html);
console.error(`ok: ${plantillas.length} plantillas → ${salida}`);
for (const a of avisos) console.error("aviso: " + a);
