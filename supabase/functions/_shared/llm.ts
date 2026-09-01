// _shared/llm.ts — Llamador central de LLMs con:
//   • Timeout (AbortController) para no colgar el edge function
//   • Chain de failover leída de wa_agente_modelos (prioridad ASC)
//   • Cooldown por modelo caído (5 min por defecto)
//   • Soporte anthropic / openai / google (Gemini)
//   • Log a bot_token_usage
//
// Los llamadores (detectIntent, conversationalReply, claudeMessage) ahora
// consumen este módulo. Si la cadena está vacía o todos los modelos fallan,
// cae al env ANTHROPIC_API_KEY con el model_id pasado como fallback (para
// mantener compatibilidad con la versión anterior).

import { supabase } from "./supabase.ts";

// ── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 30_000;
const COOLDOWN_MS = 5 * 60_000; // 5 min

// Precios USD por 1M tokens (input/output) — extender según sea necesario.
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-haiku-4-5":            { input: 1.0,  output: 5.0  },
  "claude-haiku-4-5-20251001":   { input: 1.0,  output: 5.0  },
  "claude-sonnet-4-6":           { input: 3.0,  output: 15.0 },
  "claude-sonnet-4-6-20250514":  { input: 3.0,  output: 15.0 },
  // OpenAI (representativo — se puede ajustar)
  "gpt-4o-mini":                 { input: 0.15, output: 0.60 },
  "gpt-4o":                      { input: 2.50, output: 10.0 },
  // Google
  "gemini-2.0-flash-lite":       { input: 0.075,output: 0.30 },
  "gemini-2.5-flash-lite":       { input: 0.10, output: 0.40 },
  "gemini-2.5-flash":            { input: 0.30, output: 2.50 },
};

// ── Tipos ────────────────────────────────────────────────────────────────────
export type Msg = { role: string; content: string };

