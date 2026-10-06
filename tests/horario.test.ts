// Pruebas del horario de atención telefónica (supabase/functions/_shared/horario.ts). Sin red, sin IA.
// Correr: deno run tests/horario.test.ts   (sale con código 1 si algo falla)
import { calendarioVigente, conCalendario, dentroDeHorario, esperaRespuestaDePersona, feriadosDelCalendario, HORARIO_DEFECTO, horarioEfectivo, horarioVigente, leerHorario, proximaApertura, registrarCalendario, registrarHorario, sumarMinutosHabiles, textoAviso, textoCuando, textoDias, textoHorario, validarHorario, type Horario } from "../supabase/functions/_shared/horario.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
// Fechas en hora de Argentina (UTC-3). 2026-10-09 es viernes, el 10 sábado, el 11 domingo, el 12 lunes, el 13 martes.
const AR = (s: string) => new Date(`${s}:00-03:00`);
const fmt = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
const H: Horario = { ...HORARIO_DEFECTO, dias: [1, 2, 3, 4, 5], feriados: [] };
const HF: Horario = { ...H, feriados: ["2026-10-12"] }; // el lunes 12 es feriado
igual("el 09/10/2026 es viernes y el 12 lunes (las pruebas dependen de esto)", [new Date("2026-10-09T12:00:00Z").getUTCDay(), new Date("2026-10-12T12:00:00Z").getUTCDay()], [5, 1]);

// ── ¿Dentro de horario? ──
igual("lunes 12:00 → sí", dentroDeHorario(AR("2026-10-12T12:00"), H), true);
igual("lunes 09:00 (apertura) → sí", dentroDeHorario(AR("2026-10-12T09:00"), H), true);
igual("lunes 08:59 → no", dentroDeHorario(AR("2026-10-12T08:59"), H), false);
igual("viernes 16:59 → sí", dentroDeHorario(AR("2026-10-09T16:59"), H), true);
igual("viernes 17:00 (cierre) → no", dentroDeHorario(AR("2026-10-09T17:00"), H), false);
igual("sábado 11:00 → no", dentroDeHorario(AR("2026-10-10T11:00"), H), false);
igual("domingo 11:00 → no", dentroDeHorario(AR("2026-10-11T11:00"), H), false);
igual("lunes feriado 12:00 → no", dentroDeHorario(AR("2026-10-12T12:00"), HF), false);
igual("la hora es la de Argentina, no la UTC: 12:00 UTC = 09:00 AR → sí", dentroDeHorario(new Date("2026-10-12T12:00:00Z"), H), true);
igual("…y 11:59 UTC = 08:59 AR → no", dentroDeHorario(new Date("2026-10-12T11:59:00Z"), H), false);

// ── Próxima apertura ──
igual("sábado 11:00 → lunes 09:00", fmt(proximaApertura(AR("2026-10-10T11:00"), H)), "2026-10-12 09:00");
igual("viernes 18:00 → lunes 09:00", fmt(proximaApertura(AR("2026-10-09T18:00"), H)), "2026-10-12 09:00");
igual("lunes 07:00 → ese lunes 09:00", fmt(proximaApertura(AR("2026-10-12T07:00"), H)), "2026-10-12 09:00");
igual("dentro de horario → el mismo momento", fmt(proximaApertura(AR("2026-10-13T10:30"), H)), "2026-10-13 10:30");
igual("con el lunes feriado → martes 09:00", fmt(proximaApertura(AR("2026-10-10T11:00"), HF)), "2026-10-13 09:00");

