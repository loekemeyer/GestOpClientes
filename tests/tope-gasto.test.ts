// Pruebas del tope de gasto global diario de IA (supabase/functions/_shared/tope-gasto.ts). Sin red, sin IA, gasto US$ 0.
// Correr: deno run tests/tope-gasto.test.ts   (sale con código 1 si algo falla)
//         o node --experimental-strip-types tests/tope-gasto.test.ts
import {
  AVISO_GASTO_USD_DEFAULT, contextoAlertaGasto, FUNCION_CLIENTES, inicioDiaArgentina, nivelDeGasto, sumarGasto,
  TOPE_ESCALAR_USD_DEFAULT, TOPE_GASTO_USD_DEFAULT, topesDeSettings,
} from "../supabase/functions/_shared/tope-gasto.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const iso = (ms: number) => new Date(ms).toISOString();

// ── Lo acordado con Pablo (07/10): US$ 2 de tope, aviso a US$ 1, sólo clientes. Escalón de escalar US$ 3 (14/10). ──
igual("tope por defecto: US$ 2", TOPE_GASTO_USD_DEFAULT, 2);
igual("aviso por defecto: US$ 1", AVISO_GASTO_USD_DEFAULT, 1);
igual("escalar por defecto: US$ 3", TOPE_ESCALAR_USD_DEFAULT, 3);
igual("sólo cuenta lo que gastan los clientes (el webhook)", FUNCION_CLIENTES, "lk_whatsapp-webhook");

// ── El día es el de Argentina: empieza a las 03:00 UTC ──
igual("las 03:00 UTC son el inicio del día", iso(inicioDiaArgentina(Date.parse("2026-10-07T03:00:00Z"))), "2026-10-07T03:00:00.000Z");
igual("un minuto antes todavía es el día anterior", iso(inicioDiaArgentina(Date.parse("2026-10-07T02:59:59Z"))), "2026-10-06T03:00:00.000Z");
igual("la 01:00 UTC son las 22:00 del día anterior en Argentina", iso(inicioDiaArgentina(Date.parse("2026-10-07T01:00:00Z"))), "2026-10-06T03:00:00.000Z");
igual("mediodía de Argentina (15:00 UTC)", iso(inicioDiaArgentina(Date.parse("2026-10-07T15:00:00Z"))), "2026-10-07T03:00:00.000Z");
igual("23:59 de Argentina (02:59 UTC del día siguiente)", iso(inicioDiaArgentina(Date.parse("2026-10-08T02:59:59Z"))), "2026-10-07T03:00:00.000Z");
igual("cambio de mes: 00:30 ART del 1/11", iso(inicioDiaArgentina(Date.parse("2026-11-01T03:30:00Z"))), "2026-11-01T03:00:00.000Z");
igual("cambio de año: 22:00 ART del 31/12", iso(inicioDiaArgentina(Date.parse("2027-01-01T01:00:00Z"))), "2026-12-31T03:00:00.000Z");

// ── Montos de app_settings ──
igual("sin nada guardado: 2, 1 y 3", topesDeSettings(null, undefined), { tope: 2, aviso: 1, escalar: 3 });
igual("vacío o sólo espacios: los de siempre", topesDeSettings("", "  ", ""), { tope: 2, aviso: 1, escalar: 3 });
igual("enteros guardados", topesDeSettings("3", "1", "5"), { tope: 3, aviso: 1, escalar: 5 });
igual("decimal con punto", topesDeSettings("2.5", "0.75", "4.5"), { tope: 2.5, aviso: 0.75, escalar: 4.5 });
igual("decimal con coma", topesDeSettings("2,5", "1,25", "3,5"), { tope: 2.5, aviso: 1.25, escalar: 3.5 });
igual("0 es válido y apaga", topesDeSettings("0", "0", "0"), { tope: 0, aviso: 0, escalar: 0 });
igual("texto que no es número: los de siempre", topesDeSettings("mucho", "poco", "bocha"), { tope: 2, aviso: 1, escalar: 3 });
igual("negativo: los de siempre", topesDeSettings("-5", "-1", "-2"), { tope: 2, aviso: 1, escalar: 3 });
igual("se pueden cambiar uno sin el otro", topesDeSettings("4", null), { tope: 4, aviso: 1, escalar: 3 });
igual("escalar omitido: el defecto (3)", topesDeSettings("2", "1"), { tope: 2, aviso: 1, escalar: 3 });

