import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getGestionClient, supabase } from "../_shared/supabase.ts";
import { CATEGORIAS, categoria, nivel, SEMAFORO, urgente } from "../_shared/alertas-vencimiento.ts";
import { derivaciones, destinosDe } from "../_shared/derivaciones.ts";
import type { Dest } from "../_shared/derivaciones-destino.ts";
import { alertaAtendida, contextoConTareas, idsDeTareas, quienTomo, trozos } from "../_shared/tareas-alerta.ts";
const CATEGORIAS_LABEL = (c: string) => CORTO[c] ?? CATEGORIAS[c]?.label ?? c;

// lk_alerta-planify — cada alerta que necesita a una persona se vuelve TAREA en Planify.
// Pedido de Pablo Olejavetzky (28/09). Planify vive en el proyecto de Gestión (schema planify);
// se escribe con las credenciales de Gestión que ya usa el bot (isis_supabase_*).
//
//   {alerta_id}                 → crea la tarea (lo llama el trigger alerta_a_planify, sql/077)
//   {action:"cerrar", alerta_id} → done=true en Planify (lo llama lk_alertas al marcar atendida/descartada)
//   {action:"sync"}             → alertas abiertas cuya tarea ya no está o está hecha → atendidas
//                                 (la app de Planify BORRA la fila al cerrar). Lo llama lk_fallas-mail.
// Sólo x-lk-secret (LK_FN_CRON_SECRET). A quién va cada motivo: Configuración › Derivaciones
// (app_settings.wa_derivaciones, ver _shared/derivaciones.ts); base vieja en app_settings.wa_alertas_planify:
//   {"employee_id": 64, "categorias": ["escalation", …], "department_id"?: 8, "broadcast"?: true}.
//   Id de la tarea → contexto.planify_task_id (la primera). Con varios destinos (06/10, "también a" en Derivaciones) cada destino abre SU
//   tarea para la misma alerta: ids en contexto.planify_task_ids, y la alerta se da por atendida cuando se cierran TODAS (_shared/tareas-alerta.ts).
// Cartel (Pablo, 28/09): las tareas salen con broadcast=true → Planify abre el aviso centrado que no se
// cierra con la ✕ y tiene "✋ Me encargo yo" (planify_claim_task). Sólo con sector (ej. 8 Ventas) le aparece a todo
// el sector y gana el primero; con persona elegida (sola o dentro de un sector), a esa persona (06/10: la persona gana).
// Destino según la llave de envío (Pablo, 28/09): en prueba (wa_envio_automatico ≠ '1') va SIEMPRE a
// employee_id (quien desarrolla); en producción ('1') ver destino() en _shared/derivaciones-destino.ts.
// Semáforo en el nombre: 🔴 / 🟡 / 🟢 (ver nivel() en _shared/alertas-vencimiento.ts).

const SECRET_NAME = "LK_FN_CRON_SECRET";
const TZ = "America/Argentina/Buenos_Aires";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function esLlamadaInterna(req: Request): Promise<boolean> {
  const recibido = req.headers.get("x-lk-secret") ?? "";
  if (!recibido) return false;
  let esperado = Deno.env.get(SECRET_NAME) ?? "";
  if (!esperado) {
    const { data } = await supabase.rpc("krikos_secret", { p_name: SECRET_NAME });
    esperado = typeof data === "string" ? data : "";
  }
  return esperado.length > 0 && recibido === esperado;
}

