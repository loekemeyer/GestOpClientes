// lk_eval-juez — juez automático de la corrida semanal de evaluación (Pablo Olejavetzky, 15/10/2026, P5 del plan de los 8 puntos:
// «Sí, armá el juez automático con Haiku»).
//
// La corrida semanal con Haiku (sql/153) guarda la respuesta de cada caso. Esta función compara cada respuesta con la nota esperada
// del caso (wa_agente_evals.nota_esperada) usando Haiku 5.5 y guarda bien / a_medias / mal con el motivo en wa_agente_eval_resultados
// (sql/157). wa_eval_tick la llama sola al cerrar una corrida con modelo_eval. Costo medido: ver docs/PLAN-AGENTE-8-PUNTOS-2026-10-13.md.
//
//   {action:"juzgar", corrida_id}   → juzga los casos listos sin juicio de esa corrida y guarda el resumen en la corrida
// Acceso: interno (x-lk-secret = LK_FN_CRON_SECRET) o admin del dashboard (access_token).
// El gasto se registra en bot_token_usage con function_name 'lk_eval-juez'.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getSetting, supabase } from "../_shared/supabase.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { extrasAnthropic, textoAnthropic } from "../_shared/anthropic-extras.ts";
import { type Juicio, leerVeredicto, pedidoJuez, resumenJuicios, SISTEMA_JUEZ } from "../_shared/eval-juez.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lk-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MODELO = "claude-haiku-5-5";
const TARIFA = { input: 0.10, output: 0.50 }; // US$ por millón de tokens (mismo valor que _shared/bot-llm.ts)
// Tope por llamada: la corrida semanal tiene 8 casos. Si alguien juzga una corrida grande (la nocturna tiene 111), no se va de mano.
const MAX_CASOS = 20;

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

async function juzgarUno(usuario: string, apiKey: string): Promise<{ juicio: Juicio; motivo: string } | { error: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELO, max_tokens: 300, system: SISTEMA_JUEZ, messages: [{ role: "user", content: usuario }], ...extrasAnthropic(MODELO) }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) return { error: `Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const r = await res.json();
  const it = Number(r?.usage?.input_tokens ?? 0), ot = Number(r?.usage?.output_tokens ?? 0);
  await supabase.from("bot_token_usage").insert({
    model: MODELO, input_tokens: it, output_tokens: ot, function_name: "lk_eval-juez",
    estimated_cost_usd: (it * TARIFA.input + ot * TARIFA.output) / 1_000_000,
  }).then(() => {}, (e: unknown) => console.error("[juez] log de uso:", e));
  return leerVeredicto(textoAnthropic(r?.content)) ?? { error: "respuesta sin veredicto" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    if (!(await esLlamadaInterna(req))) {
      const gate = await requireAdmin(body);
      if (!gate.ok) return json({ error: gate.error }, gate.status);
    }
    if (body.action !== "juzgar") return json({ error: "action desconocida" }, 400);
    const corridaId = Number(body.corrida_id);
    if (!(corridaId > 0)) return json({ error: "falta corrida_id" }, 400);

    const apiKey = (await getSetting("ANTHROPIC_API_KEY")) ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (!apiKey) return json({ ok: false, error: "Falta ANTHROPIC_API_KEY" }, 200);

    const { data: filas, error } = await supabase.from("wa_agente_eval_resultados")
      .select("id, estado, herramientas, deriva, respuesta, juicio, wa_agente_evals(pregunta, nota_esperada)")
      .eq("corrida_id", corridaId).order("id");
    if (error) return json({ ok: false, error: error.message }, 200);

    let juzgados = 0;
    const errores: string[] = [];
    // deno-lint-ignore no-explicit-any
    for (const f of (filas ?? []) as any[]) {
      if (f.juicio) continue;
      if (juzgados + errores.length >= MAX_CASOS) break;
      const ev = Array.isArray(f.wa_agente_evals) ? f.wa_agente_evals[0] : f.wa_agente_evals;
      // Un caso que terminó en error no tiene respuesta que juzgar: cuenta como mal, con el motivo.
      if (f.estado !== "listo") {
        await supabase.from("wa_agente_eval_resultados").update({ juicio: "mal", juicio_motivo: "el caso no tuvo respuesta (error de la corrida)", juicio_at: new Date().toISOString() }).eq("id", f.id);
        continue;
      }
      const usuario = pedidoJuez({ pregunta: ev?.pregunta ?? "", nota_esperada: ev?.nota_esperada ?? null, herramientas: f.herramientas, deriva: f.deriva, respuesta: f.respuesta });
      if (!usuario) continue; // sin nota esperada: no se juzga
      let v: { juicio: Juicio; motivo: string } | { error: string };
      try { v = await juzgarUno(usuario, apiKey); } catch (e) { v = { error: e instanceof Error ? e.message : String(e) }; }
      if ("error" in v) { errores.push(`${f.id}: ${v.error}`); continue; }
      await supabase.from("wa_agente_eval_resultados").update({ juicio: v.juicio, juicio_motivo: v.motivo, juicio_at: new Date().toISOString() }).eq("id", f.id);
      juzgados++;
    }

    const { data: todos } = await supabase.from("wa_agente_eval_resultados").select("juicio").eq("corrida_id", corridaId);
    const r = resumenJuicios(((todos ?? []) as Array<{ juicio: Juicio | null }>).map((x) => x.juicio));
    await supabase.from("wa_agente_eval_corridas").update({
      juicio_bien: r.bien, juicio_a_medias: r.a_medias, juicio_mal: r.mal, juzgada_at: new Date().toISOString(),
    }).eq("id", corridaId);
    if (errores.length) console.error("[juez] errores:", errores.join(" | "));
    return json({ ok: true, corrida_id: corridaId, juzgados, con_error: errores.length, ...r });
  } catch (e) {
    console.error("[juez]", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 200);
  }
});