// ── Vencimiento en tiempo de atención ──
igual("🔴 viernes 16:50 + 20 min → lunes 09:10", fmt(sumarMinutosHabiles(AR("2026-10-09T16:50"), 20, H)), "2026-10-12 09:10");
igual("🔴 sábado 11:00 + 20 min → lunes 09:20", fmt(sumarMinutosHabiles(AR("2026-10-10T11:00"), 20, H)), "2026-10-12 09:20");
igual("🟢 lunes 10:00 + 4 h → lunes 14:00 (todo dentro del día)", fmt(sumarMinutosHabiles(AR("2026-10-12T10:00"), 240, H)), "2026-10-12 14:00");
igual("🟢 lunes 16:00 + 4 h → martes 12:00 (1 h hoy + 3 h mañana)", fmt(sumarMinutosHabiles(AR("2026-10-12T16:00"), 240, H)), "2026-10-13 12:00");
igual("🟢 viernes 15:00 + 4 h → lunes 11:00 (2 h el viernes + 2 h el lunes)", fmt(sumarMinutosHabiles(AR("2026-10-09T15:00"), 240, H)), "2026-10-12 11:00");
igual("🟡 lunes 15:00 + 2 h → lunes 17:00 (justo al cierre)", fmt(sumarMinutosHabiles(AR("2026-10-12T15:00"), 120, H)), "2026-10-12 17:00");
igual("🟡 lunes 16:30 + 2 h → martes 10:30", fmt(sumarMinutosHabiles(AR("2026-10-12T16:30"), 120, H)), "2026-10-13 10:30");
igual("con el lunes feriado: viernes 16:50 + 20 min → martes 09:10", fmt(sumarMinutosHabiles(AR("2026-10-09T16:50"), 20, HF)), "2026-10-13 09:10");
igual("fuera de horario + 0 min → la apertura", fmt(sumarMinutosHabiles(AR("2026-10-10T11:00"), 0, H)), "2026-10-12 09:00");
igual("si el horario NO manda (solo_en_horario=false) corre seguido: sábado 11:00 + 20 min → sábado 11:20", fmt(sumarMinutosHabiles(AR("2026-10-10T11:00"), 20, { ...H, solo_en_horario: false })), "2026-10-10 11:20");
igual("30 días de atención (43.200 min) termina y no se cuelga", (() => { const f = sumarMinutosHabiles(AR("2026-10-12T09:00"), 43200, H); return f.getTime() > AR("2026-10-12T09:00").getTime(); })(), true);
igual("horario con sábados: viernes 16:50 + 20 → sábado 09:10", fmt(sumarMinutosHabiles(AR("2026-10-09T16:50"), 20, { ...H, dias: [1, 2, 3, 4, 5, 6] })), "2026-10-10 09:10");
igual("otro horario (08:30 a 12:00): lunes 11:50 + 20 → martes 08:40", fmt(sumarMinutosHabiles(AR("2026-10-12T11:50"), 20, { ...H, desde: "08:30", hasta: "12:00" })), "2026-10-13 08:40");

// ── Textos ──
igual("horario por defecto dicho en criollo", textoHorario(H), "lunes a viernes de 9 a 17 h");
igual("con sábados", textoHorario({ ...H, dias: [1, 2, 3, 4, 5, 6] }), "lunes a sábado de 9 a 17 h");
igual("con media hora", textoHorario({ ...H, desde: "09:30" }), "lunes a viernes de 9:30 a 17 h");
igual("días sueltos", [textoDias([1, 3]), textoDias([1, 3, 5]), textoDias([6, 7]), textoDias([1, 2, 3, 5])], ["lunes y miércoles", "lunes, miércoles y viernes", "sábado y domingo", "lunes a miércoles y viernes"]);
igual("cuándo: sábado → el lunes", textoCuando(AR("2026-10-10T11:00"), H), "el lunes desde las 9 h");
igual("cuándo: viernes 18:00 → el lunes", textoCuando(AR("2026-10-09T18:00"), H), "el lunes desde las 9 h");
igual("cuándo: lunes 07:00 → hoy", textoCuando(AR("2026-10-12T07:00"), H), "hoy desde las 9 h");
igual("cuándo: lunes 18:00 → mañana", textoCuando(AR("2026-10-12T18:00"), H), "mañana desde las 9 h");
igual("cuándo: sábado con el lunes feriado → el martes", textoCuando(AR("2026-10-10T11:00"), HF), "el martes desde las 9 h");
igual("aviso completo al cliente", textoAviso(AR("2026-10-10T11:00"), H), "Ahora estamos fuera del horario de atención (lunes a viernes de 9 a 17 h). Tu consulta quedó registrada y te respondemos el lunes desde las 9 h.");
igual("avisa si espera a una persona; no avisa de comprobantes, adjuntos ni fallas de la IA", [esperaRespuestaDePersona("reclamo"), esperaRespuestaDePersona("escalation"), esperaRespuestaDePersona("alta_cliente"), esperaRespuestaDePersona("comprobante_recibido"), esperaRespuestaDePersona("llm_timeout"), esperaRespuestaDePersona("adjunto_recibido")], [true, true, true, false, false, false]);

