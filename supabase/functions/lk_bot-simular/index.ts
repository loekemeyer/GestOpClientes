import "../_shared/wa-guard.ts"; // D007: por las dudas — igual no manda nada (teléfono ficticio)
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getGestionClient, getIsisClient, getSetting, supabase } from "../_shared/supabase.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { SIM } from "../_shared/simulacion.ts";
import { pedidoDeCambio, responderAviso } from "../_shared/respuesta-aviso.ts";
import { atenderMalHumor } from "../_shared/humor.ts";
import { esSoloSaludo, handleFaq } from "../_shared/faq.ts";
import { leerPedidoArchivo, resolverArticulos, textoConfirmacion } from "../_shared/pedido-archivo.ts";
import { ALTA_INTRO, crearLead, extractCuit, getPendingLead, handleAltaStep, RE_ALTA_START } from "../_shared/alta.ts";
import { pedidoEnCurso, runConversation } from "../_shared/bot-conversation.ts";
import { atenderClienteChef } from "../_shared/chef.ts";
import { conEtiqueta, puertaMarca } from "../_shared/marca.ts";
import { PLANTILLAS, renderPlantilla } from "../_shared/plantillas-meta.ts";
import { PLANTILLAS_FACTURA } from "../_shared/plantillas-factura.ts";
import { AVISOS_DE_PEDIDO, avisoParaModo, type DatosPedido, fechaAR, fechaCorta, modoDe, modoTexto, paramsAviso } from "../_shared/aviso-pedido.ts";
import { armarDtoCfg, cuentasFactura, ddmm, diasDelPlazo, type FacMin, fmtARS, grupoDe, mapearPorTexto, metodoExcepcion, planMetodos,
  sumarDias } from "../_shared/factura-valores.ts";

// Botonera del Simulador: avisos de seguimiento + las 6 de factura (con el PDF de la factura en el mensaje).
// Pablo, 01/10: la botonera cambia con el tipo de cliente. Loekemeyer: seguimiento + 6 de factura; Chef: sus 6 de factura
// (el seguimiento de pedidos —recibido, programado, retiro…— es sólo de Loekemeyer).
type Aviso = { name: string; disparo: string; body: string; ejemplos: string[]; factura: boolean; varCliente: number; empresa: "LK" | "CH" };
const AVISOS: Aviso[] = [...PLANTILLAS.map((p) => ({ name: p.name, disparo: p.disparo, body: p.body, ejemplos: p.ejemplos, factura: false,
    // la variable que lleva la razón social (si la plantilla la tiene): ahí va el nombre del cliente simulado.
    varCliente: p.variables.findIndex((v) => /raz[oó]n social/i.test(v)),
    // comprobante_recibido_chef es de Chef (las demás de seguimiento, de Loekemeyer): se reconoce por el sufijo, como las de factura.
    empresa: (p.name.endsWith("_chef") ? "CH" : "LK") as "LK" | "CH" })),
  ...PLANTILLAS_FACTURA.map((p) => ({ name: p.name, disparo: p.disparo, body: p.body, ejemplos: p.ejemplos, factura: true, varCliente: -1,
    empresa: (p.empresa === "chef" ? "CH" : "LK") as "LK" | "CH" }))];
const rellenar = (body: string, vals: string[]) => body.replace(/\{\{(\d+)\}\}/g, (m, n) => vals[Number(n) - 1] ?? m);

/** El pedido web real con el que se arman los avisos de seguimiento (Pablo, 05/10): el que viene en el paso o, si no, el
 *  último que el cliente mandó desde la web. Mismas fuentes que los disparadores y que la Prueba de plantillas: orders,
 *  v_pedidos_web_np (dirección y expreso de Gestión), bot_estado_pedidos_gv (fecha de salida), wa_fecha_estimada
 *  (entrega estimada) y wa_metodo_pago_texto. Sólo lee. null si el cliente no tiene pedidos web. */