// Nombre corto para la tarea (el nombre entero va hasta 60 caracteres).
const CORTO: Record<string, string> = {
  escalation: "Pide hablar con alguien",
  cliente_molesto: "Cliente molesto",
  respuesta_aviso_cambio: "Cambio de pedido",
  alta_cliente: "Alta de cliente",
  comprobante_recibido: "Comprobante recibido",
  comprobante_error: "Comprobante con error",
  consulta_stock: "Consulta sin stock",
  reclamo: "Reclamo",
  pago: "Pago o importe",
  cambio_pedido: "Cambio de pedido",
  anulacion_pedido: "Anulación de pedido",
  pedido_no_encontrado: "Pedido que no aparece",
  entrega: "Consulta de entrega",
  cambio_datos: "Dirección nueva",
  pedido_archivo: "Pedido por archivo",
  pedido_whatsapp: "Pedido por WhatsApp",
  cliente_chef: "Cliente de Chef",
  devolucion: "Devolución de mercadería",
  pedido_mail: "Pedido enviado por mail",
  nota_cliente: "Nota del cliente",
  tope_ia: "Cliente pasó el tope de consultas",
};

const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, ...o }).format(d);

async function crear(alertaId: number) {
  // A dónde va: Configuración › Derivaciones (_shared/derivaciones.ts). Se lee antes de categoria() porque
  // registra los motivos agregados desde el panel.
  const der = await derivaciones();
  const { data: a } = await supabase.from("wa_alertas_humano")
    .select("id, tipo, phone, customer_id, contexto, estado, created_at").eq("id", alertaId).maybeSingle();
  if (!a) return { ok: false, error: "alerta no encontrada" };
  const cat = categoria(a);
  const esUrg = urgente(a);
  const niv = nivel(a);
  const { data: llaveRow } = await supabase.from("app_settings").select("value").eq("key", "wa_envio_automatico").maybeSingle();
  const produccion = llaveRow?.value === "1";
  // Lo urgente va siempre a Planify.
  // Tareas del Simulador (🧪): siempre como en modo prueba, a quien desarrolla, aunque la llave esté en producción.
  const dests = destinosDe(der, cat, esUrg, produccion && a.contexto?.simulador !== true);
  if (!dests.length) return { ok: true, creada: false, motivo: `categoría ${cat} sólo va a Tareas (o sin destinatario)` };
  const ctx = a.contexto ?? {};
  const yaIds = idsDeTareas(ctx);
  if (yaIds.length >= dests.length) return { ok: true, creada: false, motivo: "ya tenía tarea" };

  let cliente = String(ctx.razon_social ?? "");
  // Cliente de Chef (sql/115): sin customer_id; el código es de Chef y se aclara para no confundirlo con uno de LK.
  if (ctx.empresa === "CH") cliente = `${cliente || "sin razón social"} (Chef ${String(ctx.cod_cliente_chef ?? "")})`.trim();
  else if (a.customer_id) {
    const { data: c } = await supabase.from("customers").select("cod_cliente, business_name").eq("id", a.customer_id).maybeSingle();
    if (c) cliente = `${c.business_name} (${c.cod_cliente})`;
  }
  let pedido = "";
  if (Number(ctx.pedido) > 0) {
    const { data: o } = await supabase.from("orders").select("created_at").eq("id", Number(ctx.pedido)).maybeSingle();
    if (o?.created_at) pedido = `pedido del ${fmt(new Date(o.created_at), { day: "2-digit", month: "2-digit" }).split("-").reverse().join("/")}`;
  }
  const texto = String(ctx.texto_recibido ?? ctx.texto ?? "").trim();
  const nombre = `${ctx.simulador === true ? "🧪 " : ""}${SEMAFORO[niv]} ${CORTO[cat] ?? cat} — ${cliente || a.phone || "sin identificar"}`.slice(0, 60);
  // Nota en el formato que lee el cartel de Planify (src/alarm-broadcast.html): "Clave: valor" por línea,
  // "Aviso:" = encabezado, "Charla:" = link del botón "💬 Abrir la charla" (no se muestra como dato) y el
  // marcador [vbot:<alerta>|<nivel>|<tel>] al final → Planify lo pinta con el color del semáforo.
  const tel = String(a.phone ?? "").replace(/\D/g, "");
  const ETIQUETA: Record<string, string> = { rojo: "🔴 URGENTE", amarillo: "🟡 CONTESTAR PRONTO", verde: "🟢 PUEDE ESPERAR" };
  const planify = await getGestionClient("planify");
  // Con varios destinos cada tarea dice a quién va ("Para:"): si no, dos carteles iguales no se distinguen. Con uno solo no se agrega nada.
  const multi = dests.length > 1;
  const etiquetas = multi ? await nombresDeDestinos(planify, dests.map((x) => x.real)) : new Map<string, string>();
  const notaDe = (d: (typeof dests)[number]) => [
    `Aviso: CLIENTE ESPERANDO — ${ETIQUETA[niv]}`,
    `Cliente: ${cliente || "sin identificar"}`,
    `Motivo: ${CATEGORIAS_LABEL(cat)}`,
    multi ? `Para: ${etiquetaDe(d.real, etiquetas)}${JSON.stringify(d.asignar) !== JSON.stringify(d.real) ? " (en prueba: te llega a vos)" : ""}` : "",
    texto ? `Escribió: "${texto.slice(0, 160)}"` : "",
    pedido ? `Pedido: ${pedido.replace(/^pedido /, "")}` : "",
    tel ? `Teléfono: +${tel}` : "",
    tel ? `Charla: https://loekemeyer.github.io/GestOpClientes/?charla=${tel}` : "",
    `[vbot:${a.id}|${niv}|${tel}]`,
  ].filter(Boolean).join("\n");

  const ahora = new Date(a.created_at);
  // Una tarea por destino, el principal primero. Si una falla se guardan las ya creadas (reintentar completa las que faltan, ver arriba).
  const ids = [...yaIds];
  let fallo: string | null = null;
  for (const d of dests.slice(yaIds.length)) {
    const { data: t, error } = await planify.from("tasks").insert({
      name: nombre, type: "tarea", prio: esUrg ? "urgente" : "normal",
      time: fmt(ahora, { hour: "2-digit", minute: "2-digit", hour12: false }),
      date: fmt(ahora, { year: "numeric", month: "2-digit", day: "2-digit" }),
      note: notaDe(d), rec: "none", done: false,
      ...("department_id" in d.asignar
        ? { assignment_type: "department", department_id: d.asignar.department_id, employee_id: null }
        : { assignment_type: "employee", employee_id: d.asignar.employee_id, department_id: null }),
      system_generated: false, broadcast: der.broadcast,
    }).select("id").single();
    if (error) { fallo = error.message; break; }
    ids.push(t.id);
  }
  if (ids.length > yaIds.length) {
    await supabase.from("wa_alertas_humano").update({ contexto: contextoConTareas(ctx, ids) }).eq("id", a.id);
    console.log(`lk_alerta-planify: alerta ${a.id} → ${ids.length > 1 ? `${ids.length} tareas ${ids.join(", ")}` : `tarea ${ids[0]}`} (${nombre})`);
  }
  if (fallo) return { ok: false, error: fallo, creadas: ids.length - yaIds.length, task_ids: ids };
  return { ok: true, creada: true, task_id: ids[0], task_ids: ids };
}

