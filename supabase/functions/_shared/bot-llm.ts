// _shared/bot-llm.ts — Motor conversacional con TOOLS multi-proveedor + cadena de failover.
//
// Lo usa `bot-conversation.ts` (runConversation). A diferencia de `llm.ts` (que sólo hace
// texto), acá soportamos el loop agéntico con herramientas para anthropic / google (Gemini) /
// openai, resolviendo la cadena de `wa_agente_modelos` (prioridad ASC).
//
// Clave del diseño: el HISTORIAL se mantiene NORMALIZADO (agnóstico de proveedor) y cada
// adaptador lo traduce entero en cada llamada. Por eso el failover puede pasar de un proveedor
// a otro EN CUALQUIER iteración del loop sin romper el historial: los tool_call llevan un id
// sintético que Anthropic/OpenAI usan para aparear y Gemini ignora (aparea por nombre).
//
// Cada llamada a un modelo se loguea en `bot_token_usage` (input/output tokens + costo estimado),
// así el panel "IA — gastos y uso" muestra datos reales. Un modelo que falla por su culpa
// (401/403/404/429/5xx/timeout) se marca `caido` con cooldown; un 400/413/422 es culpa del
// request (payload) y NO penaliza al modelo.

import { supabase } from "./supabase.ts";

const COOLDOWN_MS = 5 * 60_000; // 5 min
const DEFAULT_TIMEOUT_MS = 30_000;

// Precios USD por 1M tokens (input/output). Si el modelo no está acá se asume caro (3/15)
// para no subestimar; los free-tier se loguean en $0 por su flag.
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 2.50, output: 10.0 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.30 },
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "gemini-2.5-flash": { input: 0.30, output: 2.50 },
};

// deno-lint-ignore no-explicit-any
export type ToolDef = { name: string; description: string; input_schema: any };

export type NormToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  // Sólo Gemini 3.x: firma opaca que el modelo adjunta a cada functionCall y que HAY que
  // devolverle en el turno siguiente, o rechaza el request con 400. Los demás la ignoran.
  thoughtSignature?: string;
};
export type NormMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: NormToolCall[] }
  | { role: "tool"; results: { id: string; name: string; content: string }[] };

export interface ModelResult {
  text: string;
  toolCalls: NormToolCall[];
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
}

export interface ResolvedModel {
  id: number; // wa_agente_modelos.id (0 = fallback duro de env, no se marca)
  provider: string;
  model: string;
  key: string;
  isFreeTier: boolean;
}

// ── Cadena ─────────────────────────────────────────────────────────────────────
/** Modelos usables (estado ok, sin cooldown vigente, con key resoluble), prioridad ASC. */
export async function resolveChain(): Promise<ResolvedModel[]> {
  try {
    const { data: mods } = await supabase
      .from("wa_agente_modelos")
      .select("id, proveedor, model_id, key_id, prioridad, estado, cooldown_hasta, is_free_tier")
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
    // deno-lint-ignore no-explicit-any
    const keyById = new Map<number, any>((keys ?? []).map((k) => [k.id, k]));

    const out: ResolvedModel[] = [];
    for (const m of usable) {
      const k = keyById.get(m.key_id);
      const key = k?.key_source === "env" ? (Deno.env.get(k?.secret_ref ?? "") ?? "") : (k?.api_key ?? "");
      if (!key) continue; // sin credencial → no sirve
      out.push({
        id: m.id,
        provider: m.proveedor,
        model: m.model_id,
        key,
        isFreeTier: !!m.is_free_tier,
      });
    }
    return out;
  } catch (e) {
    console.error("[bot-llm.resolveChain]", e);
    return [];
  }
}

export async function markModelDown(id: number, msg: string) {
  if (!id) return; // 0 = fallback de env, no existe fila
  try {
    await supabase.from("wa_agente_modelos").update({
      estado: "caido",
      cooldown_hasta: new Date(Date.now() + COOLDOWN_MS).toISOString(),
      ultimo_error: msg.slice(0, 500),
    }).eq("id", id);
  } catch (e) {
    console.error("[bot-llm.markModelDown]", e);
  }
}

