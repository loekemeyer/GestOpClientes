import "../_shared/wa-guard.ts"; // D007: por las dudas — igual no manda nada (teléfono ficticio)
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getSetting, supabase } from "../_shared/supabase.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { SIM } from "../_shared/simulacion.ts";
import { pedidoDeCambio, responderAviso } from "../_shared/respuesta-aviso.ts";
import { atenderMalHumor } from "../_shared/humor.ts";
import { handleFaq } from "../_shared/faq.ts";
import { runConversation } from "../_shared/bot-conversation.ts";
import { PLANTILLAS, renderPlantilla } from "../_shared/plantillas-meta.ts";
import { PLANTILLAS_FACTURA } from "../_shared/plantillas-factura.ts";

// Botonera del Simulador: avisos de seguimiento + las 6 de factura (con el PDF de la factura en el mensaje).
const AVISOS = [...PLANTILLAS.map((p) => ({ name: p.name, disparo: p.disparo, body: p.body, ejemplos: p.ejemplos, factura: false })),
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
//   · { aviso: "pedido_recibido" } sin params → usa los valores de ejemplo de la plantilla, con {{1}} = razón social del cliente.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lk-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const TEL_SIMULADO = "5490000000000";

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
      telSim = String(w?.whatsapp ?? "").replace(/\D/g, "") || TEL_SIMULADO;
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
        // Sin params: los valores de ejemplo; en los de seguimiento {{1}} es la razón social del cliente.
        const vals = paso.params ? Object.values(paso.params as Record<string, unknown>).map(String)
          : def ? def.ejemplos.map((v, i) => (i === 0 && !def.factura ? c.business_name : v)) : [];
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
          if (faq.automation_level === "needs_human") SIM.alertas.push({ tipo: "escalation", faq_id: faq.faq_id ?? null });
        }
      }
      // 6. agente IA
      SIM.historial.push({ rol: "user", contenido: text, creado_en: ahora() });
      if (!reply) {
        const r = await runConversation(text, telSim, customer.business_name, customer.cod_cliente, customer.dto_vol, apiKey, "lk_bot-simular");
        via = r.timeout ? "agente (timeout: en producción no se contesta nada)" : r.llmError ? "agente (error: en producción no se contesta nada)" : "agente IA";
        reply = r.reply;
      }
      SIM.historial.push({ rol: "assistant", contenido: reply ?? "", creado_en: ahora() });
      salida.push({ cliente: text, bot: reply, via, alertas: [...SIM.alertas], herramientas: [...SIM.herramientas] });
    }
    SIM.activo = false;
    return json({ ok: true, cliente: `${c.business_name} (${c.cod_cliente})`, charla: salida });
  } catch (err) {
    SIM.activo = false;
    console.error("lk_bot-simular error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