// ── Suma del gasto ──
igual("suma lo que llega como texto (numeric de PostgREST)", Math.round(sumarGasto([{ estimated_cost_usd: "0.1939" }, { estimated_cost_usd: "0.0106" }, { estimated_cost_usd: 1 }]) * 10000) / 10000, 1.2045);
igual("sin filas: 0", sumarGasto([]), 0);
igual("lo que no es número, vacío o negativo cuenta 0", sumarGasto([{ estimated_cost_usd: null }, { estimated_cost_usd: "x" }, {}, null, undefined, { estimated_cost_usd: -3 }]), 0);

// ── Niveles (14/10: de tope en adelante se DEGRADA, nunca se corta; en escalar sólo se agrega una alerta) ──
const t = { tope: 2, aviso: 1, escalar: 3 };
igual("0,99: ok", nivelDeGasto(0.99, t), "ok");
igual("1,00: aviso", nivelDeGasto(1, t), "aviso");
igual("1,99: todavía aviso", nivelDeGasto(1.99, t), "aviso");
igual("2,00: degradar", nivelDeGasto(2, t), "degradar");
igual("2,99: todavía degradar", nivelDeGasto(2.99, t), "degradar");
igual("3,00: escalar (alerta en horario, no corta)", nivelDeGasto(3, t), "escalar");
igual("5,00: escalar", nivelDeGasto(5, t), "escalar");
igual("gasto 0: ok", nivelDeGasto(0, t), "ok");
igual("tope en 0 apaga todo, aunque el gasto sea enorme", nivelDeGasto(50, { tope: 0, aviso: 1, escalar: 3 }), "ok");
igual("aviso en 0 apaga sólo el aviso", nivelDeGasto(1.5, { tope: 2, aviso: 0, escalar: 3 }), "ok");
igual("aviso en 0 no apaga el degradar", nivelDeGasto(2.5, { tope: 2, aviso: 0, escalar: 3 }), "degradar");
igual("escalar en 0: nunca escala, sólo degrada", nivelDeGasto(50, { tope: 2, aviso: 1, escalar: 0 }), "degradar");
igual("escalar menor que el tope: el escalón efectivo es al menos el tope", nivelDeGasto(2, { tope: 2, aviso: 1, escalar: 1 }), "escalar");
igual("un aviso mayor que el tope nunca se ve: degrada de una", nivelDeGasto(2.5, { tope: 2, aviso: 3, escalar: 3 }), "degradar");
igual("justo debajo del aviso: ok", nivelDeGasto(0.9999, t), "ok");

// ── Alerta para una persona ──
const aviso = contextoAlertaGasto("aviso", 1.0423, t, "hola", "Bazar Farimar");
igual("la alerta lleva el motivo tope_gasto y el nivel", [aviso.motivo, aviso.nivel], ["tope_gasto", "aviso"]);
igual("la alerta lleva el gasto, el tope y el aviso", [aviso.gasto_usd, aviso.tope_usd, aviso.aviso_usd], [1.0423, 2, 1]);
igual("el aviso dice que el agente sigue contestando", /sigue contestando/.test(String(aviso.detalle)), true);
igual("el aviso muestra el gasto con coma decimal", /US\$ 1,04/.test(String(aviso.detalle)), true);
igual("la alerta lleva también el escalón de escalar", aviso.escalar_usd, 3);
const degr = contextoAlertaGasto("degradar", 2.4087, t, "hola", "Bazar Farimar");
igual("degradar lleva el nivel y el escalón", [degr.nivel, degr.escalar_usd], ["degradar", 3]);
igual("degradar dice que el agente SIGUE pero con modelos gratis", /sigue contestando/i.test(String(degr.detalle)) && /gratis/i.test(String(degr.detalle)), true);
igual("degradar NO dice que el agente dejó de contestar", /no contesta más/.test(String(degr.detalle)), false);
const esc = contextoAlertaGasto("escalar", 5.0031, t, "x".repeat(500), null);
igual("escalar dice que el agente NO se corta y que avisa por el horario", /no se corta/i.test(String(esc.detalle)) && /horario/i.test(String(esc.detalle)), true);
igual("escalar NO deja mudo al cliente (no dice 'no contesta más')", /no contesta más/.test(String(esc.detalle)), false);
igual("el texto recibido se recorta a 200", String(esc.texto_recibido).length, 200);
igual("sin razón social queda null", esc.razon_social, null);
igual("la alerta no fija 'urgente' (lo decide notificarHumano por el texto)", "urgente" in esc, false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
