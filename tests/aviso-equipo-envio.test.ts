// Pruebas de la parte del aviso por WhatsApp que toca la base (supabase/functions/_shared/aviso-equipo-envio.ts), con una base falsa en memoria. Sin red.
// Correr: deno run --allow-env tests/aviso-equipo-envio.test.ts   (sale con código 1 si algo falla)
// alertas-vencimiento.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { avisarAlCrear, escalar } = await import("../supabase/functions/_shared/aviso-equipo-envio.ts");
const { CONFIG_WA_DEFECTO } = await import("../supabase/functions/_shared/aviso-equipo.ts");
import type { Io } from "../supabase/functions/_shared/aviso-equipo-envio.ts";
import type { ConfigWa } from "../supabase/functions/_shared/aviso-equipo.ts";
import type { Derivaciones, Regla } from "../supabase/functions/_shared/derivaciones.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
// Los console.log del módulo (una línea por aviso) no ensucian la salida de las pruebas.
const logOriginal = console.log;
const callar = () => { console.log = () => {}; };
const hablar = () => { console.log = logOriginal; };

// ── Base falsa: sólo lo que usa el módulo (select/insert/update con eq, neq, in, gte, order, limit, maybeSingle) ──
// deno-lint-ignore no-explicit-any
type Fila = Record<string, any>;
function fakeDb(tablas: Record<string, Fila[]>, opts: { fallaInsert?: string } = {}) {
  let seq = 1000;
  const from = (tabla: string) => {
    tablas[tabla] ??= [];
    let modo: "select" | "update" | "insert" = "select", patch: Fila = {}, lim = Infinity, nuevas: Fila[] = [];
    const filtros: Array<(r: Fila) => boolean> = [];
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: () => b,
      insert: (x: Fila | Fila[]) => { modo = "insert"; nuevas = Array.isArray(x) ? x : [x]; return b; },
      update: (p: Fila) => { modo = "update"; patch = p; return b; },
      eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filtros.push((r) => r[c] !== v), b),
      in: (c: string, vs: unknown[]) => (filtros.push((r) => vs.includes(r[c])), b),
      gte: (c: string, v: unknown) => (filtros.push((r) => String(r[c]) >= String(v)), b),
      order: () => b, limit: (n: number) => (lim = n, b),
      maybeSingle: () => run(true), single: () => run(true),
      then: (res: (x: unknown) => unknown, rej: (x: unknown) => unknown) => run(false).then(res, rej),
    };
    const run = async (uno: boolean) => {
      if (modo === "insert") {
        if (opts.fallaInsert === tabla) return { data: null, error: { message: "falló el insert" } };
        for (const r of nuevas) tablas[tabla].push({ id: ++seq, status: "pending", created_at: new Date().toISOString(), ...r });
        return { data: null, error: null };
      }
      const sel = tablas[tabla].filter((r) => filtros.every((f) => f(r)));
      if (modo === "update") { for (const r of sel) Object.assign(r, patch); return { data: null, error: null }; }
      const out = sel.slice(0, lim);
      return { data: uno ? (out[0] ?? null) : out, error: null };
    };
    return b;
  };
  return { from };
}

// ── Datos ──
const miercoles = (hhmm: string) => new Date(`2026-10-07T${hhmm}:00-03:00`); // miércoles 07/10/2026, hora de Argentina
const jueves = (hhmm: string) => new Date(`2026-10-08T${hhmm}:00-03:00`);
const regla = (o: Partial<Regla> = {}): Regla => ({ destino: "planify", planify: true, employee_id: null, department_id: null, tambien: [], wa: null, ...o });
const der = (wa: Partial<ConfigWa> = {}, motivos: Record<string, Regla> = {}): Derivaciones => ({
  prueba_employee_id: 64, broadcast: true, defecto: { employee_id: 64, department_id: null }, extra: [],
  motivos: {
    otro: regla(), entrega: regla({ department_id: 8 }), cambio_datos: regla({ destino: "tareas", planify: false, department_id: 8 }),
    pago: regla({ department_id: 5, wa: "escalada" }), faq_no_match: regla({ destino: "tareas", planify: false }), ...motivos,
  },
  wa: { ...CONFIG_WA_DEFECTO, sector: "personas", extra: [], escalada_min: { rojo: null, amarillo: null, verde: null }, ...wa },
});
const PERSONAS: Fila[] = [
  { id: 38, nombre: "Becker Marianela", telefono: "5491131180038", department_id: 8, activo: true },
  { id: 63, nombre: "Giuliana De La Vega", telefono: "5491131180063", department_id: 8, activo: true },
  { id: 62, nombre: "Yanina Delbono", telefono: null, department_id: 8, activo: true },
  { id: 71, nombre: "Cobranza Uno", telefono: "5491131180071", department_id: 5, activo: true },
  { id: 64, nombre: "Pablo Olejavetzky", telefono: "11 3118 0064", department_id: 2, activo: true },
];
const SECTORES: Fila[] = [{ id: 8, nombre: "Ventas", telefono: "5491131181021" }, { id: 5, nombre: "Cobranzas", telefono: null }];
const MOTIVOS: Record<string, string> = { entrega: "Consulta de entrega", cambio_datos: "Dirección nueva", pago: "Pago o importe", faq_no_match: "Pregunta sin respuesta" };

