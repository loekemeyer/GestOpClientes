// Pruebas del aviso por WhatsApp al equipo (supabase/functions/_shared/aviso-equipo.ts y destinosDeAviso). Sin red, sin IA.
// Correr: deno run tests/aviso-equipo.test.ts   (sale con código 1 si algo falla)
import {
  aplicarTope, avisaAlNacer, avisaSiNadieToma, canonTel, CONFIG_WA_DEFECTO, type ConfigWa, contextoConEstadoWa, debeEscalar, debeInmediatoDiferido, destinatarios,
  duracionTexto, escaladaVence, gastoMensual, gastoReal, leerConfigWa, leerEstadoWa, mensajesPorAlerta, modoDeMotivo, type Persona, paramsEscalada, paramsInmediato, type Sector, sinAvisar,
  TARIFA_UTILIDAD, validarConfigWa, ALERTAS_DIA_TECHO,
} from "../supabase/functions/_shared/aviso-equipo.ts";
import { destinosDeAviso } from "../supabase/functions/_shared/derivaciones-destino.ts";
import type { Derivaciones, Regla } from "../supabase/functions/_shared/derivaciones.ts";
import { HORARIO_DEFECTO, type Horario } from "../supabase/functions/_shared/horario.ts";
import { PLANTILLAS, renderPlantilla, validar } from "../supabase/functions/_shared/plantillas-meta.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const cfg = (o: Partial<ConfigWa> = {}): ConfigWa => ({ ...CONFIG_WA_DEFECTO, extra: [], escalada_min: { rojo: null, amarillo: null, verde: null }, ...o });

// ── Teléfonos ──
igual("celular con 549 queda igual", canonTel("5491131181021"), "5491131181021");
igual("con + y guiones", canonTel("+54 9 11 3118-1021"), "5491131181021");
igual("sin 549, 10 dígitos", canonTel("11 3118 1021"), "5491131181021");
igual("con 0 adelante", canonTel("011 3118 1021"), "5491131181021");
igual("54 sin el 9", canonTel("54 11 3118 1021"), "5491131181021");
igual("muy corto → null", canonTel("3118"), null);
igual("vacío → null", canonTel(""), null);
igual("null → null", canonTel(null), null);
igual("letras → null", canonTel("llamar a Ana"), null);

// ── Modo por motivo ──
const c = cfg();
igual("sin elegir y va a Planify → ambos", modoDeMotivo(c, null, "entrega", { planify: true, urgente: false }), "ambos");
igual("sin elegir y sólo Tareas → off", modoDeMotivo(c, null, "pedido_archivo", { planify: false, urgente: false }), "off");
igual("cambio_datos sin elegir avisa apenas nace aunque vaya sólo a Tareas", modoDeMotivo(c, null, "cambio_datos", { planify: false, urgente: false }), "inmediato");
igual("reseteo_clave sin elegir → inmediato", modoDeMotivo(c, undefined, "reseteo_clave", { planify: false, urgente: false }), "inmediato");
igual("lo elegido manda sobre el defecto", modoDeMotivo(c, "escalada", "cambio_datos", { planify: false, urgente: false }), "escalada");
igual("elegido 'off' en un sensible: respeta", modoDeMotivo(c, "off", "cambio_datos", { planify: false, urgente: false }), "off");
igual("valor inválido se ignora y rige el defecto", modoDeMotivo(c, "siempre", "entrega", { planify: true, urgente: false }), "ambos");
igual("urgente con 'off' avisa igual (urgentes_siempre)", modoDeMotivo(c, "off", "reclamo", { planify: true, urgente: true }), "inmediato");
igual("urgente con 'off' y urgentes_siempre apagado: no avisa", modoDeMotivo(cfg({ urgentes_siempre: false }), "off", "reclamo", { planify: true, urgente: true }), "off");
igual("función apagada: nada, ni lo urgente ni lo sensible", modoDeMotivo(cfg({ activo: false }), "ambos", "cambio_datos", { planify: true, urgente: true }), "off");
igual("avisaAlNacer / avisaSiNadieToma", [avisaAlNacer("off"), avisaAlNacer("inmediato"), avisaAlNacer("escalada"), avisaAlNacer("ambos"),
  avisaSiNadieToma("off"), avisaSiNadieToma("inmediato"), avisaSiNadieToma("escalada"), avisaSiNadieToma("ambos")], [false, true, false, true, false, false, true, true]);