export function logUsage(res: ModelResult, isFreeTier: boolean, phone: string | null, fnName: string) {
  const rates = isFreeTier ? { input: 0, output: 0 } : (COST_PER_MTOK[res.model] ?? { input: 3, output: 15 });
  const cost = (res.inputTokens * rates.input + res.outputTokens * rates.output) / 1_000_000;
  supabase.from("bot_token_usage").insert({
    model: res.model,
    input_tokens: res.inputTokens,
    output_tokens: res.outputTokens,
    estimated_cost_usd: cost,
    function_name: fnName,
    phone,
  }).then(() => {}).catch((e: unknown) => console.error("[bot-llm.logUsage]", e));
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

function httpError(provider: string, status: number, body: string): Error {
  return Object.assign(new Error(`${provider} ${status}: ${body.slice(0, 300)}`), { status });
}

// ── Anthropic ────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
function toAnthropicMessages(history: NormMsg[]): any[] {
  // deno-lint-ignore no-explicit-any
  const msgs: any[] = [];
  for (const m of history) {
    if (m.role === "user") {
      msgs.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      // deno-lint-ignore no-explicit-any
      const content: any[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      msgs.push({ role: "assistant", content });
    } else {
      msgs.push({
        role: "user",
        content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content })),
      });
    }
  }
  return msgs;
}

async function callAnthropic(
  key: string, model: string, system: string, tools: ToolDef[], history: NormMsg[], timeoutMs: number,
): Promise<ModelResult> {
  const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1024, system, tools, messages: toAnthropicMessages(history) }),
  }, timeoutMs);
  if (!r.ok) throw httpError("Anthropic", r.status, await r.text());
  const d = await r.json();
  // deno-lint-ignore no-explicit-any
  const content: any[] = d.content ?? [];
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const toolCalls: NormToolCall[] = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
  return {
    text, toolCalls,
    inputTokens: d.usage?.input_tokens ?? 0,
    outputTokens: d.usage?.output_tokens ?? 0,
    provider: "anthropic", model,
  };
}

// ── Google (Gemini) ────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
function toGeminiSchema(js: any): any {
  if (!js || typeof js !== "object") return undefined;
  // deno-lint-ignore no-explicit-any
  const out: any = {};
  if (js.type) out.type = String(js.type).toUpperCase(); // STRING / INTEGER / OBJECT / ARRAY…
  if (js.description) out.description = js.description;
  if (Array.isArray(js.enum)) out.enum = js.enum;
  if (js.items) out.items = toGeminiSchema(js.items);
  if (js.properties && typeof js.properties === "object") {
    // deno-lint-ignore no-explicit-any
    const props: any = {};
    for (const [k, v] of Object.entries(js.properties)) props[k] = toGeminiSchema(v);
    out.properties = props;
    if (Array.isArray(js.required)) out.required = js.required;
  }
  return out;
}

// deno-lint-ignore no-explicit-any
function toGeminiTools(tools: ToolDef[]): any[] {
  const decls = tools.map((t) => {
    const props = t.input_schema?.properties ?? {};
    const hasProps = props && Object.keys(props).length > 0;
    // Gemini rechaza `parameters` con properties vacío → omitirlo cuando no hay args.
    return hasProps
      ? { name: t.name, description: t.description, parameters: toGeminiSchema(t.input_schema) }
      : { name: t.name, description: t.description };
  });
  return [{ functionDeclarations: decls }];
}