async function datosPedido(customerId: string, pedidoId: number | null): Promise<DatosPedido | null> {
  let q = supabase.from("orders").select("id, created_at, total, payment_method").eq("customer_id", customerId).eq("sheets_sent", true);
  q = pedidoId ? q.eq("id", pedidoId) : q.order("created_at", { ascending: false }).limit(1);
  const { data: o } = await q.maybeSingle();
  if (!o) return null;
  const [{ data: nps }, { data: est }, { data: fe }, { data: met }] = await Promise.all([
    supabase.from("v_pedidos_web_np").select("razon_social,direccion,localidad,nombre_expreso,retiro_fecha")
      .eq("empresa", "lk").eq("order_id", o.id).order("np_idx").limit(1),
    supabase.rpc("bot_estado_pedidos_gv", { p_ids: [o.id] }),
    supabase.from("wa_fecha_estimada").select("texto").eq("order_id", o.id).maybeSingle(),
    supabase.rpc("wa_metodo_pago_texto", { p: o.payment_method ?? "" }),
  ]);
  const np = nps?.[0];
  if (!np) return null;
  const modo = modoDe(np);
  let estimada: string | null = fe?.texto ?? null;
  if (!estimada) {
    // Pedidos de antes de la fecha estimada (sql/087) no tienen fila: se calcula igual (función de sólo lectura).
    const { data: calc } = await supabase.rpc("wa_fecha_estimada_calc", { p_order_id: o.id });
    estimada = calc?.[0]?.texto ?? null;
  }
  const fechaEntrega = est?.[0]?.fecha_entrega ?? null;
  return {
    order_id: Number(o.id), razon_social: String(np.razon_social ?? ""), pedido_el: fechaAR(o.created_at),
    salida: modo === "retira" ? (np.retiro_fecha ?? fechaEntrega) : fechaEntrega, modo,
    expreso: String(np.nombre_expreso ?? ""),
    // Igual que los avisos reales (sql/090 y 105): `direccion` ya trae la localidad; la localidad sola si no hay dirección.
    direccion: String(np.direccion ?? "").trim() || String(np.localidad ?? "").trim(),
    total_neto: o.total == null ? null : Number(o.total), metodo: typeof met === "string" ? met : null, estimada,
  };
}

/** El aviso de factura armado con las facturas reales del último día facturado del cliente (Pablo, 05/10). Mismas cuentas
 *  que el aviso real (lk_factura-check, vía _shared/factura-valores.ts): método de cada factura por su condición de venta
 *  (wa_metodo_norm de Gestión), excepciones por cliente, reglas de método mixto, descuentos y fechas al día hábil. Si
 *  ese día tiene facturas de otra forma de pago que la del botón, usa la plantilla que le llegaría. Sólo lee.
 *  null si el cliente no tiene facturas o el texto no se pudo completar. */
async function facturaReal(cod: number, tocado: string): Promise<{ nombre: string; vals: string[]; nota: string } | null> {
  const isis = await getIsisClient();
  const { data: docs, error } = await isis.from("documentos").select("fecha, total, condicion_venta, contraparte_cuit, contraparte_nombre")
    .eq("contraparte_codigo", String(cod)).eq("contraparte_tipo", "cliente").like("tipo", "FC%")
    .order("fecha", { ascending: false }).limit(30);
  if (error) throw new Error(error.message);
  if (!docs?.length) return null;
  const fecha = String(docs[0].fecha).slice(0, 10);
  const delDia = docs.filter((d: { fecha: string }) => String(d.fecha).slice(0, 10) === fecha);
  const g = await getGestionClient("public");
  const metodoDe = new Map<string, string>();
  const condiciones = new Set<string>(delDia.map((d: { condicion_venta: string | null }) => String(d.condicion_venta ?? "")));
  await Promise.all([...condiciones].map(async (cond) => {
    const { data } = await g.rpc("wa_metodo_norm", { p_cond: cond || null });
    metodoDe.set(cond, typeof data === "string" ? data : "no_decidido");
  }));
  // deno-lint-ignore no-explicit-any
  let cfgRaw: any = null;
  try { cfgRaw = JSON.parse((await getSetting("wa_descuentos_config")) ?? "null"); } catch { /* defaults */ }
  // El Simulador muestra el texto de plantillas-factura.ts (formato nuevo, con el % y el alias/CBU como variables).
  const cfg = armarDtoCfg(cfgRaw, "lk", "v2");
  const facturas: FacMin[] = delDia.map((d: { total: number; condicion_venta: string | null }) =>
    ({ total: Number(d.total || 0), metodo: metodoDe.get(String(d.condicion_venta ?? "")) ?? "no_decidido" }));
  const subgrupos = planMetodos(facturas, cfg, metodoExcepcion(cfg, delDia[0].contraparte_cuit, delDia[0].contraparte_nombre));
  const sub = subgrupos.find((s) => grupoDe(s.metodo) === grupoDe(tocado.replace(/^pedido_/, ""))) ?? subgrupos[0];
  const c = cuentasFactura(sub.metodo, sub.facturas.map((f) => f.total), cfg);
  const def = PLANTILLAS_FACTURA.find((p) => p.name === c.template);
  if (!def) return null;
  const habil = async (iso: string | null) => {
    if (!iso) return null;
    const { data } = await supabase.rpc("wa_proximo_habil", { p: iso });
    return typeof data === "string" ? data.slice(0, 10) : iso;
  };
  const limite = await habil(sumarDias(fecha, cfg.diasLimite));
  const dias = diasDelPlazo(c.label, sub.metodo);
  const plazo = dias !== null ? await habil(sumarDias(fecha, dias)) : null;
  const vals = mapearPorTexto(def.body, {
    total: fmtARS(c.total_sum), n: String(c.n), lista: c.lista, plazo: c.label, pct: c.grupo === "contado" ? c.contadoPct : c.metodoPct,
    montoCliente: fmtARS(c.montoCliente), montoContado: fmtARS(c.montoContado), fecha: limite ? ddmm(limite) : "", ahorro: fmtARS(c.ahorro),
    alias: cfg.alias, cbu: cfg.cbu, fechaPlazo: plazo ? ddmm(plazo) : "la fecha acordada",
  }, c.grupo);
  if (!vals) return null;
  const nota = [`factura real del ${ddmm(fecha)}: ${c.n === 1 ? "1 factura" : `${c.n} facturas`} por ${fmtARS(c.total_sum)} (${sub.metodo})`,
    c.template !== tocado ? `se usa ${c.template} en vez de ${tocado}` : "",
    subgrupos.length > 1 ? `ese día tiene ${subgrupos.length} formas de pago: saldrían ${subgrupos.length} avisos` : "",
    c.n > 1 ? "si van a distintas direcciones de entrega, sale un aviso por dirección" : ""].filter(Boolean).join(" · ");
  return { nombre: c.template, vals, nota };
}