// ── Config: validar y leer ──
igual("config vacía = por defecto", leerConfigWa(undefined), CONFIG_WA_DEFECTO);
igual("config con basura = por defecto", leerConfigWa("hola"), CONFIG_WA_DEFECTO);
{
  const r = validarConfigWa({ activo: false, sector: "ambos", solo_horario: true, urgentes_siempre: false, con_detalle: false, escalada_min: { rojo: 10, amarillo: "", verde: null }, max_edad_h: 24, tope_hora: 5,
    extra: [{ nombre: "Thomas", telefono: "11 6257 0000" }, { nombre: "Repetido", telefono: "+54 9 11 6257-0000" }] });
  igual("config completa válida", r.ok && r.config, { activo: false, sector: "ambos", extra: [{ nombre: "Thomas", telefono: "5491162570000" }], solo_horario: true, urgentes_siempre: false, con_detalle: false,
    escalada_min: { rojo: 10, amarillo: null, verde: null }, max_edad_h: 24, tope_hora: 5 });
}
igual("sector inválido", validarConfigWa({ sector: "todos" }).ok, false);
igual("escalada fuera de rango", validarConfigWa({ escalada_min: { rojo: 0 } }).ok, false);
igual("escalada pasada de 30 días", validarConfigWa({ escalada_min: { verde: 43201 } }).ok, false);
igual("edad máxima 0", validarConfigWa({ max_edad_h: 0 }).ok, false);
igual("tope 0", validarConfigWa({ tope_hora: 0 }).ok, false);
igual("tope 201", validarConfigWa({ tope_hora: 201 }).ok, false);
igual("interruptor que no es booleano", validarConfigWa({ activo: "si" }).ok, false);
igual("número adicional sin nombre", validarConfigWa({ extra: [{ nombre: " ", telefono: "1131181021" }] }).ok, false);
igual("número adicional con teléfono inválido", validarConfigWa({ extra: [{ nombre: "Ana", telefono: "123" }] }).ok, false);
igual("más de 10 números adicionales", validarConfigWa({ extra: Array.from({ length: 11 }, (_, i) => ({ nombre: "N" + i, telefono: "11 3118 10" + String(10 + i) })) }).ok, false);
igual("leer rescata lo que sirve de una config rota", leerConfigWa({ activo: false, tope_hora: 9999, escalada_min: { rojo: 15, verde: -3 } }),
  { ...CONFIG_WA_DEFECTO, activo: false, escalada_min: { rojo: 15, amarillo: null, verde: null } });

