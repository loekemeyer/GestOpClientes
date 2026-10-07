// Aviso por WhatsApp al equipo: la parte que toca la base (Pablo Olejavetzky, 07/10/2026). La decisión de a quién y cuándo es pura y vive en aviso-equipo.ts;
// acá se lee la alerta, se resuelven los teléfonos en Planify, se encola en wa_outbox y se anota el estado en la alerta. Lo llama lk_alerta-planify.
// Las dependencias entran por `Io` (la base de PaginaLK, la de Planify, la config, el reloj): así se prueba con una base falsa en tests/aviso-equipo-envio.test.ts
// sin red. NO manda nada a Meta: encola una plantilla y la despacha lk_outbox-flush, que pasa por la llave wa_envio_automatico.
import type { Derivaciones } from "./derivaciones.ts";
import type { Dest } from "./derivaciones-destino.ts";
import { destinosDeAviso } from "./derivaciones-destino.ts";
import { categoria, nivel, tiempoDeNivel, urgente } from "./alertas-vencimiento.ts";
import { dentroDeHorario, horarioEfectivo } from "./horario.ts";
import {
  aplicarTope, avisaAlNacer, CONFIG_WA_DEFECTO, type ConfigWa, CONTEXTO_ESC, CONTEXTO_INM, contextoConEstadoWa, debeEscalar, debeInmediatoDiferido, destinatarios,
  duracionTexto, escaladaVence, type EstadoWa, leerEstadoWa, modoDeMotivo, PLANTILLA_AVISO, PLANTILLA_SIN_TOMAR, type Persona, paramsEscalada, paramsInmediato, type Sector,
  sinAvisar,
} from "./aviso-equipo.ts";

// deno-lint-ignore no-explicit-any
export type Db = { from: (tabla: string) => any };
export type FilaAlerta = { id: number; tipo: string; phone: string | null; customer_id: string | null; contexto: Record<string, unknown> | null; estado: string; created_at: string };
export const COLUMNAS_ALERTA = "id, tipo, phone, customer_id, contexto, estado, created_at";

export type Io = {
  /** Base de PaginaLK (wa_alertas_humano, wa_outbox). */
  db: Db;
  /** Base de Gestión, schema planify (employees, departments). Puede lanzar si Gestión no contesta. */
  planify: () => Promise<Db>;
  derivaciones: (usarCache?: boolean) => Promise<Derivaciones>;
  /** Feriados de Planify (para saber si es horario de atención). */
  calendario: () => Promise<unknown>;
  /** Vuelca semáforos, tiempos, horario y feriados (vencimientos()). */
  registrar: () => Promise<unknown>;
  /** Nombre del cliente de la alerta ("" si no se sabe). */
  cliente: (a: FilaAlerta) => Promise<string>;
  /** ¿La llave wa_envio_automatico está en producción ('1')? */
  produccion: () => Promise<boolean>;
  /** Texto corto del motivo para el aviso. */
  motivo: (cat: string) => string;
  ahora?: () => Date;
};
const reloj = (io: Io) => (io.ahora ?? (() => new Date()))();

// Personas (con teléfono) y sectores de Planify que hacen falta para resolver los destinos. Si Gestión no contesta, lanza: el que llama lo atrapa.
export async function personasYSectores(io: Io, blancos: Dest[]): Promise<{ personas: Persona[]; sectores: Sector[] }> {
  const planify = await io.planify();
  const emps = [...new Set(blancos.flatMap((x) => ("employee_id" in x ? [x.employee_id] : [])))];
  const deps = [...new Set(blancos.flatMap((x) => ("department_id" in x ? [x.department_id] : [])))];
  const cols = "id, nombre, telefono, department_id, activo";
  const [e, d, enSector] = await Promise.all([
    emps.length ? planify.from("employees").select(cols).in("id", emps) : { data: [], error: null },
    deps.length ? planify.from("departments").select("id, nombre, telefono").in("id", deps) : { data: [], error: null },
    deps.length ? planify.from("employees").select(cols).in("department_id", deps).eq("activo", true) : { data: [], error: null },
  ]);
  const error = e.error ?? d.error ?? enSector.error;
  if (error) throw new Error("Planify: " + error.message);
  const personas = new Map<number, Persona>();
  for (const p of [...(e.data ?? []), ...(enSector.data ?? [])] as Persona[]) personas.set(p.id, p);
  return { personas: [...personas.values()], sectores: (d.data ?? []) as Sector[] };
}

