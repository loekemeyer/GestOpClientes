// lk_memoria-cliente — arma la ficha de memoria de un cliente a partir de su historial de WhatsApp (Pablo Olejavetzky, 09/10/2026).
//
//   {action:"armar", clientes:[{marca:"LK"|"CH", cod_cli}], estado?:"prueba"}  → hasta MAX_POR_LLAMADA clientes. Lee
//       "Wpp_Historial_Clientes" (el historial importado), le pide a Haiku la ficha (_shared/memoria-cliente.ts) y la guarda en
//       wa_memoria_cliente (sql/137). Devuelve las fichas, los tokens y el costo.
//
// Las charlas asignadas a más de un cliente (87 de 613, 65 cruzan LK y Chef) NO se leen: la ficha de una empresa no puede
// traer lo que habló otra. Se cuentan en charlas_excluidas.
// El agente todavía no lee las fichas: primero las revisa Pablo (estado 'prueba').
// Gasto: cada llamada a Haiku queda en bot_token_usage con function_name 'lk_memoria-cliente'. Regla de gasto de CLAUDE.md: estimativo
// y "sí" de Pablo antes de cada tanda.
// Acceso: interno (x-lk-secret = LK_FN_CRON_SECRET) o admin del dashboard (access_token).

import { getSetting, supabase } from "../_shared/supabase.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { limpiarFicha, type MensajeHist, sistemaFicha, textoHistorial } from "../_shared/memoria-cliente.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lk-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MODELO = "claude-haiku-4-5-20251001";
const TARIFA = { input: 1.0, output: 5.0 }; // US$ por millón de tokens
const MAX_POR_LLAMADA = 10;
const EMPRESA: Record<string, string> = { LK: "Loekemeyer", CH: "Chef" };

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

// deno-lint-ignore no-explicit-any
async function armarUna(marca: string, cod: number, apiKey: string, estado: string): Promise<Record<string, any>> {
  const { data: links, error: eL } = await supabase.from("Wpp_Conversaciones_Clientes")
    .select("conversacion_id").eq("marca", marca).eq("cod_cli", cod);
  if (eL) return { marca, cod_cli: cod, ok: false, error: eL.message };
  const ids = [...new Set((links ?? []).map((l) => Number(l.conversacion_id)))];
  if (!ids.length) return { marca, cod_cli: cod, ok: false, error: "sin historial" };
  const { data: todos } = await supabase.from("Wpp_Conversaciones_Clientes").select("conversacion_id").in("conversacion_id", ids);
  const usos = new Map<number, number>();
  for (const t of todos ?? []) usos.set(Number(t.conversacion_id), (usos.get(Number(t.conversacion_id)) ?? 0) + 1);
  const propias = ids.filter((id) => (usos.get(id) ?? 0) === 1);
  const excluidas = ids.length - propias.length;
  if (!propias.length) return { marca, cod_cli: cod, ok: false, error: "todas sus charlas son compartidas", charlas_excluidas: excluidas };

  const { data: msgs, error: eM } = await supabase.from("Wpp_Historial_Clientes")
    .select("rol, contenido, creado_en").in("conversacion_id", propias).order("creado_en", { ascending: true }).limit(5000);
  if (eM) return { marca, cod_cli: cod, ok: false, error: eM.message };
  const lista = (msgs ?? []) as MensajeHist[];
  const empresa = EMPRESA[marca];
  const { texto } = textoHistorial(lista, empresa);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODELO, max_tokens: 600, temperature: 0, system: sistemaFicha(empresa),
      messages: [{ role: "user", content: `Historial de WhatsApp del cliente:\n\n${texto}` }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return { marca, cod_cli: cod, ok: false, error: `Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const r = await res.json();
  const it = Number(r?.usage?.input_tokens ?? 0), ot = Number(r?.usage?.output_tokens ?? 0);
  const costo = (it * TARIFA.input + ot * TARIFA.output) / 1_000_000;
  await supabase.from("bot_token_usage").insert({
    model: MODELO, input_tokens: it, output_tokens: ot, function_name: "lk_memoria-cliente", phone: null,
    estimated_cost_usd: costo, motivo: "memoria_cliente",
  });
  const ficha = limpiarFicha(String(r?.content?.[0]?.text ?? ""));
  if (!ficha) return { marca, cod_cli: cod, ok: false, error: "respuesta vacía" };

  const fila = {
    marca, cod_cli: cod, ficha, mensajes: lista.length,
    desde: lista[0]?.creado_en ?? null, hasta: lista[lista.length - 1]?.creado_en ?? null,
    charlas_excluidas: excluidas, modelo: MODELO, input_tokens: it, output_tokens: ot, costo_usd: costo,
    estado, generada_en: new Date().toISOString(),
  };
  const { error: eU } = await supabase.from("wa_memoria_cliente").upsert(fila, { onConflict: "marca,cod_cli" });
  if (eU) return { marca, cod_cli: cod, ok: false, error: eU.message, ficha };
  return { ok: true, ...fila };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    if (!(await esLlamadaInterna(req))) {
      const gate = await requireAdmin(body);
      if (!gate.ok) return json({ error: gate.error }, gate.status);
    }

    if (body.action === "armar") {
      const clientes = (Array.isArray(body.clientes) ? body.clientes : [])
        .map((c: { marca?: string; cod_cli?: number }) => ({ marca: String(c?.marca ?? "").toUpperCase(), cod: Number(c?.cod_cli) }))
        .filter((c: { marca: string; cod: number }) => (c.marca === "LK" || c.marca === "CH") && Number.isInteger(c.cod) && c.cod > 0);
      if (!clientes.length) return json({ ok: false, error: "clientes vacío: [{marca:'LK'|'CH', cod_cli}]" }, 400);
      if (clientes.length > MAX_POR_LLAMADA) return json({ ok: false, error: `máximo ${MAX_POR_LLAMADA} clientes por llamada` }, 400);
      const estado = ["prueba", "aprobada"].includes(body.estado) ? body.estado : "prueba";
      const apiKey = (await getSetting("ANTHROPIC_API_KEY")) ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
      if (!apiKey) return json({ ok: false, error: "Falta ANTHROPIC_API_KEY" }, 200);
      // deno-lint-ignore no-explicit-any
      const salida: Record<string, any>[] = [];
      for (const c of clientes) {
        try { salida.push(await armarUna(c.marca, c.cod, apiKey, estado)); }
        catch (e) { salida.push({ marca: c.marca, cod_cli: c.cod, ok: false, error: e instanceof Error ? e.message : String(e) }); }
      }
      const costo = salida.reduce((a, s) => a + Number(s.costo_usd ?? 0), 0);
      return json({ ok: true, armadas: salida.filter((s) => s.ok).length, costo_usd: Math.round(costo * 1e6) / 1e6, fichas: salida });
    }

    return json({ ok: false, error: "action desconocida" }, 400);
  } catch (e) {
    console.error("[memoria-cliente]", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