function armar(o: { d: Derivaciones; alertas: Fila[]; ahora: Date; produccion?: boolean; outbox?: Fila[]; planifyCae?: boolean; fallaInsert?: string }) {
  const tablas: Record<string, Fila[]> = { wa_alertas_humano: o.alertas, wa_outbox: o.outbox ?? [] };
  const pl = fakeDb({ employees: PERSONAS.map((p) => ({ ...p })), departments: SECTORES.map((s) => ({ ...s })) });
  const io: Io = {
    db: fakeDb(tablas, { fallaInsert: o.fallaInsert }), derivaciones: async () => o.d, calendario: async () => [], registrar: async () => [],
    planify: async () => { if (o.planifyCae) throw new Error("Gestión no contesta"); return pl; },
    cliente: async (a) => String(a.contexto?.razon_social ?? ""), produccion: async () => o.produccion !== false, motivo: (c) => MOTIVOS[c] ?? c, ahora: () => o.ahora,
  };
  return { io, tablas, outbox: () => tablas.wa_outbox, alerta: (id: number) => tablas.wa_alertas_humano.find((x) => x.id === id)! };
}
const alerta = (id: number, ctx: Fila, o: Fila = {}): Fila => ({ id, tipo: "escalation", phone: "5491199990000", customer_id: null, estado: "pendiente", created_at: miercoles("10:00").toISOString(), contexto: ctx, ...o });
const tels = (x: Fila[]) => x.map((r) => r.phone);

