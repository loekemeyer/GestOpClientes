#!/usr/bin/env node
// reporte-dia.mjs — datos de trabajo (git) por día, para el "Reporte diario de trabajo".
//
// Fuente: git log del repo (fechas en hora de Argentina, sin red). Lo que NO sale de git
// (problemas de auditoría de github_repo_problemas) lo agrega la sesión que arma el reporte
// vía el MCP de Supabase y lo mezcla por `dia`.
//
// Uso:
//   node scripts/reporte-diario/reporte-dia.mjs --dia 2026-10-13   # un día
//   node scripts/reporte-diario/reporte-dia.mjs --ayer             # el día de ayer (ART)
//   node scripts/reporte-diario/reporte-dia.mjs --all              # todos los días con actividad
//
// Salida: JSON. Con --all es un array de días (viejo → nuevo); con --dia/--ayer, un solo objeto.
// Cada día: { dia, commits, autores:[{nombre,n}], areas:{sql,funciones,docs,scripts,otros}, asuntos:[...] }
//
// Ojo: necesita el historial completo. Si el checkout es shallow:  git fetch --unshallow

import { execFileSync } from "node:child_process";

const TZ = "America/Argentina/Buenos_Aires";
const US = "\x1f"; // separador de campos
const RS = "\x1e"; // separador de registros

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? true);
}
function hoyART() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}
function ayerART() {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

// Un solo git log con --name-only. Cada commit arranca con una línea centinela "@@@" que no
// puede ser un nombre de archivo; las demás líneas no vacías son archivos. El autor sale del
// trailer Hecho-por con el placeholder de git (sin parsear el body a mano, que metía los
// trailers entre los archivos). Fecha del autor en ART (format-local + TZ en el env).
const SENT = "@@@";
function leerGit() {
  const fmt = `${SENT}%ad${US}%an${US}%(trailers:key=Hecho-por,valueonly,separator=%x2c)${US}%s`;
  const out = execFileSync(
    "git",
    ["log", "--date=format-local:%Y-%m-%d", `--pretty=format:${fmt}`, "--name-only"],
    { cwd: process.cwd(), env: { ...process.env, TZ }, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
  );
  return out;
}

// "Pablo Olejavetzky (employee_id 64)" → "Pablo Olejavetzky". Si no hay trailer, autor de git.
function limpiarAutor(trailer, gitAuthor) {
  const t = (trailer ?? "").split(",")[0].trim(); // primer Hecho-por si hubiera varios
  if (!t) return gitAuthor;
  return t.replace(/\s*\(employee_id[^)]*\)\s*/i, "").trim() || gitAuthor;
}
function areaDe(path) {
  if (path.startsWith("sql/")) return "sql";
  if (path.startsWith("supabase/functions/")) return "funciones";
  if (path.startsWith("docs/")) return "docs";
  if (path.startsWith("scripts/")) return "scripts";
  return "otros";
}

function parsear(raw) {
  const dias = new Map(); // dia → acumulador
  const lineas = raw.split("\n");
  let acc = null;       // día actual
  let vistos = null;    // archivos ya contados en el commit actual
  for (const ln of lineas) {
    if (ln.startsWith(SENT)) {
      const partes = ln.slice(SENT.length).split(US);
      const dia = partes[0];
      const gitAuthor = partes[1] ?? "";
      const trailer = partes[2] ?? "";
      const asunto = partes[3] ?? "";
      if (!dia) { acc = null; continue; }
      if (!dias.has(dia)) {
        dias.set(dia, { dia, commits: 0, autores: new Map(), areas: { sql: 0, funciones: 0, docs: 0, scripts: 0, otros: 0 }, asuntos: [] });
      }
      acc = dias.get(dia);
      acc.commits++;
      const autor = limpiarAutor(trailer, gitAuthor);
      acc.autores.set(autor, (acc.autores.get(autor) ?? 0) + 1);
      if (acc.asuntos.length < 60) acc.asuntos.push(asunto);
      vistos = new Set();
    } else {
      const f = ln.trim();
      if (!acc || f === "") continue;
      if (!vistos.has(f)) { acc.areas[areaDe(f)]++; vistos.add(f); }
    }
  }
  // normalizar
  const res = [];
  for (const acc of dias.values()) {
    const autores = [...acc.autores.entries()].map(([nombre, n]) => ({ nombre, n })).sort((a, b) => b.n - a.n);
    res.push({ dia: acc.dia, commits: acc.commits, autores, areas: acc.areas, asuntos: acc.asuntos });
  }
  res.sort((a, b) => a.dia.localeCompare(b.dia));
  return res;
}

const todos = parsear(leerGit());
const quieroAll = arg("--all");
let diaPedido = null;
if (arg("--ayer")) diaPedido = ayerART();
else if (arg("--hoy")) diaPedido = hoyART();
else if (arg("--dia")) diaPedido = String(arg("--dia"));

if (quieroAll) {
  process.stdout.write(JSON.stringify(todos, null, 2) + "\n");
} else {
  const d = diaPedido ?? ayerART();
  const found = todos.find((x) => x.dia === d) ?? { dia: d, commits: 0, autores: [], areas: { sql: 0, funciones: 0, docs: 0, scripts: 0, otros: 0 }, asuntos: [] };
  process.stdout.write(JSON.stringify(found, null, 2) + "\n");
}
