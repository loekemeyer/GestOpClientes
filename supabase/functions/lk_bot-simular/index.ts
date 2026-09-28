import "../_shared/wa-guard.ts"; // D007: por las dudas — igual no manda nada (teléfono ficticio)
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getSetting, supabase } from "../_shared/supabase.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { SIM } from "../_shared/simulacion.ts";
import { responderAviso } from "../_shared/respuesta-aviso.ts";
import { handleFaq } from "../_shared/faq.ts";
import { runConversation } from "../_shared/bot-conversation.ts";
import { renderPlantilla } from "../_shared/plantillas-meta.ts";

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

    const { data: c } = await supabase.from("customers")
      .select("id, cod_cliente, business_name, dto_vol").eq("cod_cliente", Number(body.cod_cliente)).maybeSingle();
    if (!c) return json({ error: "cliente no encontrado" }, 400);
    const customer = { customer_id: c.id, cod_cliente: Number(c.cod_cliente), business_name: c.business_name, dto_vol: Number(c.dto_vol ?? 0) };

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("CLAUDE_API_KEY") ?? (await getSetting("anthropic_api_key")) ?? "";

    SIM.activo = true;
    SIM.historial = [];
    const salida: Array<Record<string, unknown>> = [];
    const ahora = () => new Date().toISOString();

    for (const paso of (body.pasos ?? []) as Array<Record<string, unknown>>) {
      if (paso.aviso) {
        const nombre = String(paso.aviso);
        const texto = renderPlantilla(nombre, (paso.params ?? null) as Record<string, unknown> | null) ?? "";
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
      // 3c. respuesta a un aviso
      reply = await responderAviso(TEL_SIMULADO, text, customer);
      if (reply) via = "respuesta_aviso";
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
        const r = await runConversation(text, TEL_SIMULADO, customer.business_name, customer.cod_cliente, customer.dto_vol, apiKey, "lk_bot-simular");
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