// ── Destinatarios ──
const personas: Persona[] = [
  { id: 38, nombre: "Becker Marianela", telefono: "5491131180038", department_id: 8, activo: true },
  { id: 63, nombre: "Giuliana De La Vega", telefono: "5491131180063", department_id: 8, activo: true },
  { id: 62, nombre: "Yanina Delbono", telefono: null, department_id: 8, activo: true },
  { id: 70, nombre: "Ex Empleado", telefono: "5491131180070", department_id: 8, activo: false },
  { id: 64, nombre: "Pablo Olejavetzky", telefono: "11 3118 0064", department_id: 2, activo: true },
];
const sectores: Sector[] = [{ id: 8, nombre: "Ventas", telefono: "5491131181021" }, { id: 2, nombre: "IT", telefono: null }];
const tels = (x: ReturnType<typeof destinatarios>) => x.lista.map((y) => y.telefono);
igual("persona sola → su teléfono", destinatarios([{ employee_id: 64 }], personas, sectores, cfg()).lista, [{ telefono: "5491131180064", etiqueta: "Pablo Olejavetzky", origen: "persona" }]);
igual("sector, modo personas → cada persona activa con teléfono", tels(destinatarios([{ department_id: 8 }], personas, sectores, cfg({ sector: "personas" }))), ["5491131180038", "5491131180063"]);
igual("sector, modo personas: la que no tiene teléfono queda anotada", destinatarios([{ department_id: 8 }], personas, sectores, cfg()).sin_telefono, ["Ventas"]);
igual("sector, modo línea → sólo el teléfono del sector", destinatarios([{ department_id: 8 }], personas, sectores, cfg({ sector: "linea" })).lista, [{ telefono: "5491131181021", etiqueta: "Ventas", origen: "linea" }]);
igual("sector, modo ambos → personas y línea", tels(destinatarios([{ department_id: 8 }], personas, sectores, cfg({ sector: "ambos" }))), ["5491131180038", "5491131180063", "5491131181021"]);
igual("sector sin línea y modo línea → nadie y se anota", ((x) => [x.lista.length, x.sin_telefono])(destinatarios([{ department_id: 2 }], [], sectores, cfg({ sector: "linea" }))), [0, ["IT"]]);
igual("persona inactiva no recibe", destinatarios([{ employee_id: 70 }], personas, sectores, cfg()).lista, []);
igual("persona sin teléfono → anotada", destinatarios([{ employee_id: 62 }], personas, sectores, cfg()).sin_telefono, ["Yanina Delbono"]);
igual("persona que no existe → nadie", destinatarios([{ employee_id: 999 }], personas, sectores, cfg()).lista, []);
igual("sector que no existe en la lista: se llama 'sector #n'", destinatarios([{ department_id: 77 }], [{ id: 1, nombre: "A", telefono: "5491100000001", department_id: 77, activo: true }], [], cfg()).lista[0]?.etiqueta, "sector #77");
igual("números adicionales se suman al final", tels(destinatarios([{ employee_id: 38 }], personas, sectores, cfg({ extra: [{ nombre: "Thomas", telefono: "5491162570000" }] }))), ["5491131180038", "5491162570000"]);
igual("un adicional que ya está como destinatario no se repite", destinatarios([{ employee_id: 38 }], personas, sectores, cfg({ extra: [{ nombre: "Marianela", telefono: "5491131180038" }] })).lista.length, 1);
igual("dos destinos con la misma persona → un solo mensaje", destinatarios([{ department_id: 8 }, { employee_id: 38 }], personas, sectores, cfg()).lista.length, 2);

// ── Parámetros de la plantilla ──
const datos = { etiqueta: "Ventas", motivo: "Consulta de entrega", cliente: "Chef S.R.L. (411)", detalle: "Retira el lunes 12/10 · franja sin confirmar", hace: "2 h" };
igual("inmediato: 4 variables", paramsInmediato(datos, cfg()), { "1": "Ventas", "2": "Consulta de entrega", "3": "Chef S.R.L. (411)", "4": "Retira el lunes 12/10 · franja sin confirmar" });
igual("escalada: 4 variables, la 1 es el tiempo", paramsEscalada(datos, cfg()), { "1": "2 h", "2": "Consulta de entrega", "3": "Chef S.R.L. (411)", "4": "Retira el lunes 12/10 · franja sin confirmar" });
igual("sin detalle (con_detalle apagado) → 'ver en Planify'", paramsInmediato(datos, cfg({ con_detalle: false }))["4"], "ver en Planify");
igual("detalle vacío → 'ver en Planify'", paramsInmediato({ ...datos, detalle: "  " }, cfg())["4"], "ver en Planify");
igual("el texto del cliente va en una línea (Meta no admite saltos)", paramsInmediato({ ...datos, detalle: "hola\n\nquiero   cambiar\tel pedido" }, cfg())["4"], "hola quiero cambiar el pedido");
igual("enlaces del cliente no pasan", paramsInmediato({ ...datos, detalle: "mirá https://malo.example/x ahora" }, cfg())["4"], "mirá (enlace) ahora");
igual("detalle largo se recorta a 120", paramsInmediato({ ...datos, detalle: "a".repeat(300) }, cfg())["4"].length, 120);
igual("ninguna variable queda vacía", Object.values(paramsInmediato({ etiqueta: "", motivo: "", cliente: "", detalle: null }, cfg())).every((x) => x.length > 0), true);
igual("escalada sin 'hace' → 'un rato'", paramsEscalada({ ...datos, hace: undefined }, cfg())["1"], "un rato");

