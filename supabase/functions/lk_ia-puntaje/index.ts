// lk_ia-puntaje — puntaje de las respuestas de la IA (Pablo Olejavetzky, 29/09).
//
// Cada respuesta del agente IA al cliente queda en wa_ia_puntajes (la inserta lk_whatsapp-webhook, sql/101).
// Esta función la hace evaluar por Haiku con 5 criterios de 1 a 5 y guarda el resultado. Las que sacan 2 o menos
// en algún criterio aparecen en el dashboard (IA › Revisión de respuestas) para que una persona las mire.
//
//   {action:"evaluar"}                         → evalúa hasta 15 pendientes (cron cada 10 min, o botón del dashboard)
//   {action:"list", dias?}                     → para revisar (mínimo ≤ 2 sin revisar) + promedios + gasto de Haiku
//   {action:"marcar", id, revision, nota?}     → bien_marcada (la respuesta estuvo mal) | falsa_alarma
// Acceso: interno (x-lk-secret = LK_FN_CRON_SECRET) o admin del dashboard (access_token).
// El gasto se registra en bot_token_usage con function_name 'lk_ia-puntaje' (se ve en IA › gastos y uso).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getSetting, supabase } from "../_shared/supabase.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { REGLAS_OPERATIVAS } from "../_shared/agente-fijos.ts";
import { extrasAnthropic, textoAnthropic } from "../_shared/anthropic-extras.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lk-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Pablo, 09/10: Haiku 5.5 en lugar de Haiku 4.5 (US$ 0,10 / 0,50 por millón, un décimo). Sin temperature (da 400) y con el pensamiento
// apagado: _shared/anthropic-extras.ts.
const MODELO = "claude-haiku-5-5";
const TARIFA = { input: 0.10, output: 0.50 }; // US$ por millón de tokens (mismo valor que _shared/bot-llm.ts)
const POR_CORRIDA = 15;
const CRITERIOS = ["correcta", "resolvio", "derivo", "reglas", "tono"] as const;

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

const SISTEMA = `Sos un evaluador de calidad de un bot de WhatsApp de Loekemeyer Hnos (mayorista de artículos de cocina y bazar).
Te paso la charla previa, el último mensaje del cliente, las herramientas que usó el bot con lo que devolvieron, y la respuesta del bot.
Puntuá la RESPUESTA DEL BOT de 1 (muy mal) a 5 (perfecta) en 5 criterios:
- correcta: los datos que da (fechas, importes, estados, stock, precios) coinciden con lo que devolvieron las herramientas; no inventa nada. Si no da datos, 5.
- resolvio: contesta lo que el cliente preguntó o pidió (no otra cosa, no lo deja sin respuesta).
- derivo: derivó a una persona cuando hacía falta (reclamo, pago que no coincide, cambio que no puede resolver, pidió una persona) y NO derivó lo que podía resolver solo. Si no hacía falta derivar y no derivó, 5.
- reglas: respeta las reglas del bot que están abajo (no pide ni da número de pedido ni CUIT, no toma pedidos por WhatsApp, no manda a otro mail o teléfono, stock sin números, formato WhatsApp, etc.).
- tono: breve, amable, claro, en español argentino, sin repetirse.
Respondé SOLO un JSON: {"correcta":n,"resolvio":n,"derivo":n,"reglas":n,"tono":n,"comentario":"una frase: qué estuvo mal, o 'bien' si todo 4 o más"}

Reglas del bot:
${REGLAS_OPERATIVAS}`;