/** La charla previa que manda el dashboard (se carga sin volver a correrla): sólo user/assistant, las últimas 40, 4.000 caracteres c/u. */
// deno-lint-ignore no-explicit-any
function historialDe(body: any): Array<{ rol: "user" | "assistant"; contenido: string; creado_en: string }> {
  if (!Array.isArray(body.historial)) return [];
  return (body.historial as Array<{ rol?: string; contenido?: string }>).slice(-40)
    .filter((h) => (h.rol === "user" || h.rol === "assistant") && typeof h.contenido === "string")
    .map((h) => ({ rol: h.rol as "user" | "assistant", contenido: String(h.contenido).slice(0, 4000), creado_en: new Date().toISOString() }));
}

// lk_bot-simular — simulador del bot: corre una charla completa con la MISMA lógica que el webhook
// (3c respuesta a aviso → 4 preguntas frecuentes → 6 agente IA) como si escribiera un cliente, sin
// mandar WhatsApp ni escribir nada (ver _shared/simulacion.ts). Pedido de Pablo Olejavetzky (28/09).
//
// Acceso: admin del dashboard (access_token) o interno (x-lk-secret = LK_FN_CRON_SECRET).
// Body: { cod_cliente: 4210,
//         pasos: [ { aviso: "pedido_programado_retira", pedido: 1562, params: {"1":"…","2":"…"} },
//                  { cliente: "No puedo pasar el 30" }, … ] }
// Devuelve, por paso: qué contestó el bot, por qué camino, qué alertas habría creado y qué
// herramientas usó el agente. No replica el saludo de primer contacto ni el rate limit del webhook.
//
// Para el chat interactivo del dashboard (Comunicaciones › Simulador, pedido de Pablo 29/09):
//   · { action: "avisos" }  → la botonera: [{ name, cuando, texto }] con las plantillas definidas y su texto de ejemplo.
//   · { historial: [{rol:"user"|"assistant", contenido}] } → charla previa que se carga SIN volver a correrla
//     (el simulador no guarda estado: así cada mensaje nuevo cuesta un solo turno de IA, no toda la charla).
//   · { aviso: "pedido_recibido" } sin params → los avisos de seguimiento salen con el último pedido web real del cliente
//     (o el de `pedido`) y en la versión que le corresponde por cómo se le entrega; devuelve `nota` (qué pedido y qué
//     versión) y `no_aplica` si a ese cliente no le llega (ej. pedido_entregado a un cliente de expreso). Las 6 de factura
//     salen con las facturas del último día facturado del cliente, con las mismas cuentas que el aviso real
//     (_shared/factura-valores.ts). Recordatorio y comprobante, o un cliente sin pedidos ni facturas: los valores de ejemplo
//     de la plantilla (la razón social, si la plantilla la lleva, es la del cliente). Pablo, 05/10.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lk-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const TEL_SIMULADO = "5490000000000";
const TEL_NUEVO = "5490000000099";   // número falso del modo "número nuevo"