// Nombres de los destinos para la línea "Para:" (personas de employees, sectores de departments). Si Gestión no contesta, queda el número.
async function nombresDeDestinos(planify: Awaited<ReturnType<typeof getGestionClient>>, reales: Array<Dest | null>): Promise<Map<string, string>> {
  const emps = [...new Set(reales.flatMap((x) => (x && "employee_id" in x ? [x.employee_id] : [])))];
  const deps = [...new Set(reales.flatMap((x) => (x && "department_id" in x ? [x.department_id] : [])))];
  const m = new Map<string, string>();
  try {
    const [e, d] = await Promise.all([
      emps.length ? planify.from("employees").select("id, nombre").in("id", emps) : { data: [] },
      deps.length ? planify.from("departments").select("id, nombre").in("id", deps) : { data: [] },
    ]);
    for (const x of (e.data ?? []) as Array<{ id: number; nombre: string }>) m.set(`e${x.id}`, x.nombre);
    for (const x of (d.data ?? []) as Array<{ id: number; nombre: string }>) m.set(`d${x.id}`, x.nombre);
  } catch (err) { console.error("lk_alerta-planify: no pude leer los nombres de los destinos", err); }
  return m;
}
const etiquetaDe = (x: Dest | null, nombres: Map<string, string>) => !x ? "quien esté por defecto"
  : "employee_id" in x ? (nombres.get(`e${x.employee_id}`) ?? `persona #${x.employee_id}`) : `sector ${nombres.get(`d${x.department_id}`) ?? `#${x.department_id}`}`;