/** Encola el aviso de una fase ("inm" = apenas nace, "esc" = nadie lo tomó) para los destinatarios que todavía no lo recibieron. Anota el estado en la alerta. */
export async function mandarAviso(io: Io, a: FilaAlerta, fase: "inm" | "esc", der: Derivaciones, cfg: ConfigWa, produccion: boolean) {
  const ctx = a.contexto ?? {};
  const cat = categoria(a);
  const blancos = destinosDeAviso(der, cat, produccion);
  const st = leerEstadoWa(ctx);
  const guardar = async (nuevo: EstadoWa) => {
    // Se relee el contexto justo antes de escribir: entre medio el sync pudo anotar quién tomó la tarea.
    const { data: f } = await io.db.from("wa_alertas_humano").select("contexto").eq("id", a.id).maybeSingle();
    await io.db.from("wa_alertas_humano").update({ contexto: contextoConEstadoWa(f?.contexto ?? ctx, nuevo) }).eq("id", a.id);
  };
  let dest: ReturnType<typeof destinatarios>;
  try {
    const { personas, sectores } = await personasYSectores(io, blancos);
    dest = destinatarios(blancos, personas, sectores, cfg);
  } catch (e) {
    // Gestión no contestó: no se da por hecho. El inmediato queda "esperando" (el próximo sync lo reintenta) y la escalada no se marca.
    if (fase === "inm") await guardar({ ...st, dif: true });
    throw e;
  }
  const nuevos = sinAvisar(dest.lista, fase === "inm" ? st.inm : st.esc);
  // Tope por hora a cada número (corta una ráfaga). Cuenta lo que la cola ya tiene de estos avisos en la última hora.
  const previos: Record<string, number> = {};
  if (nuevos.length) {
    const { data } = await io.db.from("wa_outbox").select("phone").in("context", [CONTEXTO_INM, CONTEXTO_ESC])
      .gte("created_at", new Date(reloj(io).getTime() - 3_600_000).toISOString()).in("phone", nuevos.map((x) => x.telefono)).limit(1000);
    for (const p of (data ?? []) as Array<{ phone: string }>) previos[p.phone] = (previos[p.phone] ?? 0) + 1;
  }
  const { enviar, omitidos } = aplicarTope(nuevos, previos, cfg.tope_hora);
  const tel = String(a.phone ?? "").replace(/\D/g, "");
  const datos = {
    etiqueta: "", motivo: io.motivo(cat), cliente: (await io.cliente(a)) || (tel ? "+" + tel : "sin identificar"),
    detalle: String(ctx.texto_recibido ?? ctx.texto ?? "").trim() || null, hace: duracionTexto(reloj(io).getTime() - new Date(a.created_at).getTime()),
  };
  if (enviar.length) {
    const { error } = await io.db.from("wa_outbox").insert(enviar.map((x) => ({
      phone: x.telefono, context: fase === "inm" ? CONTEXTO_INM : CONTEXTO_ESC, ref_id: `alerta-${a.id}`, // ref_id con letras: el despacho trata un número solo como "pedido"
      template_name: fase === "inm" ? PLANTILLA_AVISO : PLANTILLA_SIN_TOMAR,
      template_params: fase === "inm" ? paramsInmediato({ ...datos, etiqueta: x.etiqueta }, cfg) : paramsEscalada(datos, cfg),
    })));
    if (error) {
      if (fase === "inm") await guardar({ ...st, dif: true }); // el próximo sync lo reintenta
      throw new Error("wa_outbox: " + error.message);
    }
  }
  const nuevoSt: EstadoWa = { ...st, [fase]: [...(fase === "inm" ? st.inm : st.esc) ?? [], ...enviar.map((x) => x.telefono)] };
  if (fase === "inm") delete nuevoSt.dif;
  if (omitidos.length) nuevoSt.omit = [...new Set([...(st.omit ?? []), ...omitidos.map((x) => x.telefono)])];
  if (dest.sin_telefono.length) nuevoSt.sin_tel = dest.sin_telefono;
  await guardar(nuevoSt);
  console.log(`lk_alerta-planify: aviso WhatsApp (${fase === "inm" ? "apenas nace" : "nadie lo tomó"}) alerta ${a.id} → ${enviar.length} destinatario(s)` +
    (omitidos.length ? `, ${omitidos.length} omitido(s) por el tope` : "") + (dest.sin_telefono.length ? `, sin teléfono: ${dest.sin_telefono.join(", ")}` : "") +
    (!enviar.length && !omitidos.length && !dest.sin_telefono.length ? " (sin destinatarios)" : ""));
  return { enviados: enviar.length, omitidos: omitidos.length, sin_telefono: dest.sin_telefono };
}