// deno-lint-ignore no-explicit-any
async function simularNumeroNuevo(body: any): Promise<Response> {
  SIM.activo = true;
  SIM.historial = [];
  try {
    if (!Array.isArray(body.historial) || !body.historial.length) {
      await supabase.from("wa_prospect_leads").update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("phone", TEL_NUEVO).eq("status", "pending");
    }
    const salida: Array<Record<string, unknown>> = [];
    for (const paso of (body.pasos ?? []) as Array<Record<string, unknown>>) {
      const text = String(paso.cliente ?? "").trim();
      if (!text) continue;
      SIM.alertas = [];
      const respuestas: string[] = [];
      const send = async (r: string) => { respuestas.push(r); };
      let via = "";
      const lead = await getPendingLead(TEL_NUEVO);
      if (lead) {
        await handleAltaStep(TEL_NUEVO, text, lead, send); via = "alta (paso a paso)";
      } else {
        const faq = RE_ALTA_START.test(text) ? null : await handleFaq(text, null);   // mismo orden que el webhook
        if (faq) { respuestas.push(faq.reply); via = `faq (${faq.automation_level}${faq.faq_id ? ` #${faq.faq_id}` : ""})`; }
        else {
          const cuit = extractCuit(text);
          if (cuit) {
            const { data: ya } = await supabase.from("customers").select("business_name").eq("cuit", cuit).limit(1);
            // sql/116: si no es de Loekemeyer pero sí de Chef, también va a vinculación (antes arrancaba el alta).
            const { data: yaCh } = ya?.length ? { data: [] } : await supabase.from("bot_cuentas").select("razon_social")
              .eq("empresa", "CH").eq("cuit", cuit.replace(/\D/g, "")).limit(1);
            if (ya?.length || yaCh?.length) {
              const nombre = ya?.length ? ya[0].business_name : yaCh![0].razon_social;
              respuestas.push(`Encontré la cuenta de *${nombre}*. 👍\n\nPor seguridad, un asesor tiene que confirmar que este número es de la empresa antes de vincularlo. (Simulador: no se pide la vinculación.)`);
              via = ya?.length ? "registro por CUIT" : "registro por CUIT (cliente de Chef)";
            } else {
              await crearLead(TEL_NUEVO, text, cuit);
              respuestas.push("No te encontré como cliente con ese CUIT. 🤔\n\nSi querés te tomo los datos para registrarte —así podés ver precios y hacer pedidos. Te pregunto de a uno (para cortar, escribí *cancelar*):\n\n📋 ¿Cuál es tu *razón social*?");
              via = "alta (arranca con CUIT)";
            }
          } else if (RE_ALTA_START.test(text)) {
            await crearLead(TEL_NUEVO, text, null); respuestas.push(ALTA_INTRO); via = "alta (arranca)";
          } else {
            respuestas.push("Todavía no te tengo registrado como cliente. ¿Me pasás tu *CUIT* así te registro y podés ver precios y hacer pedidos? (con o sin guiones)\n\nSi todavía no sos cliente, decime *registrarme* y te tomo los datos.");
            via = "no cliente";
          }
        }
      }
      const tareas: number[] = [];
      if (body.crear_tareas === true && SIM.alertas.length) {
        const { data: tp } = await supabase.from("wa_envio_contactos").select("phone").order("created_at").limit(1).maybeSingle();
        for (const al of SIM.alertas) {
          const { tipo, ...ctx } = al as Record<string, unknown>;
          const { data: ins } = await supabase.from("wa_alertas_humano").insert({
            tipo: String(tipo ?? "otro"), phone: tp?.phone ?? null, customer_id: null,
            contexto: { ...ctx, texto_recibido: text.slice(0, 300), simulador: true },
          }).select("id").maybeSingle();
          if (ins?.id) tareas.push(ins.id);
        }
      }
      salida.push({ cliente: text, bot: respuestas.join("\n\n"), via, alertas: [...SIM.alertas], herramientas: [], tareas });
    }
    return json({ ok: true, cliente: "Número nuevo (no cliente)", charla: salida });
  } finally {
    SIM.activo = false;
  }
}


// sql/115 (Pablo, 01/10): cliente sólo de Chef — { empresa: "CH", cod_cliente: <código de Chef>, pasos }. Corre lo mismo
// que el webhook para ese cliente (_shared/chef.ts: saludo, facturas y datos de pago de Chef; lo demás a una persona).
// El teléfono es el simulado: las alertas se juntan en SIM.alertas (con "Crear tareas de prueba", van a Tareas 🧪).
// deno-lint-ignore no-explicit-any
async function simularClienteChef(body: any): Promise<Response> {
  const { data: cta } = await supabase.from("bot_cuentas").select("cod_cliente, razon_social, cuit")
    .eq("empresa", "CH").eq("cod_cliente", String(body.cod_cliente ?? "").trim()).maybeSingle();
  if (!cta) return json({ error: "cliente de Chef no encontrado" }, 400);
  const cuenta = { cod_cliente: String(cta.cod_cliente), razon_social: String(cta.razon_social ?? ""), cuit: cta.cuit ?? null, fuente: "simulador" };
  SIM.activo = true;
  // Pablo, 01/10: antes arrancaba siempre con la charla vacía; así "elegir foto → el código", la puerta de marca y la respuesta a
  // un aviso tienen la memoria de lo anterior, igual que el webhook.
  SIM.historial = historialDe(body);
  try {
    const salida: Array<Record<string, unknown>> = [];
    for (const paso of (body.pasos ?? []) as Array<Record<string, unknown>>) {
      // Aviso de Chef (las 6 de factura): el texto con los valores de ejemplo, como si ya le hubiera llegado al cliente.
      if (paso.aviso) {
        const nombre = String(paso.aviso);
        const def = AVISOS.find((x) => x.name === nombre && x.empresa === "CH");
        if (!def) return json({ error: `aviso de Chef desconocido: ${nombre}` }, 400);
        const texto = rellenar(def.body, def.ejemplos);
        SIM.historial.push({ rol: "assistant", creado_en: new Date().toISOString(), contenido: `[Aviso automático ${nombre}]\n${texto}` });
        salida.push({ aviso: nombre, texto });
        continue;
      }
      const text = String(paso.cliente ?? "").trim();
      if (!text) continue;
      SIM.alertas = [];
      let reply = await atenderMalHumor(TEL_SIMULADO, text, { customer_id: null, business_name: cuenta.razon_social, empresa: "CH" });
      let via = "cliente_molesto";
      let imagenes: Array<{ url: string; caption: string }> = [];
      if (!reply) {
        const r = await atenderClienteChef(TEL_SIMULADO, text, cuenta);
        reply = r.reply; via = r.via;
        // Reenvío de factura: en el simulador no se manda nada; se muestra qué PDF iría adjunto.
        if (r.documentos?.length) reply += "\n\n" + r.documentos.map((d) => `📎 ${d.filename}`).join("\n");
        // Foto de producto de Chef: en el simulador no se manda nada; va en `imagenes` y el front la dibuja.
        imagenes = r.imagenes ?? [];
      }
      const tareas: number[] = [];
      if (body.crear_tareas === true && SIM.alertas.length) {
        const { data: tp } = await supabase.from("wa_envio_contactos").select("phone").order("created_at").limit(1).maybeSingle();
        for (const al of SIM.alertas) {
          const { tipo, ...ctx } = al as Record<string, unknown>;
          const { data: ins } = await supabase.from("wa_alertas_humano").insert({
            tipo: String(tipo ?? "otro"), phone: tp?.phone ?? null, customer_id: null,
            contexto: { ...ctx, texto_recibido: text.slice(0, 300), simulador: true },
          }).select("id").maybeSingle();
          if (ins?.id) tareas.push(ins.id);
        }
      }
      salida.push({ cliente: text, bot: reply, via, alertas: [...SIM.alertas], herramientas: [], tareas, ...(imagenes.length ? { imagenes } : {}) });
    }
    return json({ ok: true, cliente: `${cuenta.razon_social} (Chef ${cuenta.cod_cliente})`, charla: salida });
  } finally {
    SIM.activo = false;
  }
}

async function esLlamadaInterna(req: Request): Promise<boolean> {
  const recibido = req.headers.get("x-lk-secret") ?? "";
  if (!recibido) return false;
  let esperado = Deno.env.get("LK_FN_CRON_SECRET") ?? "";
  if (!esperado) {
    const { data } = await supabase.rpc("krikos_secret", { p_name: "LK_FN_CRON_SECRET" });
    esperado = typeof data === "string" ? data : "";
  }
  return esperado.length > 0 && recibido === esperado;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    if (!(await esLlamadaInterna(req))) {
      const gate = await requireAdmin(body);
      if (!gate.ok) return json({ error: gate.error }, gate.status);
    }

    if (body.action === "avisos") {
      // { action: "avisos", empresa: "CH" } → los de Chef; sin empresa (o "LK") → los de Loekemeyer.
      const emp = body.empresa === "CH" ? "CH" : "LK";
      return json({ ok: true, empresa: emp, avisos: AVISOS.filter((p) => p.empresa === emp)
        .map((p) => ({ name: p.name, cuando: p.disparo, factura: p.factura, texto: rellenar(p.body, p.ejemplos) })) });
    }

    // Pablo, 29/09: modo "número nuevo" (alguien que todavía no es cliente): corre el alta real paso a paso (_shared/alta.ts)
    // con un número falso. El estado del alta vive en wa_prospect_leads (filas de ese número falso); una charla nueva
    // cancela el alta anterior. La alerta de alta sólo se crea de verdad con "Crear tareas de prueba" (🧪).
    if (body.numero_nuevo === true) return await simularNumeroNuevo(body);
    if (body.empresa === "CH") return await simularClienteChef(body);
    // Pablo, 29/09: probar la lectura de un pedido por archivo sin WhatsApp: {action:"leer_archivo", base64, mime, nombre}.
    // Devuelve lo que leyó la IA, cómo lo cruzó con el catálogo y el mensaje que le mandaría al cliente. No crea nada.
    if (body.action === "leer_archivo") {
      const bin = atob(String(body.base64 ?? ""));
      const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const key = Deno.env.get("ANTHROPIC_API_KEY") ?? (await getSetting("ANTHROPIC_API_KEY")) ?? "";
      const r = await leerPedidoArchivo(bytes, String(body.mime ?? ""), key, null, body.nombre ?? null);
      const arts = r.lineas.length ? await resolverArticulos(r.lineas, key, null) : [];
      return json({ ok: true, lineas: r.lineas, error: r.error ?? null, articulos: arts, mensaje: arts.length ? textoConfirmacion(arts, { cotizador: r.cotizador === true, seguir: true, condicion_code: r.condicion_code }) : null,
        cotizador: r.cotizador === true, condicion_code: r.condicion_code ?? null });
    }

    const { data: c } = await supabase.from("customers")
      .select("id, cod_cliente, business_name, dto_vol").eq("cod_cliente", Number(body.cod_cliente)).maybeSingle();
    if (!c) return json({ error: "cliente no encontrado" }, 400);
    const customer = { customer_id: c.id, cod_cliente: Number(c.cod_cliente), business_name: c.business_name, dto_vol: Number(c.dto_vol ?? 0) };

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("CLAUDE_API_KEY") ?? (await getSetting("anthropic_api_key")) ?? "";

    // Opcional: teléfono real del cliente, para que las herramientas de consulta (pedidos, entregas) encuentren
    // sus datos. Sigue en modo SIM: no se guarda historial ni corren herramientas con efecto.
    let telSim = String(body.telefono ?? "").replace(/\D/g, "");
    if (!telSim) {
      // Sin teléfono en el pedido: el agendado del cliente (sólo lectura) para que las herramientas encuentren sus pedidos.
      const { data: w } = await supabase.from("bot_customer_whatsapps").select("whatsapp")
        .eq("customer_id", c.id).order("is_primary", { ascending: false }).limit(1).maybeSingle();
      telSim = String(w?.whatsapp ?? "").replace(/\D/g, "");
      // Sin agendado: el teléfono del ERP (el bot también reconoce por ahí, sql/097). Antes caía al número simulado y
      // las herramientas decían "no tenés pedidos" a clientes que sí tienen (cliente 4286, 29/09).
      if (!telSim) {
        const { data: erp } = await supabase.from("wa_clientes_telefono").select("telefono").eq("cod_cliente", c.cod_cliente).limit(1).maybeSingle();
        const { data: cw } = await supabase.from("customers").select("whatsapp").eq("id", c.id).maybeSingle();
        telSim = String(erp?.telefono ?? cw?.whatsapp ?? "").replace(/\D/g, "");
      }
      telSim ||= TEL_SIMULADO;
    }
    SIM.activo = true;
    SIM.historial = historialDe(body);
    const salida: Array<Record<string, unknown>> = [];
    const ahora = () => new Date().toISOString();

    let pedidoReal: DatosPedido | null | undefined;   // se busca una sola vez por llamada, con el primer aviso
    for (const paso of (body.pasos ?? []) as Array<Record<string, unknown>>) {
      if (paso.aviso) {
        const tocado = String(paso.aviso);
        let nombre = tocado;
        let vals: string[] | null = paso.params ? Object.values(paso.params as Record<string, unknown>).map(String) : null;
        let nota = "";
        let pedido = Number(paso.pedido) || null;
        // Pablo, 05/10: los avisos de seguimiento salen con el pedido web real del cliente (el del paso o el último) y en
        // la versión que le corresponde por cómo se le entrega (reparto propio, expreso o retiro). Antes salían con los
        // valores de ejemplo de plantillas-meta.ts y la versión que se tocara ("Lamadrid 157 - S.M. Tucumán" a un
        // cliente de Mar del Plata que va por expreso).
        if (!vals && AVISOS_DE_PEDIDO.has(tocado)) {
          if (pedidoReal === undefined) pedidoReal = await datosPedido(c.id, pedido);
          if (pedidoReal) {
            const usar = avisoParaModo(tocado, pedidoReal.modo);
            const delPedido = `pedido real ${pedidoReal.order_id} del ${fechaCorta(pedidoReal.pedido_el)} · ${modoTexto(pedidoReal)}`;
            if (!usar) {
              salida.push({ aviso: tocado, texto: null, no_aplica: true, pedido: pedidoReal.order_id,
                nota: `${tocado} no le llega a este cliente: ${delPedido}.` });
              continue;
            }
            nombre = usar;
            vals = paramsAviso(usar, pedidoReal);
            pedido = pedidoReal.order_id;
            nota = [delPedido, usar !== tocado ? `se usa ${usar} en vez de ${tocado}` : "",
              usar === "pedido_reprogramado" ? "la nueva fecha es de ejemplo" : ""].filter(Boolean).join(" · ");
          } else nota = pedido ? `no encontré el pedido web ${pedido} de este cliente: valores de ejemplo`
            : "el cliente no tiene pedidos web: valores de ejemplo";
        } else if (!vals && AVISOS.find((x) => x.name === tocado && x.empresa === "LK")?.factura) {
          try {
            const f = await facturaReal(customer.cod_cliente, tocado);
            if (f) { nombre = f.nombre; vals = f.vals; nota = f.nota; }
            else nota = "el cliente no tiene facturas: valores de ejemplo";
          } catch (e) {
            nota = `no pude leer las facturas (${e instanceof Error ? e.message : String(e)}): valores de ejemplo`;
          }
        }
        const def = AVISOS.find((x) => x.name === nombre && x.empresa === "LK");
        // Sin pedido real (factura, recordatorio, comprobante o cliente sin pedidos web): los valores de ejemplo; en la
        // variable de razón social (si la plantilla la tiene), el nombre del cliente.
        if (!vals) {
          vals = def ? def.ejemplos.map((v, i) => (i === def.varCliente ? c.business_name : v)) : [];
          nota ||= "valores de ejemplo";
        }
        const texto = def ? rellenar(def.body, vals) : (renderPlantilla(nombre, null) ?? "");
        SIM.historial.push({ rol: "assistant", creado_en: ahora(),
          contenido: `[Aviso automático ${nombre}${pedido ? ` · pedido ${pedido}` : ""}]\n${texto}` });
        salida.push({ aviso: nombre, texto, nota, ...(pedido ? { pedido } : {}) });
        continue;
      }
      let text = String(paso.cliente ?? "").trim();
      if (!text) continue;
      SIM.alertas = [];
      SIM.herramientas = [];
      let puntuar = false;
      let marcaLk = false;

      let reply: string | null = null;
      let via = "";
      let imagenes: Array<{ url: string; caption: string }> = [];
      // 3b'. cliente molesto
      reply = await atenderMalHumor(TEL_SIMULADO, text, customer);
      if (reply) via = "cliente_molesto";
      // 3c. respuesta a un aviso
      if (!reply) {
        reply = await responderAviso(TEL_SIMULADO, text, customer);
        if (reply) via = "respuesta_aviso";
      }
      // 3d. pedido de cambio en cualquier momento
      if (!reply) {
        reply = await pedidoDeCambio(TEL_SIMULADO, text, customer);
        if (reply) via = "pedido_de_cambio";
      }
      // 3e. puerta de marca (cliente de Loekemeyer y de Chef), mismo orden que el webhook
      if (!reply && !esSoloSaludo(text) && !(await pedidoEnCurso(telSim))) {
        const g = await puertaMarca(TEL_SIMULADO, text,
          { id: c.id, cod_cliente: customer.cod_cliente, business_name: c.business_name, dto_vol: customer.dto_vol });
        if (g?.tipo === "responder") {
          reply = g.reply; via = g.via;
          if (g.documentos?.length) reply += "\n\n" + g.documentos.map((d) => `📎 ${d.filename}`).join("\n");
          imagenes = g.imagenes ?? [];
        } else if (g?.tipo === "seguir") { text = g.texto; marcaLk = true; via = g.via; }
      }
      // 4. preguntas frecuentes
      if (!reply) {
        const faq = await pedidoEnCurso(telSim) ? null
          : await handleFaq(text, { id: c.id, cod_cliente: customer.cod_cliente, business_name: c.business_name, dto_vol: customer.dto_vol });
        if (faq) {
          reply = marcaLk ? conEtiqueta("lk", faq.reply) : faq.reply; via = `faq (${faq.automation_level}${faq.faq_id ? ` #${faq.faq_id}` : ""})`;
          // Reenvío de factura: en el simulador no se manda nada; se muestra qué PDF iría adjunto.
          if (faq.documentos?.length) reply += "\n\n" + faq.documentos.map((d) => `📎 ${d.filename}`).join("\n");
          // Mismo contexto que arma el webhook, así la tarea de prueba es igual a la real.
          if (faq.alerta) SIM.alertas.push({ tipo: "otro", motivo: faq.alerta.motivo,
            ...(faq.alerta.urgente !== undefined ? { urgente: faq.alerta.urgente } : {}),
            ...(faq.alerta.pedidos?.length ? { pedido: faq.alerta.pedidos[0], pedidos: faq.alerta.pedidos } : {}),
            detalle: faq.alerta.detalle ?? null });
          else if (faq.automation_level === "needs_human") SIM.alertas.push({ tipo: "escalation", faq_id: faq.faq_id ?? null, tema: faq.topic ?? null });
        }
      }
      // 6. agente IA
      SIM.historial.push({ rol: "user", contenido: text, creado_en: ahora() });
      if (!reply) {
        const r = await runConversation(text, telSim, customer.business_name, customer.cod_cliente, customer.dto_vol, apiKey, "lk_bot-simular");
        via = r.timeout ? "agente (timeout: en producción no se contesta nada)" : r.llmError ? "agente (error: en producción no se contesta nada)" : "agente IA";
        reply = marcaLk && r.reply ? conEtiqueta("lk", r.reply) : r.reply;
        // Con "Crear tareas de prueba", la respuesta de la IA también queda para puntuar (🧪, fuera de los promedios).
        if (body.crear_tareas === true && !r.timeout && !r.llmError) {
          const { error: eP } = await supabase.from("wa_ia_puntajes").insert({
            phone: telSim, customer_id: c.id, pregunta: text.slice(0, 2000), respuesta: String(r.reply ?? "").slice(0, 4000),
            herramientas: r.herramientas ?? [], modelo_respuesta: r.modelo ?? null, prueba: true,
          });
          if (!eP) puntuar = true;
        }
      }
      SIM.historial.push({ rol: "assistant", contenido: reply ?? "", creado_en: ahora() });
      // Pablo, 29/09: "crear tareas de prueba" → cada alerta que habría creado el bot se crea DE VERDAD en Tareas, marcada
      // 🧪 (contexto.simulador). El número es el de prueba (Thomy), así el aviso que sale al aplicarla le llega a él y
      // nunca al cliente. Aplicarla sólo se puede con el cliente de prueba (lk_alertas, cliente-prueba.ts).
      const tareas: number[] = [];
      if (body.crear_tareas === true && SIM.alertas.length) {
        const { data: tp } = await supabase.from("wa_envio_contactos").select("phone").order("created_at").limit(1).maybeSingle();
        for (const al of SIM.alertas) {
          const { tipo, ...ctx } = al as Record<string, unknown>;
          const { data: ins } = await supabase.from("wa_alertas_humano").insert({
            tipo: String(tipo ?? "otro"), phone: tp?.phone ?? null, customer_id: c.id,
            contexto: { ...ctx, texto_recibido: text.slice(0, 300), razon_social: c.business_name, simulador: true },
          }).select("id").maybeSingle();
          if (ins?.id) tareas.push(ins.id);
        }
      }
      salida.push({ cliente: text, bot: reply, via, alertas: [...SIM.alertas], herramientas: [...SIM.herramientas], tareas, puntuar, ...(imagenes.length ? { imagenes } : {}) });
    }
    SIM.activo = false;
    return json({ ok: true, cliente: `${c.business_name} (${c.cod_cliente})`, charla: salida });
  } catch (err) {
    SIM.activo = false;
    console.error("lk_bot-simular error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
