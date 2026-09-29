import "../_shared/wa-guard.ts"; // D007: por las dudas — igual no manda nada (teléfono ficticio)
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getSetting, supabase } from "../_shared/supabase.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { SIM } from "../_shared/simulacion.ts";
import { pedidoDeCambio, responderAviso } from "../_shared/respuesta-aviso.ts";
import { atenderMalHumor } from "../_shared/humor.ts";
import { handleFaq } from "../_shared/faq.ts";
import { leerPedidoArchivo, resolverArticulos, textoConfirmacion } from "../_shared/pedido-archivo.ts";
import { ALTA_INTRO, crearLead, extractCuit, getPendingLead, handleAltaStep, RE_ALTA_START } from "../_shared/alta.ts";
import { runConversation } from "../_shared/bot-conversation.ts";
import { PLANTILLAS, renderPlantilla } from "../_shared/plantillas-meta.ts";
import { PLANTILLAS_FACTURA } from "../_shared/plantillas-factura.ts";

// Botonera del Simulador: avisos de seguimiento + las 6 de factura (con el PDF de la factura en el mensaje).
const AVISOS = [...PLANTILLAS.map((p) => ({ name: p.name, disparo: p.disparo, body: p.body, ejemplos: p.ejemplos, factura: false,
    // la variable que lleva la razón social (si la plantilla la tiene): ahí va el nombre del cliente simulado.
    varCliente: p.variables.findIndex((v) => /raz[oó]n social/i.test(v)) })),
  ...PLANTILLAS_FACTURA.map((p) => ({ ...p, factura: true }))];
const rellenar = (body: string, vals: string[]) => body.replace(/\{\{(\d+)\}\}/g, (m, n) => vals[Number(n) - 1] ?? m);

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
//   · { aviso: "pedido_recibido" } sin params → usa los valores de ejemplo de la plantilla (la razón social, si la plantilla la lleva, es la del cliente).

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
            if (ya?.length) {
              respuestas.push(`Encontré la cuenta de *${ya[0].business_name}*. 👍\n\nPor seguridad, un asesor tiene que confirmar que este número es de la empresa antes de vincularlo. (Simulador: no se pide la vinculación.)`);
              via = "registro por CUIT";
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
      return json({ ok: true, avisos: AVISOS.map((p) => ({ name: p.name, cuando: p.disparo, factura: p.factura, texto: rellenar(p.body, p.ejemplos) })) });
    }

    // Pablo, 29/09: modo "número nuevo" (alguien que todavía no es cliente): corre el alta real paso a paso (_shared/alta.ts)
    // con un número falso. El estado del alta vive en wa_prospect_leads (filas de ese número falso); una charla nueva
    // cancela el alta anterior. La alerta de alta sólo se crea de verdad con "Crear tareas de prueba" (🧪).
    if (body.numero_nuevo === true) return await simularNumeroNuevo(body);
    // Pablo, 29/09: probar la lectura de un pedido por archivo sin WhatsApp: {action:"leer_archivo", base64, mime, nombre}.
    // Devuelve lo que leyó la IA, cómo lo cruzó con el catálogo y el mensaje que le mandaría al cliente. No crea nada.
    if (body.action === "leer_archivo") {
      const bin = atob(String(body.base64 ?? ""));
      const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const key = Deno.env.get("ANTHROPIC_API_KEY") ?? (await getSetting("ANTHROPIC_API_KEY")) ?? "";
      const r = await leerPedidoArchivo(bytes, String(body.mime ?? ""), key, null, body.nombre ?? null);
      const arts = r.lineas.length ? await resolverArticulos(r.lineas) : [];
      return json({ ok: true, lineas: r.lineas, error: r.error ?? null, articulos: arts, mensaje: arts.length ? textoConfirmacion(arts) : null });
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
    SIM.historial = Array.isArray(body.historial)
      ? (body.historial as Array<{ rol?: string; contenido?: string }>).slice(-40)
        .filter((h) => (h.rol === "user" || h.rol === "assistant") && typeof h.contenido === "string")
        .map((h) => ({ rol: h.rol as "user" | "assistant", contenido: String(h.contenido).slice(0, 4000), creado_en: new Date().toISOString() }))
      : [];
    const salida: Array<Record<string, unknown>> = [];
    const ahora = () => new Date().toISOString();

    for (const paso of (body.pasos ?? []) as Array<Record<string, unknown>>) {
      if (paso.aviso) {
        const nombre = String(paso.aviso);
        const def = AVISOS.find((x) => x.name === nombre);
        // Sin params: los valores de ejemplo; en la variable de razón social (si la plantilla la tiene), el nombre del cliente.
        const vals = paso.params ? Object.values(paso.params as Record<string, unknown>).map(String)
          : def ? def.ejemplos.map((v, i) => (i === (def as { varCliente?: number }).varCliente ? c.business_name : v)) : [];
        const texto = def ? rellenar(def.body, vals) : (renderPlantilla(nombre, null) ?? "");
        SIM.historial.push({ rol: "assistant", creado_en: ahora(),
          contenido: `[Aviso automático ${nombre}${paso.pedido ? ` · pedido ${paso.pedido}` : ""}]\n${texto}` });
        salida.push({ aviso: nombre, texto });
        continue;
      }
      const text = String(paso.cliente ?? "").trim();
      if (!text) continue;
      SIM.alertas = [];
      SIM.herramientas = [];
      let puntuar = false;

      let reply: string | null = null;
      let via = "";
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
      // 4. preguntas frecuentes
      if (!reply) {
        const faq = await handleFaq(text, { id: c.id, cod_cliente: customer.cod_cliente, business_name: c.business_name, dto_vol: customer.dto_vol });
        if (faq) {
          reply = faq.reply; via = `faq (${faq.automation_level}${faq.faq_id ? ` #${faq.faq_id}` : ""})`;
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
        reply = r.reply;
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
      salida.push({ cliente: text, bot: reply, via, alertas: [...SIM.alertas], herramientas: [...SIM.herramientas], tareas, puntuar });
    }
    SIM.activo = false;
    return json({ ok: true, cliente: `${c.business_name} (${c.cod_cliente})`, charla: salida });
  } catch (err) {
    SIM.activo = false;
    console.error("lk_bot-simular error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