async function cerrar(alertaId: number) {
  const { data: a } = await supabase.from("wa_alertas_humano").select("contexto").eq("id", alertaId).maybeSingle();
  const ids = idsDeTareas(a?.contexto); // todas las tareas de la alerta, no sólo la primera
  if (!ids.length) return { ok: true, cerrada: false };
  const planify = await getGestionClient("planify");
  const { error } = await planify.from("tasks").update({ done: true, updated_at: new Date().toISOString() }).in("id", ids);
  return error ? { ok: false, error: error.message } : { ok: true, cerrada: true, task_id: ids[0], task_ids: ids };
}

async function sync() {
  const { data: abiertas } = await supabase.from("wa_alertas_humano")
    .select("id, contexto").in("estado", ["pendiente", "notificado"]).not("contexto->planify_task_id", "is", null).limit(500);
  const alertas = (abiertas ?? []).map((a) => ({ a, ids: idsDeTareas(a.contexto) })).filter((x) => x.ids.length);
  const ids = [...new Set(alertas.flatMap((x) => x.ids))];
  if (!ids.length) return { ok: true, atendidas: 0 };
  const planify = await getGestionClient("planify");
  // Con varios destinos por alerta pueden ser miles de ids: el `in (…)` va en la URL, así que se pide por tandas.
  const tareas: Array<{ id: number; done: boolean; claimed_by_nombre: string | null }> = [];
  for (const tanda of trozos(ids, 200)) {
    const { data, error } = await planify.from("tasks").select("id, done, claimed_by_nombre").in("id", tanda);
    if (error) return { ok: false, error: error.message };
    tareas.push(...(data ?? []));
  }
  // "✋ Me encargo yo" en el cartel de Planify → la alerta muestra quién la tomó (con varios destinos, los nombres de cada uno).
  const tomo = new Map(tareas.filter((t) => t.claimed_by_nombre).map((t) => [t.id, t.claimed_by_nombre as string]));
  for (const { a, ids: suyas } of alertas) {
    const quien = quienTomo(suyas, tomo);
    if (quien && a.contexto?.tomada_por !== quien) {
      await supabase.from("wa_alertas_humano").update({ contexto: { ...a.contexto, tomada_por: quien } }).eq("id", a.id);
    }
  }
  // Atendida = ninguna de sus tareas sigue abierta (hecha, o borrada: la app de Planify borra la fila al cerrar).
  const abiertasPlanify = new Set(tareas.filter((t) => !t.done).map((t) => t.id));
  const cerrar = alertas.filter((x) => alertaAtendida(x.ids, abiertasPlanify)).map((x) => x.a.id);
  if (cerrar.length) {
    await supabase.from("wa_alertas_humano")
      .update({ estado: "atendido", atendido_por: "planify", atendido_at: new Date().toISOString() })
      .in("id", cerrar).in("estado", ["pendiente", "notificado"]);
  }
  return { ok: true, atendidas: cerrar.length };
}

serve(async (req) => {
  try {
    if (!(await esLlamadaInterna(req))) return json({ error: "no autorizado" }, 401);
    const body = await req.json().catch(() => ({}));
    if (body.action === "sync") return json(await sync());
    const id = Number(body.alerta_id);
    if (!id) return json({ error: "falta alerta_id" }, 400);
    if (body.action === "cerrar") return json(await cerrar(id));
    return json(await crear(id));
  } catch (err) {
    console.error("lk_alerta-planify error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