// ── Lo que se guarda ──
igual("validar: lo de siempre es válido", validarHorario(HORARIO_DEFECTO).ok, true);
igual("validar: ordena días, junta repetidos y ordena feriados", (() => { const r = validarHorario({ dias: [5, 1, 1, 3], desde: "09:00", hasta: "17:00", feriados: ["2026-12-25", "2026-10-12", "2026-10-12"], solo_en_horario: false }); return r.ok ? [r.horario.dias, r.horario.feriados, r.horario.solo_en_horario] : r; })(), [[1, 3, 5], ["2026-10-12", "2026-12-25"], false]);
igual("validar: sin días → error", validarHorario({ ...HORARIO_DEFECTO, dias: [] }).ok, false);
igual("validar: día 8 → error", validarHorario({ ...HORARIO_DEFECTO, dias: [1, 8] }).ok, false);
igual("validar: hora mal escrita → error", validarHorario({ ...HORARIO_DEFECTO, desde: "9:00" }).ok, false);
igual("validar: cierre antes de la apertura → error", validarHorario({ ...HORARIO_DEFECTO, desde: "17:00", hasta: "09:00" }).ok, false);
igual("validar: cierre igual a la apertura → error", validarHorario({ ...HORARIO_DEFECTO, desde: "09:00", hasta: "09:00" }).ok, false);
igual("validar: feriado que no existe (31 de febrero) → error", validarHorario({ ...HORARIO_DEFECTO, feriados: ["2026-02-31"] }).ok, false);
igual("validar: feriado mal escrito → error", validarHorario({ ...HORARIO_DEFECTO, feriados: ["12/10/2026"] }).ok, false);
igual("validar: más de 60 feriados → error", validarHorario({ ...HORARIO_DEFECTO, feriados: Array.from({ length: 61 }, (_, i) => `2027-01-${String((i % 28) + 1).padStart(2, "0")}`) }).ok, false);
igual("validar: null → error", validarHorario(null).ok, false);
igual("leer: nada guardado → por defecto", leerHorario(undefined), HORARIO_DEFECTO);
igual("leer: se rescata lo bueno y se ignora lo malo", leerHorario({ dias: [2, 9], desde: "10:00", hasta: "09:00", feriados: ["2026-10-12", "basura"], solo_en_horario: "sí" }), { dias: [2], desde: "09:00", hasta: "17:00", feriados: ["2026-10-12"], solo_en_horario: true, incluir_puentes: false });
igual("leer: lo guardado completo se respeta", leerHorario({ dias: [1, 2], desde: "08:00", hasta: "12:30", feriados: [], solo_en_horario: false }), { dias: [1, 2], desde: "08:00", hasta: "12:30", feriados: [], solo_en_horario: false, incluir_puentes: false });
registrarHorario({ dias: [1], desde: "10:00", hasta: "11:00", feriados: [], solo_en_horario: true });
igual("registrar: queda vigente", horarioVigente().desde, "10:00");
registrarHorario(null);
igual("registrar de nuevo REEMPLAZA: volver a null deja el de siempre", horarioVigente(), HORARIO_DEFECTO);
igual("el vigente es una copia: tocarlo no cambia el registrado", (() => { const a = horarioVigente(); a.dias.push(7); return horarioVigente().dias; })(), [1, 2, 3, 4, 5]);

