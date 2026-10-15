// Pruebas puras del tope de gasto por cliente (_shared/tope-cliente.ts). Sin red, sin IA, sin base.
// Correr: deno run --allow-env --allow-read tests/tope-cliente.test.ts   (sale con código 1 si algo falla)
import {
  contextoAlertaCliente, inicioSemanaArgentina, MSG_TOPE_CLIENTE, nivelClienteGasto, TOPE_CLIENTE_DIA_USD_DEFAULT, TOPE_CLIENTE_SEMANA_USD_DEFAULT, topesClienteDeSettings,
} from "../supabase/functions/_shared/tope-cliente.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// --- inicio de la semana de Argentina (lunes 00:00 ART = 03:00 UTC del lunes) ---
// Miércoles 14/10/2026 12:00 ART (15:00 UTC): la semana arrancó el lunes 12/10 00:00 ART = 12/10 03:00 UTC.
igual("semana ART arranca el lunes 03:00 UTC", new Date(inicioSemanaArgentina(Date.parse("2026-10-14T15:00:00Z"))).toISOString(), "2026-10-12T03:00:00.000Z");
// Lunes 12/10 a las 00:30 ART (03:30 UTC) ya es de esta semana; el inicio es el mismo lunes 03:00 UTC.
igual("el lunes temprano ya es de esta semana", new Date(inicioSemanaArgentina(Date.parse("2026-10-12T03:30:00Z"))).toISOString(), "2026-10-12T03:00:00.000Z");
// Domingo 11/10 a las 23:00 ART (12/10 02:00 UTC) todavía es la semana anterior: arranca el lunes 05/10.
igual("el domingo a la noche ART es la semana anterior", new Date(inicioSemanaArgentina(Date.parse("2026-10-12T02:00:00Z"))).toISOString(), "2026-10-05T03:00:00.000Z");

// --- topes desde settings ---
igual("topes por defecto", topesClienteDeSettings(null, null), { dia: TOPE_CLIENTE_DIA_USD_DEFAULT, semana: TOPE_CLIENTE_SEMANA_USD_DEFAULT });
igual("topes con coma decimal", topesClienteDeSettings("2,5", "7,5"), { dia: 2.5, semana: 7.5 });
igual("0 apaga un tope (válido)", topesClienteDeSettings("0", "5"), { dia: 0, semana: 5 });
igual("basura vuelve al defecto", topesClienteDeSettings("x", ""), { dia: TOPE_CLIENTE_DIA_USD_DEFAULT, semana: TOPE_CLIENTE_SEMANA_USD_DEFAULT });

// --- nivel por cliente ---
const t = { dia: 2, semana: 5 };
igual("por debajo de los dos: ok", nivelClienteGasto(1, 3, t), { nivel: "ok", limite: null });
igual("justo en el tope diario corta", nivelClienteGasto(2, 2, t), { nivel: "tope", limite: "dia" });
igual("el semanal corta aunque el diario no", nivelClienteGasto(0.5, 5, t), { nivel: "tope", limite: "semana" });
igual("si cruza los dos, se reporta semana", nivelClienteGasto(2, 5, t), { nivel: "tope", limite: "semana" });
igual("diario en 0 no corta por día", nivelClienteGasto(9, 1, { dia: 0, semana: 5 }), { nivel: "ok", limite: null });
igual("los dos en 0: nunca corta", nivelClienteGasto(99, 99, { dia: 0, semana: 0 }), { nivel: "ok", limite: null });

// --- contexto de la alerta ---
const ctxSem = contextoAlertaCliente("semana", 2, 6, t, "hola", "Bazar Farimar") as Record<string, unknown>;
igual("la alerta reusa el motivo tope_gasto", ctxSem.motivo, "tope_gasto");
igual("nivel cliente (no se confunde con el global aviso/tope ni con presupuesto)", ctxSem.nivel, "cliente");
igual("lleva el límite que saltó", ctxSem.limite, "semana");
igual("guarda la razón social para el Panel", ctxSem.razon_social, "Bazar Farimar");
igual("el detalle es texto no vacío", typeof ctxSem.detalle === "string" && (ctxSem.detalle as string).length > 0, true);

// ── Problema 812 (15/10): pasoElTopeCliente mandaba MSG_TOPE_GASTO, que el commit f13fd4d había borrado: ReferenceError atrapado, el cliente sin aviso ──
igual("el aviso del tope por cliente es el texto de siempre y no lleva montos",
  [MSG_TOPE_CLIENTE, /\d|\$|US/.test(MSG_TOPE_CLIENTE)],
  ["En este momento no podemos responder tu consulta de forma automática. Ya le avisamos a una persona del equipo para que te escriba en cuanto pueda.", false]);
const webhookUrl = new URL("../supabase/functions/lk_whatsapp-webhook/index.ts", import.meta.url);
const webhook = Deno.readTextFileSync(webhookUrl);
igual("el webhook importa MSG_TOPE_CLIENTE y lo manda y lo guarda", [
  /import \{[^}]*\bMSG_TOPE_CLIENTE\b[^}]*\} from "\.\.\/_shared\/tope-cliente\.ts";/.test(webhook),
  webhook.includes("await enviarTexto(cfg, phone, MSG_TOPE_CLIENTE);"), webhook.includes('await saveMessage(phone, "assistant", MSG_TOPE_CLIENTE);'),
], [true, true, true]);
igual("el webhook ya no nombra MSG_TOPE_GASTO (se borró en f13fd4d)", webhook.includes("MSG_TOPE_GASTO"), false);
// Guarda general (sin permiso de ejecutar procesos: el CI corre cada prueba sin --allow-run): todo `MSG_*` que usa el webhook tiene que
// estar definido en él o exportado por algún _shared/*.ts. Es lo que habría atrapado el bug: la constante estaba borrada y nada lo revisaba.
const sharedDir = new URL("../supabase/functions/_shared/", import.meta.url);
let definidos = webhook;
for (const e of Deno.readDirSync(sharedDir)) if (e.isFile && e.name.endsWith(".ts")) definidos += "\n" + Deno.readTextFileSync(new URL(e.name, sharedDir));
const usados = [...new Set(webhook.match(/\bMSG_[A-Z0-9_]+\b/g) ?? [])];
const sinDefinir = usados.filter((n) => !new RegExp(`\\b(?:const|let|var|function)\\s+${n}\\b`).test(definidos));
igual("el webhook no usa constantes MSG_* sin definir", sinDefinir, []);
igual("la guarda mira constantes MSG_* de verdad (el webhook usa al menos una)", usados.length > 0, true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