// ── Apenas nace: un motivo que va a Planify y avisa a cada persona del sector ──
{
  const t = armar({ d: der(), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "entrega", razon_social: "Chef S.R.L. (411)", texto_recibido: "Retiro el lunes\npor la tarde" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("entrega → 2 avisos (Yanina no tiene teléfono)", tels(t.outbox()), ["5491131180038", "5491131180063"]);
  const f = t.outbox()[0];
  igual("usa la plantilla del aviso inmediato, con su contexto y un ref_id que no parece pedido", [f.template_name, f.context, f.ref_id], ["aviso_equipo", "aviso_equipo_inm", "alerta-1"]);
  igual("variables: para quién, motivo, cliente y lo que escribió (en una línea)", f.template_params, { "1": "Ventas", "2": "Consulta de entrega", "3": "Chef S.R.L. (411)", "4": "Retiro el lunes por la tarde" });
  igual("sin body (es una plantilla)", f.body, undefined);
  igual("queda anotado a quiénes se avisó y quién no tiene teléfono", t.alerta(1).contexto.wa_aviso, { inm: ["5491131180038", "5491131180063"], sin_tel: ["Ventas"] });
  igual("el resto del contexto no se pierde", [t.alerta(1).contexto.motivo, t.alerta(1).contexto.razon_social], ["entrega", "Chef S.R.L. (411)"]);
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("segunda llamada (trigger repetido): no manda otra vez", t.outbox().length, 2);
}
// Sector con línea: "las dos"
{
  const t = armar({ d: der({ sector: "ambos" }), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("sector = personas y línea → 3 avisos", tels(t.outbox()), ["5491131180038", "5491131180063", "5491131181021"]);
}
// Defecto de la config (sin tocar el sector): un aviso de sector va a la línea compartida, UN mensaje
{
  const t = armar({ d: der({ sector: CONFIG_WA_DEFECTO.sector }), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("defecto: el sector recibe UN aviso, en su línea", tels(t.outbox()), ["5491131181021"]);
}
// Números adicionales
{
  const t = armar({ d: der({ extra: [{ nombre: "Thomas", telefono: "5491162570000" }] }), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("el número adicional recibe también (y va con su nombre)", [tels(t.outbox()).includes("5491162570000"), t.outbox().find((r) => r.phone === "5491162570000")?.template_params["1"]], [true, "Thomas"]);
}
// Sin detalle
{
  const t = armar({ d: der({ con_detalle: false }), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "entrega", razon_social: "X", texto_recibido: "algo privado" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("con_detalle apagado: 'ver en Planify' y no el texto del cliente", t.outbox()[0].template_params["4"], "ver en Planify");
}
// Sin nombre de cliente: usa el teléfono; sin texto: 'ver en Planify'
{
  const t = armar({ d: der(), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "entrega" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("cliente sin nombre → su teléfono; sin texto → ver en Planify", [t.outbox()[0].template_params["3"], t.outbox()[0].template_params["4"]], ["+5491199990000", "ver en Planify"]);
}

// ── Motivos que no van a Planify ──
{
  const t = armar({ d: der(), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "cambio_datos", razon_social: "X", texto: "Cambiar el mail a a@b.com" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("cambio de mail (sólo Tareas) avisa igual: es un dato sensible", tels(t.outbox()), ["5491131180038", "5491131180063"]);
}
{
  const t = armar({ d: der(), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "faq_no_match", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("un motivo sólo-Tareas y no sensible no avisa", t.outbox().length, 0);
}
{
  const t = armar({ d: der(), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "faq_no_match", razon_social: "X", urgente: true })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("lo urgente avisa aunque el motivo no lo haga (a la persona por defecto)", tels(t.outbox()), ["5491131180064"]);
}
{
  const t = armar({ d: der({ urgentes_siempre: false }), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "faq_no_match", razon_social: "X", urgente: true })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("urgentes_siempre apagado: no avisa", t.outbox().length, 0);
}
{
  const t = armar({ d: der({}, { entrega: regla({ department_id: 8, wa: "off" }) }), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("motivo en 'Sin WhatsApp' (no urgente): no avisa", t.outbox().length, 0);
}
{
  const t = armar({ d: der({}, { entrega: regla({ department_id: 8, wa: "escalada" }) }), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("motivo sólo 'si nadie lo toma': al nacer no manda nada", t.outbox().length, 0);
}

// ── Lo que nunca avisa ──
for (const [nombre, a, d] of [
  ["función apagada", alerta(1, { motivo: "entrega", razon_social: "X" }), der({ activo: false })],
  ["tarea de prueba del Simulador", alerta(1, { motivo: "entrega", razon_social: "X", simulador: true }), der()],
  ["número fuera de la lista (whitelist_gate)", alerta(1, { motivo: "entrega" }, { tipo: "whitelist_gate" }), der()],
] as Array<[string, Fila, Derivaciones]>) {
  const t = armar({ d, ahora: miercoles("10:05"), alertas: [a] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual(`${nombre}: no avisa`, t.outbox().length, 0);
}
{
  const t = armar({ d: der(), ahora: miercoles("10:05"), alertas: [] });
  callar(); await avisarAlCrear(t.io, 99); hablar();
  igual("alerta que no existe: no hace nada ni falla", t.outbox().length, 0);
}

// ── Llave en prueba: un solo aviso, a la persona de prueba ──
{
  const t = armar({ d: der(), ahora: miercoles("10:05"), produccion: false, alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("prueba: un solo aviso, al teléfono de la persona de prueba (se normaliza)", tels(t.outbox()), ["5491131180064"]);
}

// ── Tope por hora ──
{
  const previos = Array.from({ length: 20 }, () => ({ phone: "5491131180038", context: "aviso_equipo_inm", created_at: miercoles("09:30").toISOString() }));
  const t = armar({ d: der(), ahora: miercoles("10:05"), outbox: previos, alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("un número que ya recibió 20 en la última hora no recibe otro", tels(t.outbox().slice(20)), ["5491131180063"]);
  igual("el omitido queda anotado en la alerta", t.alerta(1).contexto.wa_aviso.omit, ["5491131180038"]);
}
{
  const previos = Array.from({ length: 20 }, () => ({ phone: "5491131180038", context: "aviso_equipo_inm", created_at: miercoles("08:00").toISOString() }));
  const t = armar({ d: der(), ahora: miercoles("10:05"), outbox: previos, alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("los avisos de hace más de una hora no cuentan para el tope", tels(t.outbox().slice(20)), ["5491131180038", "5491131180063"]);
}

// ── Sólo en horario ──
{
  const t = armar({ d: der({ solo_horario: true }), ahora: miercoles("20:00"), alertas: [alerta(1, { motivo: "entrega", razon_social: "X" }, { created_at: miercoles("20:00").toISOString() })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  igual("fuera de horario con solo_horario: no manda y queda esperando", [t.outbox().length, t.alerta(1).contexto.wa_aviso], [0, { dif: true }]);
  t.io.ahora = () => miercoles("22:00");
  callar(); const r1 = await escalar(t.io); hablar();
  igual("el sync de la noche sigue esperando", [t.outbox().length, r1.diferidas], [0, 0]);
  t.io.ahora = () => jueves("09:10");
  callar(); const r2 = await escalar(t.io); hablar();
  igual("a la mañana siguiente sale el aviso que esperaba", [tels(t.outbox()), r2.diferidas], [["5491131180038", "5491131180063"], 1]);
  igual("y se limpia la marca de espera", t.alerta(1).contexto.wa_aviso.dif, undefined);
  callar(); await escalar(t.io); hablar();
  igual("no se repite", t.outbox().length, 2);
}

// ── Escalada: nadie toma el aviso ──
{
  const a = alerta(1, { motivo: "pago", razon_social: "Capo SA (4210)", texto_recibido: "consulta por el recibo", urgente: false });
  const t = armar({ d: der(), ahora: miercoles("11:30"), alertas: [a] });
  callar(); const r0 = await escalar(t.io); hablar();
  igual("antes de vencer (🟡 = 2 h, creada 10:00): no escala", [t.outbox().length, r0.escaladas], [0, 0]);
  t.io.ahora = () => miercoles("12:30");
  callar(); const r1 = await escalar(t.io); hablar();
  igual("vencida y sin tomar: escala una vez, a Cobranzas", [tels(t.outbox()), r1.escaladas], [["5491131180071"], 1]);
  const f = t.outbox()[0];
  igual("plantilla 'sin tomar' con el tiempo transcurrido", [f.template_name, f.context, f.template_params], ["aviso_equipo_sin_tomar", "aviso_equipo_esc", { "1": "2 h 30 min", "2": "Pago o importe", "3": "Capo SA (4210)", "4": "consulta por el recibo" }]);
  igual("queda anotado", t.alerta(1).contexto.wa_aviso, { esc: ["5491131180071"] });
  callar(); await escalar(t.io); hablar();
  igual("no vuelve a escalar", t.outbox().length, 1);
}
{
  const t = armar({ d: der(), ahora: miercoles("13:00"), alertas: [alerta(1, { motivo: "pago", razon_social: "X", tomada_por: "Ana", urgente: false })] });
  callar(); await escalar(t.io); hablar();
  igual("si alguien se encargó ('Me encargo yo'), no escala", t.outbox().length, 0);
}
{
  const t = armar({ d: der(), ahora: miercoles("13:00"), alertas: [alerta(1, { motivo: "pago", razon_social: "X", urgente: false }, { estado: "atendido" })] });
  callar(); await escalar(t.io); hablar();
  igual("una alerta ya atendida no escala", t.outbox().length, 0);
}
{
  const t = armar({ d: der(), ahora: miercoles("13:00"), alertas: [alerta(1, { motivo: "pago", razon_social: "X", simulador: true, urgente: false })] });
  callar(); await escalar(t.io); hablar();
  igual("una tarea de prueba no escala", t.outbox().length, 0);
}
{
  const t = armar({ d: der({ max_edad_h: 24 }), ahora: new Date("2026-10-09T12:00:00-03:00"), alertas: [alerta(1, { motivo: "pago", razon_social: "X", urgente: false })] });
  callar(); const r = await escalar(t.io); hablar();
  igual("más vieja que max_edad_h: ni se mira", [t.outbox().length, r.revisadas], [0, 0]);
}
{
  const t = armar({ d: der({ activo: false }), ahora: miercoles("13:00"), alertas: [alerta(1, { motivo: "pago", razon_social: "X", urgente: false })] });
  callar(); const r = await escalar(t.io); hablar();
  igual("función apagada: no escala", [t.outbox().length, r.activo], [0, false]);
}
{
  const t = armar({ d: der({ escalada_min: { rojo: null, amarillo: 30, verde: null } }), ahora: miercoles("10:40"), alertas: [alerta(1, { motivo: "pago", razon_social: "X", urgente: false })] });
  callar(); const r = await escalar(t.io); hablar();
  igual("escalada_min del panel pisa el tiempo del semáforo (30 min)", [t.outbox().length, r.escaladas], [1, 1]);
}
{
  // modo 'ambos' en un motivo que ya avisó al nacer: el sync también escala si nadie lo toma
  const t = armar({ d: der(), ahora: miercoles("10:05"), alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  callar(); await avisarAlCrear(t.io, 1); hablar();
  t.io.ahora = () => miercoles("12:30");
  callar(); const r = await escalar(t.io); hablar();
  igual("'Nace y escala': avisó al nacer y vuelve a avisar si nadie lo toma", [t.outbox().filter((x) => x.context === "aviso_equipo_inm").length, t.outbox().filter((x) => x.context === "aviso_equipo_esc").length, r.escaladas], [2, 2, 1]);
}
{
  const t = armar({ d: der(), ahora: miercoles("12:30"), alertas: [alerta(1, { motivo: "pago", razon_social: "X", urgente: false }), alerta(2, { motivo: "pago", razon_social: "Y", urgente: false }, { tipo: "whitelist_gate" })] });
  callar(); const r = await escalar(t.io); hablar();
  igual("whitelist_gate nunca escala", [t.outbox().map((x) => x.ref_id), r.escaladas], [["alerta-1"], 1]);
}

// ── Fallas: Gestión no contesta / la cola rechaza ──
{
  const t = armar({ d: der(), ahora: miercoles("10:05"), planifyCae: true, alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  let error = ""; callar();
  try { await avisarAlCrear(t.io, 1); } catch (e) { error = (e as Error).message; }
  hablar();
  igual("Gestión caída: el error sube (el que llama lo atrapa) y no se manda nada", [error, t.outbox().length], ["Gestión no contesta", 0]);
  igual("queda marcado para reintentar en el próximo sync", t.alerta(1).contexto.wa_aviso, { dif: true });
  const ok = armar({ d: der(), ahora: miercoles("10:15"), alertas: [t.alerta(1)] });
  callar(); const r = await escalar(ok.io); hablar();
  igual("el próximo sync, con Gestión de vuelta, lo manda", [tels(ok.outbox()), r.diferidas], [["5491131180038", "5491131180063"], 1]);
}
{
  const t = armar({ d: der(), ahora: miercoles("10:05"), fallaInsert: "wa_outbox", alertas: [alerta(1, { motivo: "entrega", razon_social: "X" })] });
  let error = ""; callar();
  try { await avisarAlCrear(t.io, 1); } catch (e) { error = (e as Error).message; }
  hablar();
  igual("la cola rechaza: el error sube y queda marcado para reintentar", [error, t.alerta(1).contexto.wa_aviso], ["wa_outbox: falló el insert", { dif: true }]);
}
{
  const t = armar({ d: der(), ahora: miercoles("12:30"), fallaInsert: "wa_outbox", alertas: [alerta(1, { motivo: "pago", razon_social: "X", urgente: false }), alerta(2, { motivo: "pago", razon_social: "Y", urgente: false })] });
  const errorOriginal = console.error; console.error = () => {};
  callar(); const r = await escalar(t.io); hablar(); console.error = errorOriginal;
  igual("si falla una escalada no se da por hecha (se reintenta) y las demás se siguen intentando", [r.errores, r.escaladas, t.alerta(1).contexto.wa_aviso], [2, 0, undefined]);
}

if (fallas) { console.error(`\n${fallas} prueba(s) fallaron`); Deno.exit(1); }
console.log("\ntodas las pruebas pasaron");