// deno-lint-ignore no-explicit-any
function toGeminiContents(history: NormMsg[]): any[] {
  // deno-lint-ignore no-explicit-any
  const contents: any[] = [];
  for (const m of history) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.text }] });
    } else if (m.role === "assistant") {
      // deno-lint-ignore no-explicit-any
      const parts: any[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.toolCalls) {
        // deno-lint-ignore no-explicit-any
        const part: any = { functionCall: { name: tc.name, args: tc.input } };
        // Gemini 3.x exige devolver la firma que emitió, o rechaza con 400.
        if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
        parts.push(part);
      }
      contents.push({ role: "model", parts });
    } else {
      // functionResponse.response tiene que ser un objeto (struct); envolvemos el JSON crudo.
      contents.push({
        role: "user",
        parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.content } } })),
      });
    }
  }
  return contents;
}

async function callGoogle(
  key: string, model: string, system: string, tools: ToolDef[], history: NormMsg[], timeoutMs: number,
): Promise<ModelResult> {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiContents(history),
    tools: toGeminiTools(tools),
    generationConfig: { temperature: 0, maxOutputTokens: 1024 },
  };
  const r = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    timeoutMs,
  );
  if (!r.ok) throw httpError("Google", r.status, await r.text());
  const d = await r.json();
  // deno-lint-ignore no-explicit-any
  const parts: any[] = d.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("");
  const toolCalls: NormToolCall[] = parts
    .filter((p) => p?.functionCall)
    .map((p) => ({
      id: crypto.randomUUID(),
      name: p.functionCall.name,
      input: p.functionCall.args ?? {},
      // La firma viene como hermana del functionCall dentro del mismo part.
      thoughtSignature: p.thoughtSignature,
    }));
  return {
    text, toolCalls,
    inputTokens: d.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: d.usageMetadata?.candidatesTokenCount ?? 0,
    provider: "google", model,
  };
}

// ── OpenAI ─────────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
function toOpenAIMessages(system: string, history: NormMsg[]): any[] {
  // deno-lint-ignore no-explicit-any
  const msgs: any[] = [{ role: "system", content: system }];
  for (const m of history) {
    if (m.role === "user") {
      msgs.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      // deno-lint-ignore no-explicit-any
      const msg: any = { role: "assistant", content: m.text || null };
      if (m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id, type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }
      msgs.push(msg);
    } else {
      for (const r of m.results) msgs.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }
  return msgs;
}

async function callOpenAI(
  key: string, model: string, system: string, tools: ToolDef[], history: NormMsg[], timeoutMs: number,
): Promise<ModelResult> {
  const body = {
    model, max_tokens: 1024, temperature: 0,
    messages: toOpenAIMessages(system, history),
    tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
  };
  const r = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!r.ok) throw httpError("OpenAI", r.status, await r.text());
  const d = await r.json();
  const msg = d.choices?.[0]?.message ?? {};
  // deno-lint-ignore no-explicit-any
  const toolCalls: NormToolCall[] = (msg.tool_calls ?? []).map((tc: any) => {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { /* deja {} */ }
    return { id: tc.id, name: tc.function?.name, input };
  });
  return {
    text: msg.content ?? "",
    toolCalls,
    inputTokens: d.usage?.prompt_tokens ?? 0,
    outputTokens: d.usage?.completion_tokens ?? 0,
    provider: "openai", model,
  };
}

// ── Despacho ─────────────────────────────────────────────────────────────────
export async function callModel(
  m: ResolvedModel, system: string, tools: ToolDef[], history: NormMsg[], timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ModelResult> {
  if (m.provider === "anthropic") return callAnthropic(m.key, m.model, system, tools, history, timeoutMs);
  if (m.provider === "google") return callGoogle(m.key, m.model, system, tools, history, timeoutMs);
  if (m.provider === "openai") return callOpenAI(m.key, m.model, system, tools, history, timeoutMs);
  throw new Error(`Proveedor no soportado: ${m.provider}`);
}

/** 400/413/422 = el request está mal (nuestra culpa): no penaliza al modelo y no tiene sentido
 *  reintentar en otro (mismo error). El resto = culpa del modelo → failover. */
export function esCulpaDelRequest(status: number | undefined): boolean {
  return status === 400 || status === 413 || status === 422;
}