/** Lo que pasa al nacer la alerta: si su motivo avisa "apenas nace", se encola (o queda esperando la apertura si se pidió sólo en horario). */
export async function avisarAlCrear(io: Io, alertaId: number) {
  const der = await io.derivaciones(true);
  const cfg = der.wa ?? CONFIG_WA_DEFECTO;
  if (!cfg.activo) return;
  const { data } = await io.db.from("wa_alertas_humano").select(COLUMNAS_ALERTA).eq("id", alertaId).maybeSingle();
  const a = data as FilaAlerta | null;
  if (!a || a.tipo === "whitelist_gate" || a.contexto?.simulador === true) return; // las tareas de prueba 🧪 nunca avisan
  const cat = categoria(a);
  const regla = der.motivos[cat];
  const modo = modoDeMotivo(cfg, regla?.wa, cat, { planify: regla?.destino === "planify", urgente: urgente(a) });
  if (!avisaAlNacer(modo)) return;
  const st = leerEstadoWa(a.contexto);
  if (st.inm !== undefined) return; // ya avisó
  await io.calendario();
  if (cfg.solo_horario && !dentroDeHorario(reloj(io), horarioEfectivo())) {
    await io.db.from("wa_alertas_humano").update({ contexto: contextoConEstadoWa(a.contexto ?? {}, { ...st, dif: true }) }).eq("id", a.id);
    return;
  }
  await mandarAviso(io, a, "inm", der, cfg, await io.produccion());
}

/** Alertas abiertas: manda el aviso inmediato que esperaba la apertura y el "sin tomar" de las que vencieron sin que nadie se encargue. Lo llama el sync. */
export async function escalar(io: Io) {
  const der = await io.derivaciones();
  const cfg = der.wa ?? CONFIG_WA_DEFECTO;
  if (!cfg.activo) return { ok: true, activo: false, revisadas: 0, escaladas: 0, diferidas: 0, errores: 0 };
  await io.registrar(); // semáforos, tiempos, horario y feriados de Planify
  const ahora = reloj(io), h = horarioEfectivo();
  const { data } = await io.db.from("wa_alertas_humano").select(COLUMNAS_ALERTA)
    .in("estado", ["pendiente", "notificado"]).neq("tipo", "whitelist_gate")
    .gte("created_at", new Date(ahora.getTime() - cfg.max_edad_h * 3_600_000).toISOString()).order("created_at").limit(300);
  const produccion = await io.produccion();
  let escaladas = 0, diferidas = 0, errores = 0;
  for (const a of (data ?? []) as FilaAlerta[]) {
    if (a.contexto?.simulador === true) continue;
    try {
      const cat = categoria(a), niv = nivel(a);
      const regla = der.motivos[cat];
      const modo = modoDeMotivo(cfg, regla?.wa, cat, { planify: regla?.destino === "planify", urgente: urgente(a) });
      const estado = leerEstadoWa(a.contexto), creada = new Date(a.created_at);
      if (debeInmediatoDiferido({ ahora, creada, estado, cfg, h, modo })) { await mandarAviso(io, a, "inm", der, cfg, produccion); diferidas++; continue; }
      const vence = escaladaVence(creada, niv, cfg, tiempoDeNivel(niv), h);
      if (debeEscalar({ ahora, creada, vence, tomadaPor: a.contexto?.tomada_por, estado, cfg, h, modo })) { await mandarAviso(io, a, "esc", der, cfg, produccion); escaladas++; }
    } catch (e) { errores++; console.error(`lk_alerta-planify: aviso por WhatsApp de la alerta ${a.id} falló`, e); }
  }
  return { ok: true, activo: true, revisadas: data?.length ?? 0, escaladas, diferidas, errores };
}