// ── Plantillas definidas en plantillas-meta.ts ──
for (const n of ["aviso_equipo", "aviso_equipo_sin_tomar"]) {
  const p = PLANTILLAS.find((x) => x.name === n);
  igual(`plantilla ${n} existe`, !!p, true);
  igual(`plantilla ${n} pasa las reglas de Meta`, p ? validar(p) : ["no existe"], []);
  igual(`plantilla ${n} es UTILITY y es_AR`, p ? [p.category, p.language] : [], ["UTILITY", "es_AR"]);
}
igual("la plantilla inmediata se ve completa con sus variables", renderPlantilla("aviso_equipo", paramsInmediato(datos, cfg())),
  "Hay un aviso nuevo en Planify para Ventas.\nMotivo: Consulta de entrega.\nCliente: Chef S.R.L. (411).\nDetalle: Retira el lunes 12/10 · franja sin confirmar.\nAbrí Planify para tomarlo.");
igual("la plantilla de escalada se ve completa con sus variables", renderPlantilla("aviso_equipo_sin_tomar", paramsEscalada(datos, cfg())),
  "Hace 2 h hay un aviso sin tomar en Planify.\nMotivo: Consulta de entrega.\nCliente: Chef S.R.L. (411).\nDetalle: Retira el lunes 12/10 · franja sin confirmar.\nAbrí Planify para tomarlo.");

// ── Duración ──
igual("menos de un minuto", duracionTexto(30_000), "un rato");
igual("45 min", duracionTexto(45 * 60_000), "45 min");
igual("2 h", duracionTexto(120 * 60_000), "2 h");
igual("2 h 30 min", duracionTexto(150 * 60_000), "2 h 30 min");
igual("1 día", duracionTexto(24 * 3_600_000), "1 día");
igual("2 días 5 h", duracionTexto(53 * 3_600_000), "2 días 5 h");
igual("NaN → un rato", duracionTexto(NaN), "un rato");

// ── Estado en la alerta ──
igual("sin estado", leerEstadoWa({}), {});
igual("ctx null", leerEstadoWa(null), {});
igual("estado guardado se lee igual", leerEstadoWa(contextoConEstadoWa({ motivo: "entrega" }, { inm: ["1", "2"], esc: [], dif: true, omit: ["3"], sin_tel: ["Ana"] })), { inm: ["1", "2"], esc: [], omit: ["3"], sin_tel: ["Ana"], dif: true });
igual("contextoConEstadoWa conserva el resto del contexto", (contextoConEstadoWa({ motivo: "entrega", planify_task_id: 5 }, { inm: [] }) as Record<string, unknown>).planify_task_id, 5);
igual("estado con basura se ignora", leerEstadoWa({ wa_aviso: { inm: "x", dif: "si" } }), {});
const L = [{ telefono: "1", etiqueta: "a", origen: "persona" as const }, { telefono: "2", etiqueta: "b", origen: "persona" as const }];
igual("sinAvisar descarta los que ya recibieron", sinAvisar(L, ["1"]).map((x) => x.telefono), ["2"]);
igual("sinAvisar sin historia → todos", sinAvisar(L, undefined).length, 2);

// ── Tope por hora ──
igual("bajo el tope: todos", aplicarTope(L, {}, 2).enviar.length, 2);
igual("uno ya en el tope: se omite", ((x) => [x.enviar.map((y) => y.telefono), x.omitidos.map((y) => y.telefono)])(aplicarTope(L, { "1": 20 }, 20)), [["2"], ["1"]]);
igual("la tanda misma también cuenta", ((x) => [x.enviar.length, x.omitidos.length])(aplicarTope([L[0], L[0], L[0]], {}, 2)), [2, 1]);

