#!/usr/bin/env node
// cuadro.mjs — resumen DIARIO y SEMANAL del trabajo del repo en formato "cuadro sinóptico":
// SVG compacto, contenido 14 px, títulos 16 px, centrado H/V, ancho de columna según el dato,
// sin relleno ni color (negro sobre blanco, líneas finas).
//
// Fuente: reporte-dia.mjs --all (git, hora de Argentina). Sin red.
//
// Uso:
//   node scripts/reporte-diario/cuadro.mjs                 # día = hoy (ART), semana = últimos 7 días
//   node scripts/reporte-diario/cuadro.mjs --dia 2026-10-13
//   node scripts/reporte-diario/cuadro.mjs --out /ruta     # dónde deja los .svg (default: cwd)
//
// Deja dos archivos: cuadro-diario-<dia>.svg y cuadro-semanal-<dia>.svg

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TZ = "America/Argentina/Buenos_Aires";
const AQUI = dirname(fileURLToPath(import.meta.url));
const WD = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function arg(n) { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; }
const hoyART = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
function sumaDias(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}
function etiqueta(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WD[dt.getUTCDay()]} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

function leerDias() {
  const out = execFileSync("node", [join(AQUI, "reporte-dia.mjs"), "--all"],
    { env: { ...process.env, TZ }, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  return JSON.parse(out);
}

// ── SVG: tabla centrada, ancho de columna según el contenido ───────────────────
const CH14 = 7.7, CH16 = 9.2, PAD = 22, H = 30, HHEAD = 34, MT = 44;
const anchoTexto = (s, px) => String(s).length * (px === 16 ? CH16 : CH14);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function tablaSVG(titulo, headers, filas, filaTotal) {
  const cols = headers.length;
  const anchos = headers.map((h, c) => {
    let w = anchoTexto(h, 16);
    for (const f of filas) w = Math.max(w, anchoTexto(f[c], 14));
    if (filaTotal) w = Math.max(w, anchoTexto(filaTotal[c], 14));
    return Math.ceil(w + PAD);
  });
  const total = anchos.reduce((a, b) => a + b, 0);
  const xs = []; let acc = 0; for (const a of anchos) { xs.push(acc); acc += a; }
  const nFilas = filas.length + (filaTotal ? 1 : 0);
  const alto = MT + HHEAD + nFilas * H + 8;
  const L = []; // líneas svg
  L.push(`<rect x="0" y="0" width="${total}" height="${alto}" fill="#ffffff"/>`);
  L.push(`<text x="${total / 2}" y="26" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="700" text-anchor="middle">${esc(titulo)}</text>`);
  const y0 = MT;
  // header
  headers.forEach((h, c) => {
    L.push(`<text x="${xs[c] + anchos[c] / 2}" y="${y0 + HHEAD / 2}" font-family="Arial,Helvetica,sans-serif" font-size="16" font-weight="700" text-anchor="middle" dominant-baseline="middle">${esc(h)}</text>`);
  });
  // filas
  const todas = filaTotal ? [...filas, filaTotal] : filas;
  todas.forEach((f, r) => {
    const yy = y0 + HHEAD + r * H + H / 2;
    const bold = filaTotal && r === todas.length - 1 ? ' font-weight="700"' : "";
    f.forEach((cell, c) => {
      L.push(`<text x="${xs[c] + anchos[c] / 2}" y="${yy}" font-family="Arial,Helvetica,sans-serif" font-size="14"${bold} text-anchor="middle" dominant-baseline="middle">${esc(cell)}</text>`);
    });
  });
  // grid
  const yTop = y0, yBot = y0 + HHEAD + nFilas * H;
  for (let c = 0; c <= cols; c++) {
    const x = c === cols ? total : xs[c];
    L.push(`<line x1="${x}" y1="${yTop}" x2="${x}" y2="${yBot}" stroke="#000" stroke-width="1"/>`);
  }
  for (let r = 0; r <= nFilas + 1; r++) {
    const y = y0 + (r === 0 ? 0 : HHEAD + (r - 1) * H);
    L.push(`<line x1="0" y1="${y}" x2="${total}" y2="${y}" stroke="#000" stroke-width="${r <= 1 ? 1.4 : 1}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${alto}" viewBox="0 0 ${total} ${alto}" font-family="Arial,Helvetica,sans-serif">\n${L.join("\n")}\n</svg>\n`;
}

// ── armado ──────────────────────────────────────────────────────────────────
const dias = leerDias();
const porDia = new Map(dias.map((d) => [d.dia, d]));
const diaObjetivo = arg("--dia") || hoyART();
const outDir = arg("--out") || process.cwd();

// Auditoría (opcional): git no la trae. Se pasa un JSON { "YYYY-MM-DD": [abiertos, cerrados] }
// con --audit. Sin él, NO se muestra la columna/fila de auditoría (no se inventa 0/0).
const auditFile = arg("--audit");
const auditMap = auditFile ? JSON.parse(readFileSync(auditFile, "utf8")) : null;
const auditDe = (dia) => (auditMap && auditMap[dia] ? auditMap[dia] : null);

function areasOrden(areas) {
  return Object.entries(areas).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
}
const nombreArea = { funciones: "edge func", sql: "sql", docs: "docs", scripts: "scripts", otros: "otros" };

// DIARIO: cuadro Concepto | Detalle
const d = porDia.get(diaObjetivo);
let svgDiario;
if (!d) {
  svgDiario = tablaSVG(`Resumen diario · ${etiqueta(diaObjetivo)}/${diaObjetivo.slice(0, 4)}`,
    ["Concepto", "Detalle"], [["Actividad", "sin commits ese día"]]);
} else {
  const aut = d.autores.map((a) => `${a.nombre} ${a.n}`).join("  ·  ");
  const are = areasOrden(d.areas).map(([k, n]) => `${nombreArea[k]} ${n}`).join("  ·  ");
  const filasDia = [
    ["Commits", String(d.commits)],
    ["Autores", aut],
    ["Áreas (archivos)", are],
  ];
  const aud = auditDe(diaObjetivo);
  if (aud) filasDia.push(["Auditoría", `${aud[0]} abiertos  ·  ${aud[1]} cerrados`]);
  svgDiario = tablaSVG(`Resumen diario · ${etiqueta(diaObjetivo)}/${diaObjetivo.slice(0, 4)}`,
    ["Concepto", "Detalle"], filasDia);
}

// SEMANAL: últimos 7 días que terminan en diaObjetivo, una fila por día con actividad, orden por commits desc
const ventana = [];
for (let i = 6; i >= 0; i--) ventana.push(sumaDias(diaObjetivo, -i));
const activos = ventana.map((x) => porDia.get(x)).filter(Boolean).sort((a, b) => b.commits - a.commits);
const conAudit = !!auditMap;
const filasSem = activos.map((x) => {
  const top = x.autores[0] ? `${x.autores[0].nombre} ${x.autores[0].n}` : "—";
  const areTop = areasOrden(x.areas).slice(0, 2).map(([k]) => nombreArea[k]).join(", ") || "—";
  const base = [etiqueta(x.dia), String(x.commits), top, areTop];
  if (conAudit) { const a = auditDe(x.dia) || [0, 0]; base.push(`${a[0]}/${a[1]}`); }
  return base;
});
const totC = activos.reduce((s, x) => s + x.commits, 0);
const headSem = ["Día", "Commits", "Autor top", "Áreas"];
const filaTotal = [`${activos.length}/7 días`, String(totC), "", ""];
if (conAudit) {
  headSem.push("Aud. ab/ce");
  const tAb = activos.reduce((s, x) => s + (auditDe(x.dia)?.[0] || 0), 0);
  const tCe = activos.reduce((s, x) => s + (auditDe(x.dia)?.[1] || 0), 0);
  filaTotal.push(`${tAb}/${tCe}`);
}
const svgSemana = tablaSVG(
  `Resumen semanal · ${etiqueta(ventana[0])} a ${etiqueta(diaObjetivo)}`,
  headSem, filasSem, filaTotal);

const f1 = join(outDir, `cuadro-diario-${diaObjetivo}.svg`);
const f2 = join(outDir, `cuadro-semanal-${diaObjetivo}.svg`);
writeFileSync(f1, svgDiario);
writeFileSync(f2, svgSemana);
console.log(f1);
console.log(f2);