// deno-lint-ignore no-explicit-any
async function evaluarUna(fila: any, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  // Charla previa: los 6 mensajes anteriores de ese número (sin el turno evaluado).
  const tel10 = String(fila.phone ?? "").replace(/\D/g, "").slice(-10);
  const { data: prev } = await supabase.from("wa_conversations").select("direction, body, created_at")
    .like("phone", `%${tel10}`).lt("created_at", new Date(new Date(fila.created_at).getTime() - 60_000).toISOString())
    .order("created_at", { ascending: false }).limit(6);
  const charla = (prev ?? []).reverse().map((m) => `${m.direction === "in" ? "Cliente" : "Bot"}: ${String(m.body ?? "").slice(0, 500)}`).join("\n") || "(sin charla previa)";
  const herr = (Array.isArray(fila.herramientas) ? fila.herramientas : [])
    // deno-lint-ignore no-explicit-any
    .map((h: any) => `- ${h.nombre}(${JSON.stringify(h.input ?? {}).slice(0, 200)}) → ${String(h.resultado ?? "").slice(0, 1200)}`).join("\n") || "(no usó herramientas)";
  const usuario = `CHARLA PREVIA:\n${charla}\n\nÚLTIMO MENSAJE DEL CLIENTE:\n${fila.pregunta}\n\nHERRAMIENTAS:\n${herr}\n\nRESPUESTA DEL BOT:\n${fila.respuesta}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELO, max_tokens: 300, system: SISTEMA, messages: [{ role: "user", content: usuario }], ...extrasAnthropic(MODELO) }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) return { ok: false, error: `Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const r = await res.json();
  const it = Number(r?.usage?.input_tokens ?? 0), ot = Number(r?.usage?.output_tokens ?? 0);
  supabase.from("bot_token_usage").insert({
    model: MODELO, input_tokens: it, output_tokens: ot, function_name: "lk_ia-puntaje", phone: fila.phone ?? null,
    estimated_cost_usd: (it * TARIFA.input + ot * TARIFA.output) / 1_000_000,
  }).then(() => {}, (e: unknown) => console.error("[puntaje] log de uso:", e));
  const texto = textoAnthropic(r?.content);
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: "respuesta sin JSON" };
  let p: Record<string, unknown>;
  try { p = JSON.parse(m[0]); } catch { return { ok: false, error: "JSON inválido" }; }
  const nota = (k: string) => { const n = Math.round(Number(p[k])); return n >= 1 && n <= 5 ? n : null; };
  const notas = Object.fromEntries(CRITERIOS.map((k) => [k, nota(k)]));
  if (Object.values(notas).some((v) => v === null)) return { ok: false, error: "faltan notas" };
  const { error } = await supabase.from("wa_ia_puntajes").update({
    ...notas, comentario: String(p.comentario ?? "").slice(0, 500), evaluado_at: new Date().toISOString(),
  }).eq("id", fila.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    let quien = "cron";
    if (!(await esLlamadaInterna(req))) {
      const gate = await requireAdmin(body);
      if (!gate.ok) return json({ error: gate.error }, gate.status);
      quien = gate.email;
    }

    if (body.action === "evaluar") {
      const apiKey = (await getSetting("ANTHROPIC_API_KEY")) ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
      if (!apiKey) return json({ ok: false, error: "Falta ANTHROPIC_API_KEY" }, 200);
      const { data: pend } = await supabase.from("wa_ia_puntajes").select("*")
        .is("evaluado_at", null).lt("intentos", 3).order("created_at", { ascending: true }).limit(POR_CORRIDA);
      let ok = 0; const errores: string[] = [];
      for (const f of pend ?? []) {
        let r: { ok: boolean; error?: string };
        try { r = await evaluarUna(f, apiKey); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
        if (r.ok) ok++;
        else {
          errores.push(`${f.id}: ${r.error}`);
          await supabase.from("wa_ia_puntajes").update({ intentos: Number(f.intentos ?? 0) + 1 }).eq("id", f.id);
        }
      }
      if (errores.length) console.error("[puntaje] errores:", errores.join(" | "));
      return json({ ok: true, evaluadas: ok, con_error: errores.length, por: quien });
    }

    if (body.action === "list") {
      const dias = Math.min(90, Math.max(1, Number(body.dias ?? 7)));
      const desde = new Date(Date.now() - dias * 86400_000).toISOString();
      // Las del Simulador (prueba) aparecen en la lista con 🧪 pero no cuentan en los promedios.
      const [{ data: rev }, { data: todas }, { data: gasto }, { count: pendientes }] = await Promise.all([
        supabase.from("wa_ia_puntajes").select("id, created_at, phone, customer_id, pregunta, respuesta, herramientas, correcta, resolvio, derivo, reglas, tono, minimo, comentario, prueba")
          .lte("minimo", 2).is("revision", null).order("created_at", { ascending: false }).limit(50),
        supabase.from("wa_ia_puntajes").select("correcta, resolvio, derivo, reglas, tono, minimo, revision")
          .gte("created_at", desde).not("evaluado_at", "is", null).eq("prueba", false).limit(5000),
        supabase.from("bot_token_usage").select("estimated_cost_usd").eq("function_name", "lk_ia-puntaje").gte("created_at", desde).limit(10000),
        supabase.from("wa_ia_puntajes").select("id", { count: "exact", head: true }).is("evaluado_at", null).lt("intentos", 3),
      ]);
      const ids = [...new Set((rev ?? []).map((r) => r.customer_id).filter(Boolean))];
      const nombres: Record<string, string> = {};
      if (ids.length) {
        const { data: cs } = await supabase.from("customers").select("id, cod_cliente, business_name").in("id", ids);
        for (const c of cs ?? []) nombres[c.id] = `${c.business_name} (${c.cod_cliente})`;
      }
      const n = (todas ?? []).length;
      const prom = Object.fromEntries(CRITERIOS.map((k) => [k, n ? Math.round(10 * (todas ?? []).reduce((a, r) => a + Number(r[k] ?? 0), 0) / n) / 10 : null]));
      return json({
        ok: true, dias, evaluadas: n, pendientes: pendientes ?? 0,
        bajas: (todas ?? []).filter((r) => Number(r.minimo) <= 2).length,
        bien_marcadas: (todas ?? []).filter((r) => r.revision === "bien_marcada").length,
        promedios: prom,
        gasto_usd: Math.round(100 * (gasto ?? []).reduce((a, g) => a + Number(g.estimated_cost_usd ?? 0), 0)) / 100,
        revisar: (rev ?? []).map((r) => ({ ...r, cliente: r.customer_id ? nombres[r.customer_id] ?? null : null })),
      });
    }

    // Pablo, 29/09: tablero de gasto de IA por día y por motivo (bot_token_usage; motivo desde sql/107).
    //   {action:"gasto", dias?} → por_dia: [{dia, uso, usd, llamadas}] · por_motivo: [{motivo, usd, llamadas}] (sólo clientes)
    if (body.action === "gasto") {
      const dias = Math.min(90, Math.max(1, Number(body.dias ?? 14)));
      const desde = new Date(Date.now() - dias * 86400_000).toISOString();
      const { data, error } = await supabase.from("bot_token_usage")
        .select("created_at, function_name, motivo, estimated_cost_usd").gte("created_at", desde).limit(20000);
      if (error) return json({ ok: false, error: error.message }, 200);
      const USO: Record<string, string> = { "lk_whatsapp-webhook": "clientes", "lk_bot-simular": "simulador", "lk_chat-test": "simulador", "lk_ia-puntaje": "puntaje" };
      const dia = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(iso));
      const pd: Record<string, Record<string, { usd: number; n: number }>> = {};
      const pm: Record<string, { usd: number; n: number }> = {};
      for (const r of data ?? []) {
        const uso = USO[String(r.function_name ?? "")] ?? "otros";
        const d = dia(r.created_at);
        const usd = Number(r.estimated_cost_usd ?? 0);
        pd[d] ??= {}; pd[d][uso] ??= { usd: 0, n: 0 }; pd[d][uso].usd += usd; pd[d][uso].n++;
        if (uso === "clientes") { const m = String(r.motivo ?? "sin_motivo"); pm[m] ??= { usd: 0, n: 0 }; pm[m].usd += usd; pm[m].n++; }
      }
      const r2 = (n: number) => Math.round(n * 100) / 100;
      return json({
        ok: true, dias,
        por_dia: Object.entries(pd).sort((a, b) => b[0].localeCompare(a[0]))
          .map(([d, u]) => ({ dia: d, ...Object.fromEntries(Object.entries(u).map(([k, v]) => [k, { usd: r2(v.usd), llamadas: v.n }])) })),
        por_motivo: Object.entries(pm).map(([m, v]) => ({ motivo: m, usd: r2(v.usd), llamadas: v.n })).sort((a, b) => b.usd - a.usd),
      });
    }

    if (body.action === "marcar") {
      const id = Number(body.id);
      const revision = String(body.revision ?? "");
      if (!id || !["bien_marcada", "falsa_alarma"].includes(revision)) return json({ ok: false, error: "parámetros inválidos" }, 400);
      const { error } = await supabase.from("wa_ia_puntajes").update({
        revision, revisado_por: quien, revisado_at: new Date().toISOString(), nota_revision: body.nota ? String(body.nota).slice(0, 500) : null,
      }).eq("id", id);
      return json(error ? { ok: false, error: error.message } : { ok: true });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_ia-puntaje error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