// ── Escalada ──
const H: Horario = { ...HORARIO_DEFECTO, dias: [1, 2, 3, 4, 5], feriados: [] };
// 07/10/2026 es miércoles. Hora de Argentina = UTC-3.
const ar = (iso: string) => new Date(iso + "-03:00");
const creada = ar("2026-10-07T10:00:00");
igual("vence a los minutos del semáforo (🟡 120) dentro del horario", escaladaVence(creada, "amarillo", cfg(), 120, H).toISOString(), ar("2026-10-07T12:00:00").toISOString());
igual("escalada_min pisa al semáforo", escaladaVence(creada, "amarillo", cfg({ escalada_min: { rojo: null, amarillo: 30, verde: null } }), 120, H).toISOString(), ar("2026-10-07T10:30:00").toISOString());
igual("🔴 que entra el viernes 16:50 vence el lunes 9:10", escaladaVence(ar("2026-10-09T16:50:00"), "rojo", cfg(), 20, H).toISOString(), ar("2026-10-12T09:10:00").toISOString());
const base = { creada, vence: ar("2026-10-07T12:00:00"), tomadaPor: null, estado: {}, cfg: cfg(), h: H, modo: "ambos" as const };
igual("antes de vencer: no escala", debeEscalar({ ...base, ahora: ar("2026-10-07T11:59:00") }), false);
igual("vencida y sin tomar: escala", debeEscalar({ ...base, ahora: ar("2026-10-07T12:05:00") }), true);
igual("alguien se encargó: no escala", debeEscalar({ ...base, ahora: ar("2026-10-07T12:05:00"), tomadaPor: "Ana" }), false);
igual("ya escalada (aunque sea sin destinatarios): no repite", debeEscalar({ ...base, ahora: ar("2026-10-07T12:05:00"), estado: { esc: [] } }), false);
igual("modo sólo inmediato: no escala", debeEscalar({ ...base, ahora: ar("2026-10-07T12:05:00"), modo: "inmediato" }), false);
igual("modo off: no escala", debeEscalar({ ...base, ahora: ar("2026-10-07T12:05:00"), modo: "off" }), false);
igual("modo sólo escalada: escala", debeEscalar({ ...base, ahora: ar("2026-10-07T12:05:00"), modo: "escalada" }), true);
igual("alerta más vieja que max_edad_h: no escala", debeEscalar({ ...base, ahora: ar("2026-10-09T12:05:00") }), false);
igual("max_edad_h más largo la deja escalar", debeEscalar({ ...base, ahora: ar("2026-10-09T12:05:00"), cfg: cfg({ max_edad_h: 72 }) }), true);
igual("solo_horario y fuera de horario: espera", debeEscalar({ ...base, ahora: ar("2026-10-07T18:00:00"), cfg: cfg({ solo_horario: true }) }), false);
igual("solo_horario y dentro de horario: escala", debeEscalar({ ...base, ahora: ar("2026-10-07T13:00:00"), cfg: cfg({ solo_horario: true }) }), true);
igual("sin solo_horario escala de noche", debeEscalar({ ...base, ahora: ar("2026-10-07T21:00:00") }), true);
igual("tomadaPor en blanco no cuenta como tomada", debeEscalar({ ...base, ahora: ar("2026-10-07T12:05:00"), tomadaPor: "  " }), true);

// ── Inmediato diferido por horario ──
const dif = { creada: ar("2026-10-07T20:00:00"), estado: { dif: true }, cfg: cfg({ solo_horario: true }), h: H, modo: "inmediato" as const };
igual("diferido: de noche sigue esperando", debeInmediatoDiferido({ ...dif, ahora: ar("2026-10-07T22:00:00") }), false);
igual("diferido: a la mañana siguiente sale", debeInmediatoDiferido({ ...dif, ahora: ar("2026-10-08T09:10:00") }), true);
igual("diferido: si ya salió, no repite", debeInmediatoDiferido({ ...dif, ahora: ar("2026-10-08T09:10:00"), estado: { dif: true, inm: ["1"] } }), false);
igual("diferido: sin la marca no hace nada", debeInmediatoDiferido({ ...dif, ahora: ar("2026-10-08T09:10:00"), estado: {} }), false);
igual("diferido: modo sólo escalada no manda el inmediato", debeInmediatoDiferido({ ...dif, ahora: ar("2026-10-08T09:10:00"), modo: "escalada" }), false);
igual("diferido: demasiado viejo no sale", debeInmediatoDiferido({ ...dif, ahora: ar("2026-10-11T09:10:00") }), false);

// ── A quién va (destinosDeAviso) ──
const regla = (o: Partial<Regla> = {}): Regla => ({ destino: "planify", planify: true, employee_id: null, department_id: null, tambien: [], ...o });
const der = (motivos: Record<string, Regla>, defecto: Derivaciones["defecto"] = { employee_id: 64, department_id: null }): Derivaciones =>
  ({ prueba_employee_id: 64, broadcast: true, defecto, motivos: { otro: regla(), ...motivos }, extra: [] });
