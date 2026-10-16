#!/usr/bin/env node
// bitacora-cargar.mjs — carga la bitácora de un día en public.bitacora_dias de PaginaLK.
//
// Pensado para correr en GitHub Actions (.github/workflows/bitacora-diaria.yml): ahí el repo
// ya está clonado, así que el git log es nativo (no lo frena ningún clasificador como pasaba en
// la sesión de Claude), y escribe por la Management API de Supabase
// (POST /v1/projects/{ref}/database/query) autenticada con SUPABASE_ACCESS_TOKEN — el MISMO
// secreto que ya usa el deploy. No usa claves anon/service ni ningún secreto nuevo.
//
// El mismo token alcanza las dos bases: PaginaLK (kwkclwhmoygunqmlegrg) para escribir la
// bitácora, y Gestión Virgilio (hrxfctzncixxqmpfhskv) para contar los problemas de auditoría
// del día.
//
// Uso:  node scripts/reporte-diario/bitacora-cargar.mjs [--dia YYYY-MM-DD]
//   sin --dia: usa el día de AYER en hora de Argentina.
// Requiere la variable de entorno SUPABASE_ACCESS_TOKEN.
//
// El `resumen` en lenguaje simple (la lista de viñetas que se ve arriba en el modal del día) lo
// arma la edge function lk_bitacora-resumen con Haiku 5.5 (decisión de Pablo, 16/10): la key de
// Anthropic es un secreto de las Edge Functions, así que el resumen se pide a esa edge (que sí la
// tiene) en vez de llamar al modelo desde el runner. La edge se protege con el header
// x-bitacora-secret (valor en app_settings, key 'bitacora_sync_secret'), que se lee con el token.
// Si la edge falla, el día se carga igual SIN resumen (el modal muestra áreas, autores y asuntos)
// y no se pisa un resumen que ya estuviera cargado.

import { execFileSync } from "node:child_process";

const LK = "kwkclwhmoygunqmlegrg"; // PaginaLK — tabla bitacora_dias
const GV = "hrxfctzncixxqmpfhskv"; // Gestión Virgilio — auditoría github_repo_problemas
const REPO_ID = 190;               // loekemeyer/gestopclientes en github_repo_problemas.repos
const TZ = "America/Argentina/Buenos_Aires";

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("Falta SUPABASE_ACCESS_TOKEN");
  process.exit(1);
}

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? null : process.argv[i + 1];
};
const dia = arg("--dia") ||
  new Date(Date.now() - 864e5).toLocaleDateString("en-CA", { timeZone: TZ });

async function q(ref, query, read_only = false) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, read_only }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Management API ${ref} ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : [];
}

const sqlLit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Resumen en lenguaje simple con Haiku, vía la edge lk_bitacora-resumen (tiene la key de
// Anthropic en su entorno). Devuelve el texto (viñetas) o null si no se pudo.
async function resumenSimple(areas, asuntos) {
  let secret;
  try {
    const sr = await q(LK, "select value from public.app_settings where key = 'bitacora_sync_secret'", true);
    secret = sr?.[0]?.value;
  } catch (e) {
    console.warn("resumen: no se pudo leer el secreto:", e.message);
    return null;
  }
  if (!secret) {
    console.warn("resumen: falta bitacora_sync_secret");
    return null;
  }
  try {
    const r = await fetch(`https://${LK}.supabase.co/functions/v1/lk_bitacora-resumen`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bitacora-secret": secret },
      body: JSON.stringify({ areas, asuntos }),
    });
    if (!r.ok) {
      console.warn(`resumen: la edge respondió ${r.status}: ${await r.text()}`);
      return null;
    }
    const data = await r.json();
    if (data?.resumen && typeof data.resumen === "string") {
      console.log(`resumen: generado con ${data.modelo ?? "haiku"}`);
      return data.resumen;
    }
    console.warn("resumen: la edge no devolvió resumen");
    return null;
  } catch (e) {
    console.warn("resumen: la edge falló:", e.message);
    return null;
  }
}

// 1) git log del día (reusa el script canónico)
const j = JSON.parse(
  execFileSync("node", ["scripts/reporte-diario/reporte-dia.mjs", "--dia", dia], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }),
);

// 2) auditoría del día (otra base, mismo token)
const aud = await q(
  GV,
  `select
     (select count(*) from github_repo_problemas.problemas where repo_id=${REPO_ID} and to_char(detectado_en at time zone '${TZ}','YYYY-MM-DD')='${dia}') abiertos,
     (select count(*) from github_repo_problemas.problemas where repo_id=${REPO_ID} and corregido_en is not null and to_char(corregido_en at time zone '${TZ}','YYYY-MM-DD')='${dia}') cerrados`,
  true,
);
const abiertos = Number(aud?.[0]?.abiertos ?? 0);
const cerrados = Number(aud?.[0]?.cerrados ?? 0);

// 3) día sin actividad: no se escribe nada
if (j.commits === 0 && abiertos === 0 && cerrados === 0) {
  console.log(`día sin actividad: ${dia}`);
  process.exit(0);
}

// 4) resumen en lenguaje simple (Gemini gratis). Puede ser null.
const asuntos = j.asuntos.map((s) => String(s).replace(/;/g, ","));
const resumen = await resumenSimple(j.areas, asuntos);

// 5) UPSERT. Dollar-quoting con tag improbable. El `resumen` se incluye SÓLO si se generó: así,
//    si Gemini falló, no se pisa un resumen que ya hubiera cargado y el alta nueva queda en NULL.
const jq = (o) => `$bit$${JSON.stringify(o)}$bit$::jsonb`;
const cols = ["dia", "commits", "autores", "areas", "asuntos", "audit", "fuente", "updated_at"];
const vals = [
  sqlLit(dia), String(j.commits), jq(j.autores), jq(j.areas), jq(asuntos),
  jq({ abiertos, cerrados }), "'routine'", "now()",
];
const sets = [
  "commits=excluded.commits", "autores=excluded.autores", "areas=excluded.areas",
  "asuntos=excluded.asuntos", "audit=excluded.audit", "fuente='routine'", "updated_at=now()",
];
if (resumen) {
  cols.splice(6, 0, "resumen"); // antes de fuente
  vals.splice(6, 0, `$res$${resumen}$res$`);
  sets.push("resumen=excluded.resumen");
}
const sql =
  `insert into public.bitacora_dias (${cols.join(", ")})
   values (${vals.join(", ")})
   on conflict (dia) do update set ${sets.join(", ")}`;
await q(LK, sql, false);

// 6) verificación
const chk = await q(LK, `select dia, commits, fuente, (resumen is not null) tiene_resumen from public.bitacora_dias where dia='${dia}'`, true);
console.log(
  `cargado ${JSON.stringify(chk?.[0] ?? null)} | autores ${j.autores.map((a) => a.nombre + ":" + a.n).join(", ")} | auditoría ${abiertos}/${cerrados} | resumen ${resumen ? "sí" : "no"}`,
);
