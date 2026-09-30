// Genera el artifact "Plantillas de WhatsApp" (para el equipo, pedido de Pablo Olejavetzky 29/09).
//
//   node --experimental-strip-types scripts/plantillas-artifact/generar.mjs <datos.json> <salida.html>
//
// <datos.json> es la foto de Meta + uso que arma la consulta de LEEME.md: { generado, llave, plantillas[], uso{} }.
// Junta eso con disparadores.json (qué dispara cada una, a mano) y con el texto definido en el sistema
// (supabase/functions/_shared/plantillas-meta.ts) para marcar diferencias, y lo mete en pagina.html.
// Avisa por stderr lo que no cierra (plantilla de Meta sin disparador cargado, o al revés).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
const ejemplosDef = Object.fromEntries(PLANTILLAS.map((p) => [p.name, p.ejemplos]));

if (!Array.isArray(datos.plantillas) || !datos.plantillas.length) {
  console.error("datos.json sin plantillas: no genero nada (¿falló la consulta a Meta?)");
  process.exit(1);
}

const avisos = [];
// Versiones (app_settings.wa_plantillas_version, Pablo 30/09): pedido_recibido_v2 es la misma plantilla que
// pedido_recibido con otro nombre. Se documenta con el disparador de la base y se marca cuál se manda.
const versiones = datos.versiones ?? {};
const baseDe = (n) => versiones[n] ? n : (() => { const b = n.replace(/_v\d+$/, ""); return b !== n && (versiones[b] || disp.plantillas[b]) ? b : n; })();
const plantillas = datos.plantillas.map((t) => {
  const base = baseDe(t.name);
  const v = versiones[base];
  const activa = v?.activa ?? base;
  const version_rol = !v && base === t.name ? null : t.name === activa ? "activa" : t.name === v?.nueva ? "nueva" : "sin_uso";
  const d = disp.plantillas[t.name] ?? disp.plantillas[base];
  if (!d) avisos.push(`sin disparador cargado: ${t.name}`);
  const def = definido[t.name] ?? definido[base];
  // Si el sistema ya tiene un texto nuevo que Meta todavía no aprobó, el artifact muestra el nuevo (Pablo, 29/09).
  const pendiente = version_rol !== "sin_uso" && def !== undefined && def.trim() !== String(t.body ?? "").trim();
  return {
    ...t,
    body: pendiente ? def : t.body,
    ejemplos: pendiente ? ejemplosDef[t.name] : t.ejemplos,
    en_revision: pendiente,
    grupo: d?.grupo ?? "sin_clasificar",
    orden: d?.orden ?? 99,
    estado: d?.estado ?? "sin_clasificar",
    para: d?.para ?? "",
    sale: d?.sale ?? "Todavía no está documentado qué la dispara.",
    difiere: false,
    definido: def ?? null,
    uso: datos.uso?.[t.name] ?? null,
    version_rol, version_activa: activa,
  };
});
for (const n of Object.keys(disp.plantillas)) {
  if (!datos.plantillas.some((t) => t.name === n)) avisos.push(`documentada pero no está en Meta: ${n}`);
}

const grupos = [...disp.grupos];
if (plantillas.some((p) => p.grupo === "sin_clasificar")) {
  grupos.push({ id: "sin_clasificar", titulo: "Sin clasificar", bajada: "Están en Meta pero todavía no se documentó qué las manda." });
}

// Retro-simulación de los últimos 2 meses (foto, se recalcula a pedido: ver simulacion.json y LEEME.md).
const simPath = join(aca, "simulacion.json");
const simulacion = existsSync(simPath) ? JSON.parse(readFileSync(simPath, "utf8")) : null;

// "Cómo lo resolvemos": cómo se maneja cada causa de consulta (a mano, soluciones.json).
const solPath = join(aca, "soluciones.json");
const soluciones = existsSync(solPath) ? JSON.parse(readFileSync(solPath, "utf8")) : null;
for (const m of soluciones?.motivos ?? []) for (const pr of [...(m.previene ?? []), ...(m.relacionadas ?? [])]) {
  if (!datos.plantillas.some((t) => t.name === pr.tpl)) avisos.push(`soluciones.json nombra una plantilla que no está en Meta: ${pr.tpl}`);
}

const payload = { generado: datos.generado, llave: datos.llave, grupos, plantillas, simulacion, soluciones };
const html = readFileSync(join(aca, "pagina.html"), "utf8")
  .replace("/*__DATOS__*/null", JSON.stringify(payload).replace(/</g, "\\u003c"));
writeFileSync(salida, html);
console.error(`ok: ${plantillas.length} plantillas → ${salida}`);
for (const a of avisos) console.error("aviso: " + a);