export interface LlmCallOpts {
  system?: string;
  messages: Msg[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /**
   * Si se pasa, salta la chain y usa ese proveedor+modelo+key directamente.
   * Útil para retrocompatibilidad (claudeMessage con apiKey/model explícitos).
   */
  pinned?: { provider: "anthropic" | "openai" | "google"; model: string; apiKey: string };
}

export interface LlmCallResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface ChainRow {
  id: number;
  proveedor: string;
  model_id: string;
  key_source: string; // 'env' | 'db'
  secret_ref: string | null;
  api_key: string | null;
  is_free_tier: boolean;
  daily_request_limit: number | null;
  daily_token_limit: number | null;
  rpm_limit: number | null;
}

// ── Chain ────────────────────────────────────────────────────────────────────
async function loadChain(): Promise<ChainRow[]> {
  try {
    // Nota: join manual — evitamos la sintaxis PostgREST "!inner" para no
    // pelearnos con el esquema. Dos queries chicas.
    const { data: mods } = await supabase
      .from("wa_agente_modelos")
      .select("id, proveedor, model_id, key_id, prioridad, estado, cooldown_hasta, is_free_tier, daily_request_limit, daily_token_limit, rpm_limit")
      .not("prioridad", "is", null)
      .order("prioridad", { ascending: true });
    const rows = mods ?? [];
    if (!rows.length) return [];

    const now = Date.now();
    const usable = rows.filter((r) => {
      if (r.estado !== "ok") return false;
      if (r.cooldown_hasta && new Date(r.cooldown_hasta).getTime() > now) return false;
      return true;
    });
    if (!usable.length) return [];

    const keyIds = [...new Set(usable.map((r) => r.key_id).filter(Boolean))];
    const { data: keys } = await supabase
      .from("wa_agente_model_keys")
      .select("id, key_source, secret_ref, api_key")
      .in("id", keyIds);
    const keyById = new Map((keys ?? []).map((k) => [k.id, k]));

    return usable.map((m) => {
      const k = keyById.get(m.key_id);
      return {
        id: m.id,
        proveedor: m.proveedor,
        model_id: m.model_id,
        key_source: k?.key_source ?? "env",
        secret_ref: k?.secret_ref ?? null,
        api_key: k?.api_key ?? null,
        is_free_tier: !!m.is_free_tier,
        daily_request_limit: m.daily_request_limit ?? null,
        daily_token_limit: m.daily_token_limit ?? null,
        rpm_limit: m.rpm_limit ?? null,
      };
    });
  } catch (e) {
    console.error("[llm.loadChain]", e);
    return [];
  }
}

function resolveKey(row: ChainRow): string {
  if (row.key_source === "env") {
    return Deno.env.get(row.secret_ref ?? "") ?? "";
  }
  return row.api_key ?? "";
}

async function markDown(id: number, msg: string, untilOverride?: Date) {
  const until = (untilOverride ?? new Date(Date.now() + COOLDOWN_MS)).toISOString();
  try {
    await supabase.from("wa_agente_modelos").update({
      estado: "caido",
      cooldown_hasta: until,
      ultimo_error: msg.slice(0, 500),
    }).eq("id", id);
  } catch (e) {
    console.error("[llm.markDown]", e);
  }
}

/**
 * Chequea si el modelo se pasó de alguna cuota. Devuelve un motivo
 * (string) si se pasó, o null si está OK.
 */
async function checkQuota(row: ChainRow): Promise<{ reason: string; until: Date } | null> {
  const now = new Date();

  // rpm — ventana móvil de 60s
  if (row.rpm_limit != null) {
    const since = new Date(now.getTime() - 60_000).toISOString();
    const { count } = await supabase
      .from("bot_token_usage")
      .select("id", { count: "exact", head: true })
      .eq("model", row.model_id)
      .gte("created_at", since);
    if ((count ?? 0) >= row.rpm_limit) {
      return { reason: `rpm_limit ${row.rpm_limit} alcanzado`, until: new Date(now.getTime() + 60_000) };
    }
  }

  // daily — desde inicio del día UTC
  if (row.daily_request_limit != null || row.daily_token_limit != null) {
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60_000);

    if (row.daily_request_limit != null) {
      const { count } = await supabase
        .from("bot_token_usage")
        .select("id", { count: "exact", head: true })
        .eq("model", row.model_id)
        .gte("created_at", startOfDay.toISOString());
      if ((count ?? 0) >= row.daily_request_limit) {
        return { reason: `daily_request_limit ${row.daily_request_limit} alcanzado`, until: endOfDay };
      }
    }

    if (row.daily_token_limit != null) {
      const { data } = await supabase
        .from("bot_token_usage")
        .select("input_tokens, output_tokens")
        .eq("model", row.model_id)
        .gte("created_at", startOfDay.toISOString());
      const used = (data ?? []).reduce((acc, r) => acc + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
      if (used >= row.daily_token_limit) {
        return { reason: `daily_token_limit ${row.daily_token_limit} alcanzado (usados ${used})`, until: endOfDay };
      }
    }
  }

  return null;
}

// ── Fetch con timeout ────────────────────────────────────────────────────────
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`Timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Providers ────────────────────────────────────────────────────────────────
async function callAnthropic(
  key: string,
  model: string,
  opts: LlmCallOpts,
  timeoutMs: number,
): Promise<LlmCallResult> {
  const r = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0,
        system: opts.system,
        messages: opts.messages,
      }),
    },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return {
    text: d.content?.[0]?.text ?? "",
    provider: "anthropic",
    model,
    inputTokens: d.usage?.input_tokens ?? 0,
    outputTokens: d.usage?.output_tokens ?? 0,
  };
}

async function callOpenAI(
  key: string,
  model: string,
  opts: LlmCallOpts,
  timeoutMs: number,
): Promise<LlmCallResult> {
  // Traducimos system → primer mensaje "system"
  const msgs: { role: string; content: string }[] = [];
  if (opts.system) msgs.push({ role: "system", content: opts.system });
  msgs.push(...opts.messages);
  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0,
        messages: msgs,
      }),
    },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return {
    text: d.choices?.[0]?.message?.content ?? "",
    provider: "openai",
    model,
    inputTokens: d.usage?.prompt_tokens ?? 0,
    outputTokens: d.usage?.completion_tokens ?? 0,
  };
}

async function callGoogle(
  key: string,
  model: string,
  opts: LlmCallOpts,
  timeoutMs: number,
): Promise<LlmCallResult> {
  // Gemini API: system_instruction separado, contents = [{role,parts:[{text}]}]
  // roles válidos: "user" / "model"
  const contents = opts.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0,
      maxOutputTokens: opts.maxTokens ?? 1024,
    },
  };
  if (opts.system) {
    body.systemInstruction = { role: "user", parts: [{ text: opts.system }] };
  }
  const r = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`Google ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  // deno-lint-ignore no-explicit-any
  const parts: any[] = d.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p?.text ?? "").join("");
  return {
    text,
    provider: "google",
    model,
    inputTokens: d.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: d.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function callByProvider(
  provider: string,
  key: string,
  model: string,
  opts: LlmCallOpts,
  timeoutMs: number,
): Promise<LlmCallResult> {
  if (provider === "anthropic") return callAnthropic(key, model, opts, timeoutMs);
  if (provider === "openai")    return callOpenAI(key, model, opts, timeoutMs);
  if (provider === "google")    return callGoogle(key, model, opts, timeoutMs);
  throw new Error(`Proveedor no soportado: ${provider}`);
}

// ── Log ──────────────────────────────────────────────────────────────────────
function logUsage(res: LlmCallResult, isFreeTier = false) {
  // Costo 0 si el modelo está flagueado como free tier — el medidor lo
  // muestra sin plata aunque el rate del código diga otra cosa.
  const rates = isFreeTier ? { input: 0, output: 0 } : (COST_PER_MTOK[res.model] ?? { input: 3, output: 15 });
  const cost = (res.inputTokens * rates.input + res.outputTokens * rates.output) / 1_000_000;
  supabase.from("bot_token_usage").insert({
    model: res.model,
    input_tokens: res.inputTokens,
    output_tokens: res.outputTokens,
    estimated_cost_usd: cost,
  }).then(() => {}).catch((e: unknown) => console.error("token log err:", e));
}

// ── API pública ──────────────────────────────────────────────────────────────
export async function llmCall(opts: LlmCallOpts): Promise<LlmCallResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Camino pinned: sin chain, sin failover. Solo timeout + log.
  if (opts.pinned) {
    const res = await callByProvider(opts.pinned.provider, opts.pinned.apiKey, opts.pinned.model, opts, timeoutMs);
    logUsage(res);
    return res;
  }

  // Camino chain
  const chain = await loadChain();

  const errors: string[] = [];
  for (const row of chain) {
    // Pre-check de cuotas (free tier / diarias / rpm). Si se pasó,
    // marcamos "caido" con cooldown hasta el fin del período y saltamos.
    const quota = await checkQuota(row);
    if (quota) {
      errors.push(`${row.proveedor}/${row.model_id}: ${quota.reason}`);
      await markDown(row.id, quota.reason, quota.until);
      continue;
    }

    const key = resolveKey(row);
    if (!key) {
      errors.push(`${row.proveedor}/${row.model_id}: sin key resoluble`);
      await markDown(row.id, "Sin key resoluble");
      continue;
    }
    try {
      const res = await callByProvider(row.proveedor, key, row.model_id, opts, timeoutMs);
      logUsage(res, row.is_free_tier);
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[llm] ${row.proveedor}/${row.model_id} falló: ${msg}`);
      errors.push(`${row.proveedor}/${row.model_id}: ${msg}`);
      await markDown(row.id, msg);
      // sigue al próximo
    }
  }

  // Fallback duro: env ANTHROPIC_API_KEY con Sonnet (backward-compat).
  const envKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (envKey) {
    const model = "claude-sonnet-4-6";
    const res = await callByProvider("anthropic", envKey, model, opts, timeoutMs);
    logUsage(res);
    return res;
  }

  throw new Error(`LLM: toda la chain falló y no hay ANTHROPIC_API_KEY en env. Errores: ${errors.join(" | ")}`);
}
