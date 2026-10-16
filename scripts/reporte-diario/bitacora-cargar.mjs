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
// Nota: NO escribe `resumen` (el texto en lenguaje simple lo hacía el LLM, que acá no está).
// En un alta nueva `resumen` queda NULL y el modal del dashboard muestra áreas, autores y
// asuntos. En un re-upsert del mismo día NO se pisa el `resumen` que ya hubiera (ON CONFLICT
// no lo toca), así que un resumen cargado a mano se conserva.

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

// 4) UPSERT. Dollar-quoting con un tag improbable y sin ';' en los asuntos (el MCP de Supabase
//    se cuelga con un ';' dentro de un literal; la Management API no tiene ese bug, pero se
//    mantiene la higiene por las dudas y para que el SQL sea idéntico al de la carga manual).
const noSemi = (s) => String(s).replace(/;/g, ",");
const asuntos = j.asuntos.map(noSemi);
const jq = (o) => `$bit$${JSON.stringify(o)}$bit$::jsonb`;
const sql =
  `insert into public.bitacora_dias (dia, commits, autores, areas, asuntos, audit, fuente, updated_at)
   values ('${dia}', ${j.commits}, ${jq(j.autores)}, ${jq(j.areas)}, ${jq(asuntos)}, ${jq({ abiertos, cerrados })}, 'routine', now())
   on conflict (dia) do update set commits=excluded.commits, autores=excluded.autores, areas=excluded.areas, asuntos=excluded.asuntos, audit=excluded.audit, fuente='routine', updated_at=now()`;
await q(LK, sql, false);

// 5) verificación
const chk = await q(LK, `select dia, commits, fuente from public.bitacora_dias where dia='${dia}'`, true);
console.log(
  `cargado ${JSON.stringify(chk?.[0] ?? null)} | autores ${j.autores.map((a) => a.nombre + ":" + a.n).join(", ")} | auditoría ${abiertos}/${cerrados}`,
);