igual("producción: los mismos destinos que la tarea", destinosDeAviso(der({ entrega: regla({ department_id: 8, tambien: [{ employee_id: 5, department_id: null }] }) }), "entrega", true), [{ department_id: 8 }, { employee_id: 5 }]);
igual("producción: un motivo sólo-Tareas igual tiene destinatarios", destinosDeAviso(der({ cambio_datos: regla({ destino: "tareas", planify: false, department_id: 8 }) }), "cambio_datos", true), [{ department_id: 8 }]);
igual("producción: sin configurar → el defecto", destinosDeAviso(der({}), "cambio_datos", true), [{ employee_id: 64 }]);
igual("prueba: un solo destino, la persona de prueba", destinosDeAviso(der({ entrega: regla({ department_id: 8, tambien: [{ employee_id: 5, department_id: null }] }) }), "entrega", false), [{ employee_id: 64 }]);
igual("prueba sin persona de prueba → nadie", destinosDeAviso({ ...der({}), prueba_employee_id: null }, "entrega", false), []);
igual("whitelist_gate nunca avisa", destinosDeAviso(der({}), "whitelist_gate", true), []);

// ── Gasto aproximado ──
const r2 = (n: number) => Math.round(n * 100) / 100;
igual("tarifa de utilidad en Argentina (calculadora de Meta, 07/10)", [TARIFA_UTILIDAD.usd, TARIFA_UTILIDAD.ars], [0.026, 37.6798]);
igual("techo de alertas por día = 712 consultas / 63 días", r2(ALERTAS_DIA_TECHO), r2(712 / 63));
igual("3 destinatarios, nace y escala, nadie toma: 6 mensajes por alerta", mensajesPorAlerta("ambos", 3, 1), 6);
igual("3 destinatarios, sólo al nacer: 3", mensajesPorAlerta("inmediato", 3), 3);
igual("3 destinatarios, sólo si nadie lo toma y se toma la mitad: 1,5", mensajesPorAlerta("escalada", 3, 0.5), 1.5);
igual("sin WhatsApp: 0", mensajesPorAlerta("off", 3), 0);
igual("nadie a quien avisar: 0", mensajesPorAlerta("ambos", 0), 0);
igual("destinatarios inválidos (NaN, negativo): 0", [mensajesPorAlerta("ambos", NaN), mensajesPorAlerta("ambos", -2)], [0, 0]);
igual("'escalan' fuera de rango se recorta (2 = 1, -1 = 0)", [mensajesPorAlerta("ambos", 2, 2), mensajesPorAlerta("ambos", 2, -1)], [4, 2]);
igual("fracción de destinatarios se redondea para abajo (2,9 → 2)", mensajesPorAlerta("inmediato", 2.9), 2);
{
  const g = gastoMensual(339, 6);
  igual("techo del estimativo: 339 alertas × 6 mensajes", [g.mensajes, r2(g.usd), Math.round(g.ars)], [2034, 52.88, 76641]);
  const b2 = gastoMensual(339, 3);
  igual("3 mensajes por alerta: 1.017 mensajes, US$ 26,44", [b2.mensajes, r2(b2.usd), Math.round(b2.ars)], [1017, 26.44, 38320]);
  igual("1 mensaje por alerta: US$ 8,81", r2(gastoMensual(339, 1).usd), 8.81);
  igual("sin alertas o sin mensajes: 0", [gastoMensual(0, 6).usd, gastoMensual(339, 0).usd, gastoMensual(-5, 6).mensajes], [0, 0, 0]);
  igual("tarifa propia (cambia la cuenta)", gastoMensual(100, 2, { usd: 0.05, ars: 70 }), { mensajes: 200, usd: 10, ars: 14000 });
}
igual("gasto real: sólo los enviados cuestan", ((g) => [g.enviados, g.retenidos, g.fallidos, g.pendientes, r2(g.usd), Math.round(g.ars)])(gastoReal(["sent", "sent", "sent", "held_no_whitelist", "failed", "pending", "sending"])), [3, 1, 1, 2, 0.08, 113]);
igual("gasto real sin filas: todo en cero", gastoReal([]), { enviados: 0, retenidos: 0, fallidos: 0, pendientes: 0, usd: 0, ars: 0 });

if (fallas) { console.error(`\n${fallas} prueba(s) fallaron`); Deno.exit(1); }
console.log("\ntodas las pruebas pasaron");