// ── Calendario de Planify (planify.feriados): nacional / trasladable / puente ──
const CAL = [
  { fecha: "2026-10-12", nombre: "Día del Respeto a la Diversidad Cultural", tipo: "trasladable" },
  { fecha: "2026-11-09", nombre: "Visita del papa León XIV", tipo: "nacional" },
  { fecha: "2026-12-07", nombre: "Puente turístico no laborable", tipo: "puente" },
  { fecha: "2026-12-08", nombre: "Día de la Inmaculada Concepción de María", tipo: "nacional" },
];
igual("calendario: nacional y trasladable cuentan; el puente no, por defecto", feriadosDelCalendario({ incluir_puentes: false }, CAL), ["2026-10-12", "2026-11-09", "2026-12-08"]);
igual("calendario: con incluir_puentes, el puente también", feriadosDelCalendario({ incluir_puentes: true }, CAL), ["2026-10-12", "2026-11-09", "2026-12-07", "2026-12-08"]);
igual("calendario: filas inválidas se ignoran (fecha mala, null, sin tipo cuenta como feriado)", feriadosDelCalendario({ incluir_puentes: false }, [{ fecha: "12/10/2026" }, null as never, { fecha: "2026-02-31" }, { fecha: "2026-07-09" }]), ["2026-07-09"]);
igual("calendario: sin filas ni lista → vacío", [feriadosDelCalendario({ incluir_puentes: false }, []), feriadosDelCalendario({ incluir_puentes: false }, undefined as never)], [[], []]);
igual("conCalendario: junta manuales y calendario sin repetir, ordenados", conCalendario({ ...H, feriados: ["2026-10-12", "2026-11-02"] }, CAL).feriados, ["2026-10-12", "2026-11-02", "2026-11-09", "2026-12-08"]);
igual("conCalendario no toca el horario original", (() => { const o = { ...H, feriados: ["2026-11-02"] }; conCalendario(o, CAL); return o.feriados; })(), ["2026-11-02"]);
const HC = conCalendario(H, CAL); // el horario "efectivo" con el calendario
igual("con el calendario, el lunes 12/10 ya no se atiende", dentroDeHorario(AR("2026-10-12T12:00"), HC), false);
igual("con el calendario: viernes 16:50 + 🔴 20 min → martes 09:10 (el lunes es feriado)", fmt(sumarMinutosHabiles(AR("2026-10-09T16:50"), 20, HC)), "2026-10-13 09:10");
igual("con el calendario: el aviso del sábado dice 'el martes'", textoCuando(AR("2026-10-10T11:00"), HC), "el martes desde las 9 h");
igual("el puente 07/12 (lunes) no frena la atención por defecto", dentroDeHorario(AR("2026-12-07T12:00"), conCalendario(H, CAL)), true);
igual("…pero con incluir_puentes sí", dentroDeHorario(AR("2026-12-07T12:00"), conCalendario({ ...H, incluir_puentes: true }, CAL)), false);
registrarCalendario(CAL);
registrarHorario({ dias: [1, 2, 3, 4, 5], desde: "09:00", hasta: "17:00", feriados: ["2026-11-02"], solo_en_horario: true, incluir_puentes: false });
igual("horarioEfectivo = guardado + calendario", horarioEfectivo().feriados, ["2026-10-12", "2026-11-02", "2026-11-09", "2026-12-08"]);
igual("horarioVigente sigue siendo sólo lo guardado (lo que muestra el panel)", horarioVigente().feriados, ["2026-11-02"]);
igual("calendarioVigente devuelve copia", (() => { const c = calendarioVigente(); c[0].fecha = "x"; return calendarioVigente()[0].fecha; })(), "2026-10-12");
registrarCalendario(null);
igual("registrar el calendario de nuevo REEMPLAZA (null lo vacía)", calendarioVigente(), []);
registrarCalendario([{ fecha: "basura" }, { fecha: "2026-10-12", tipo: "nacional" }]);
igual("registrar calendario descarta filas inválidas", calendarioVigente().map((f) => f.fecha), ["2026-10-12"]);
registrarCalendario(null); registrarHorario(null);
igual("validar: incluir_puentes se guarda", (() => { const r = validarHorario({ ...HORARIO_DEFECTO, incluir_puentes: true }); return r.ok ? r.horario.incluir_puentes : r; })(), true);
igual("validar: incluir_puentes que no es sí/no → error", validarHorario({ ...HORARIO_DEFECTO, incluir_puentes: "sí" }).ok, false);
igual("por defecto los puentes no cuentan", HORARIO_DEFECTO.incluir_puentes, false);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
