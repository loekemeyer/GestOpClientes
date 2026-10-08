// _shared/bot-llm.ts — Motor conversacional con TOOLS multi-proveedor + cadena de failover.
//
// Lo usa `bot-conversation.ts` (runConversation). A diferencia de `llm.ts` (que sólo hace
// texto), acá soportamos el loop agéntico con herramientas para anthropic / google (Gemini) /
// openai y compatibles (groq, mistral), resolviendo la cadena de `wa_agente_modelos` (prioridad ASC).
//
// Clave del diseño: el HISTORIAL se mantiene NORMALIZADO (agnóstico de proveedor) y cada
// adaptador lo traduce entero en cada llamada. Por eso el failover puede pasar de un proveedor
// a otro EN CUALQUIER iteración del loop sin romper el historial: los tool_call llevan un id
// sintético que Anthropic/OpenAI usan para aparear y Gemini ignora (aparea por nombre).
//
// Cada llamada a un modelo se loguea en `bot_token_usage` (input/output tokens + costo estimado),
// así el panel "IA — gastos y uso" muestra datos reales. Un modelo que falla por su culpa
// (401/403/404/429/5xx/timeout) se marca `caido` con cooldown (5 min; un 429 por cuota por minuto, lo que pide Google: ver `cooldownParaError`); un 400/413/422 es culpa del
// request (payload) y NO penaliza al modelo.

import { supabase } from "./supabase.ts";
import { OPENAI_COMPAT, toOpenAIMessages } from "./openai-compat.ts";

const COOLDOWN_MS = 5 * 60_000; // 5 min
const COOLDOWN_429_MIN_MS = 60_000; // piso del cooldown de un 429 por cuota por minuto (ver cooldownParaError)
const DEFAULT_TIMEOUT_MS = 30_000;
// Largo máximo del error de un proveedor que se guarda (httpError y bot_llm_intentos.error). Con 300 caracteres el 429 de Google
// llegaba cortado antes del detalle (`QuotaFailure`: qué cuota exacta cortó), así que no se sabía si era por minuto, por tokens o por día.
const ERROR_MAX = 800;

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
  /** Tokens de entrada TOTALES (incluye los escritos y los leídos del caché de Anthropic). */
  inputTokens: number;
  outputTokens: number;
  /** Anthropic (08/10): de inputTokens, cuántos se escribieron en el caché (cuestan 1,25×) y cuántos se leyeron de él (0,1×). */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
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
    const cooldownVencido = (r: { cooldown_hasta: string | null }) =>
      !r.cooldown_hasta || new Date(r.cooldown_hasta).getTime() <= now;
    // Un modelo `caido` con el cooldown vencido se vuelve a probar: antes quedaba afuera para siempre (un solo 503
    // lo sacaba de la cadena). Si falla de nuevo, markModelDown lo marca otra vez con un cooldown nuevo.
    const usable = rows.filter((r) => {
      if (r.estado === "caido") return !!r.cooldown_hasta && cooldownVencido(r);
      if (r.estado !== "ok") return false;
      return cooldownVencido(r);
    });
    if (!usable.length) return [];
    const reactivar = usable.filter((r) => r.estado === "caido").map((r) => r.id);
    if (reactivar.length) {
      await supabase.from("wa_agente_modelos").update({ estado: "ok", cooldown_hasta: null }).in("id", reactivar);
    }

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

/** Un modelo puntual por su model_id, sin mirar prioridad ni estado: para el modelo de pruebas
 *  (app_settings.llm_modelo_pruebas). Sólo proveedores con key propia en wa_agente_model_keys; anthropic usa la key del
 *  env por otro camino. id -1 (distinto del 0 del fallback de env): nunca se marca caído. null si no existe o no tiene credencial. */
export async function resolveModelById(modelId: string): Promise<ResolvedModel | null> {
  try {
    const { data: rows } = await supabase
      .from("wa_agente_modelos")
      .select("proveedor, model_id, key_id, is_free_tier")
      .eq("model_id", modelId)
      .neq("proveedor", "anthropic")
      .not("key_id", "is", null)
      .limit(1);
    const m = rows?.[0];
    if (!m) return null;
    const { data: k } = await supabase
      .from("wa_agente_model_keys")
      .select("key_source, secret_ref, api_key")
      .eq("id", m.key_id)
      .maybeSingle();
    const key = k?.key_source === "env" ? (Deno.env.get(k?.secret_ref ?? "") ?? "") : (k?.api_key ?? "");
    if (!key) return null;
    return { id: -1, provider: m.proveedor, model: m.model_id, key, isFreeTier: !!m.is_free_tier };
  } catch (e) {
    console.error("[bot-llm.resolveModelById]", e);
    return null;
  }
}

/** Cuánto queda caído un modelo tras fallar. Un 429 de cuota por minuto (el plan gratis de Gemini: 15 por minuto, medido el 05/10) la libera
 *  Google en ~33 s y trae el "retry in Ns" en el error: se espera eso, con un piso de 60 s y sin pasar de COOLDOWN_MS. Antes todo 429 dejaba
 *  al modelo 5 minutos afuera y en ese lapso TODO iba a Sonnet, con costo. La cuota por día (`PerDay`) y los demás errores (401/403/404/5xx,
 *  timeout) siguen en COOLDOWN_MS: no se arreglan en un minuto. */
export function cooldownParaError(status: number | undefined, msg: string): number {
  if (status !== 429 || /PerDay/i.test(msg)) return COOLDOWN_MS;
  const m = msg.match(/retry in ([\d.]+)\s*s/i) ?? msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  const pedido = m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
  return Math.min(COOLDOWN_MS, Math.max(COOLDOWN_429_MIN_MS, pedido));
}

export async function markModelDown(id: number, msg: string, cooldownMs = COOLDOWN_MS) {
  if (!id || id < 0) return; // 0 = fallback de env, -1 = modelo de pruebas: no existe fila
  try {
    await supabase.from("wa_agente_modelos").update({
      estado: "caido",
      cooldown_hasta: new Date(Date.now() + cooldownMs).toISOString(),
      ultimo_error: msg.slice(0, 500),
    }).eq("id", id);
  } catch (e) {
    console.error("[bot-llm.markModelDown]", e);
  }
}

// Caché de Anthropic (08/10): escribir cuesta 1,25 veces la entrada y leer, 0,1 veces (TTL de 5 minutos). input_tokens se sigue guardando con el
// total, así el panel y los topes de tokens cuentan lo mismo que antes; el costo es el que cambia.
export const CACHE_ESCRITURA = 1.25;
export const CACHE_LECTURA = 0.1;
export function costoEstimado(res: Pick<ModelResult, "inputTokens" | "outputTokens" | "cacheWriteTokens" | "cacheReadTokens">,
  rates: { input: number; output: number }): number {
  const escritos = res.cacheWriteTokens ?? 0, leidos = res.cacheReadTokens ?? 0;
  const normales = Math.max(0, res.inputTokens - escritos - leidos);
  return ((normales + escritos * CACHE_ESCRITURA + leidos * CACHE_LECTURA) * rates.input + res.outputTokens * rates.output) / 1_000_000;
}

export function logUsage(res: ModelResult, isFreeTier: boolean, phone: string | null, fnName: string, motivo: string | null = null) {
  const rates = isFreeTier ? { input: 0, output: 0 } : (COST_PER_MTOK[res.model] ?? { input: 3, output: 15 });
  const cost = costoEstimado(res, rates);
  supabase.from("bot_token_usage").insert({
    model: res.model,
    input_tokens: res.inputTokens,
    output_tokens: res.outputTokens,
    estimated_cost_usd: cost,
    function_name: fnName,
    phone,
    motivo,   // sql/107: para qué consultó el cliente (tablero de gasto por motivo)
  }).then(() => {}).catch((e: unknown) => console.error("[bot-llm.logUsage]", e));
}

// ── Auditoría de intentos (sql/126) ──────────────────────────────────────────
// `bot_token_usage` sólo guarda las llamadas que salieron bien. Acá queda CADA intento, con su resultado, código HTTP y
// duración: es lo que permite saber cómo falla un modelo (429, 503, timeouts) y cuánto tarda. Sin teléfono ni texto del cliente.
export interface IntentoLlm {
  funcion: string; // lk_whatsapp-webhook / lk_bot-simular / lk_chat-test
  modeloId: number; // wa_agente_modelos.id; 0 = fallback de env (Sonnet), -1 = modelo de pruebas
  proveedor: string;
  modelo: string;
  tarea?: string | null;
  iteracion: number; // 1..5 dentro del turno
  ok: boolean;
  httpStatus?: number | null; // null en timeout o error de red
  error?: string | null;
  duracionMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** Un error de red de Deno incluye la URL del request, y la de Gemini lleva `?key=…`: la clave no se guarda. */
export function limpiarErrorLlm(msg: string): string {
  return msg.replace(/([?&]key=)[^&\s)"']+/gi, "$1***").slice(0, ERROR_MAX);
}

/** Registra un intento sin frenar ni romper la conversación (mismo criterio que `logUsage`). */
export function logIntento(i: IntentoLlm) {
  try {
    supabase.from("bot_llm_intentos").insert({
      funcion: i.funcion,
      modelo_id: i.modeloId,
      proveedor: i.proveedor,
      modelo: i.modelo,
      tarea: i.tarea ?? null,
      iteracion: i.iteracion,
      ok: i.ok,
      http_status: i.httpStatus ?? null,
      error: i.error ? limpiarErrorLlm(i.error) : null,
      duracion_ms: Math.round(i.duracionMs),
      input_tokens: i.inputTokens ?? null,
      output_tokens: i.outputTokens ?? null,
    }).then(
      ({ error }) => { if (error) console.error("[bot-llm.logIntento]", error.message); },
      (e: unknown) => console.error("[bot-llm.logIntento]", e),
    );
  } catch (e) {
    console.error("[bot-llm.logIntento]", e);
  }
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
  return Object.assign(new Error(`${provider} ${status}: ${body.slice(0, ERROR_MAX)}`), { status });
}

// ── Prompt del sistema ─────────────────────────────────────────────────────────
/** El prompt puede venir en dos partes (08/10): `estable` va en el system y se cachea; `variable` (lo que cambia con cada mensaje) va
 *  dentro del último mensaje del cliente, después del historial (contextoEnElTurno). `systemTexto` las junta como antes (filtro de salida). */
export type SystemPrompt = string | { estable: string; variable: string };
export function systemTexto(s: SystemPrompt): string {
  return typeof s === "string" ? s : [s.estable, s.variable].filter((x) => x && x.trim()).join("\n\n");
}

const CACHE = { type: "ephemeral" } as const;

// ── Contexto del turno (Pablo Olejavetzky, 08/10/2026: 2ª parte del caché) ──────────────────────────────────────────────────────
// La parte variable del prompt (nota de tiempo con la hora al minuto, ejemplos aprobados, pistas) cambia en CADA mensaje. Si va en el
// system queda ANTES del historial, le cambia el prefijo, y Anthropic vuelve a escribir el historial entero en caché (1,25×) en cada
// turno. Por eso va dentro del último mensaje del cliente, en un bloque marcado: el historial anterior queda igual de un turno al otro
// (con la ventana anclada de ventana-historial.ts) y el turno siguiente lo lee del caché a 0,1×. Va igual para todos los proveedores,
// así el Simulador con Gemini prueba el mismo armado que contesta Sonnet. El prompt (bloque de Seguridad) dice que sólo ese bloque
// viene del sistema; la etiqueta escrita por un cliente se desarma (desarmarEtiqueta).
export const CONTEXTO_ABRE = "<contexto_del_sistema>";
export const CONTEXTO_CIERRA = "</contexto_del_sistema>";

/** Un cliente no puede abrir ni cerrar un bloque de contexto falso: "<contexto_del_sistema" (o "</…", "＜…", con espacios o guiones)
 *  escrito por él pasa a "‹contexto_del_sistema", que el modelo no confunde con la etiqueta. */
export function desarmarEtiqueta(texto: string): string {
  return texto.replace(/[<＜](\s*\/?\s*contexto[\s_-]*del[\s_-]*sistema)/gi, "‹$1");
}

/** Arma lo que va al modelo: el system queda sólo con la parte estable y la variable pasa al último mensaje del cliente.
 *  `ultimoCliente` es la posición de ese mensaje en `history` (-1 si no hay): lo que está antes es el historial anterior.
 *  No modifica `history` (el loop de runConversation y el filtro de salida siguen usando el original). */
export function contextoEnElTurno(system: SystemPrompt, history: NormMsg[]): { system: string; history: NormMsg[]; ultimoCliente: number } {
  const h: NormMsg[] = history.map((m) => (m.role === "user" ? { role: "user", text: desarmarEtiqueta(m.text) } : m));
  let i = -1;
  for (let k = h.length - 1; k >= 0; k--) if (h[k].role === "user") { i = k; break; }
  if (typeof system === "string") return { system, history: h, ultimoCliente: i };
  const variable = system.variable.trim();
  if (!variable) return { system: system.estable, history: h, ultimoCliente: i };
  if (i < 0) return { system: systemTexto(system), history: h, ultimoCliente: i };   // sin mensaje del cliente (no pasa en el bot): como antes
  const actual = h[i] as { role: "user"; text: string };
  h[i] = { role: "user", text: `${CONTEXTO_ABRE}\n${variable}\n${CONTEXTO_CIERRA}\n\n${actual.text}` };
  return { system: system.estable, history: h, ultimoCliente: i };
}

// deno-lint-ignore no-explicit-any
function marcarCache(msgs: any[], i: number) {
  const m = msgs[i];
  if (!m || !Array.isArray(m.content) || !m.content.length) return;
  const c = [...m.content];
  c[c.length - 1] = { ...c[c.length - 1], cache_control: CACHE };
  msgs[i] = { ...m, content: c };
}

/** Cuerpo de la llamada a Anthropic con caché de prompt (Pablo, 08/10). Hasta cuatro marcas (el máximo de Anthropic):
 *  1) la última herramienta: las herramientas son iguales para todos los clientes;
 *  2) el prompt (sólo la parte estable): igual en todas las llamadas del turno y en los mensajes seguidos del mismo cliente;
 *  3) el fin del historial anterior (el mensaje justo antes del último del cliente): no cambia de un turno al otro, así que el turno
 *     siguiente lo lee del caché en vez de volver a escribirlo;
 *  4) el último mensaje: en el loop de herramientas, la llamada siguiente lee todo lo anterior del caché.
 *  Un prefijo más corto que el mínimo del modelo (1024 tokens en Sonnet 4.6, 4096 en Haiku 4.5) simplemente no se cachea: no da error. */
// deno-lint-ignore no-explicit-any
export function cuerpoAnthropic(model: string, system: SystemPrompt, tools: ToolDef[], history: NormMsg[]): Record<string, any> {
  const c = contextoEnElTurno(system, history);
  const sys = [{ type: "text", text: c.system, cache_control: CACHE }];
  const tl = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: CACHE } : t));
  const msgs = toAnthropicMessages(c.history);
  if (c.ultimoCliente > 0) marcarCache(msgs, c.ultimoCliente - 1);
  marcarCache(msgs, msgs.length - 1);
  return { model, max_tokens: 1024, system: sys, tools: tl, messages: msgs };
}

// ── Anthropic ────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
function toAnthropicMessages(history: NormMsg[]): any[] {
  // deno-lint-ignore no-explicit-any
  const msgs: any[] = [];
  for (const m of history) {
    if (m.role === "user") {
      // Siempre en bloques (como el asistente y los resultados de herramientas): así un mensaje se manda igual lleve o no la marca de caché.
      msgs.push({ role: "user", content: m.text ? [{ type: "text", text: m.text }] : m.text });
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
  key: string, model: string, system: SystemPrompt, tools: ToolDef[], history: NormMsg[], timeoutMs: number,
): Promise<ModelResult> {
  const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(cuerpoAnthropic(model, system, tools, history)),
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
    // Con caché, input_tokens trae sólo lo que no se escribió ni se leyó del caché: se guarda el total y el desglose (costoEstimado).
    inputTokens: (d.usage?.input_tokens ?? 0) + (d.usage?.cache_creation_input_tokens ?? 0) + (d.usage?.cache_read_input_tokens ?? 0),
    outputTokens: d.usage?.output_tokens ?? 0,
    cacheWriteTokens: d.usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: d.usage?.cache_read_input_tokens ?? 0,
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
  if (Array.isArray(js.enum)) {
    // Gemini sólo acepta `enum` en campos string (con valores string): rechaza con 400 un integer con enum [8, 9, …]
    // (condicion_code de las herramientas de pedido). En ese caso pasamos los valores válidos por la descripción.
    if (String(js.type ?? "string").toLowerCase() === "string") out.enum = js.enum.map(String);
    else out.description = `${out.description ? out.description + " " : ""}Valores válidos: ${js.enum.join(", ")}.`;
  }
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

// ── OpenAI y compatibles (Groq, Mistral): formato y URLs en openai-compat.ts ──────────────────
async function callOpenAI(
  provider: string, key: string, model: string, system: string, tools: ToolDef[], history: NormMsg[], timeoutMs: number,
): Promise<ModelResult> {
  const ep = OPENAI_COMPAT[provider];
  const body: Record<string, unknown> = {
    model, max_tokens: 1024, temperature: 0,
    messages: toOpenAIMessages(system, history, provider),
    tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
  };
  // gpt-oss razona y esos tokens salen del max_tokens: en "low" no se come el presupuesto de la respuesta.
  if (provider === "groq" && model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
  const r = await fetchWithTimeout(ep.url, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!r.ok) throw httpError(ep.label, r.status, await r.text());
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
    provider, model,
  };
}

// ── Despacho ─────────────────────────────────────────────────────────────────
export async function callModel(
  m: ResolvedModel, system: SystemPrompt, tools: ToolDef[], history: NormMsg[], timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ModelResult> {
  if (m.provider === "anthropic") return callAnthropic(m.key, m.model, system, tools, history, timeoutMs);
  // Mismo armado que Anthropic (contexto del turno en el último mensaje del cliente), así el Simulador con Gemini prueba lo mismo.
  const c = contextoEnElTurno(system, history);
  if (m.provider === "google") return callGoogle(m.key, m.model, c.system, tools, c.history, timeoutMs);
  if (OPENAI_COMPAT[m.provider]) return callOpenAI(m.provider, m.key, m.model, c.system, tools, c.history, timeoutMs);
  throw new Error(`Proveedor no soportado: ${m.provider}`);
}

/** 400/413/422 = el request está mal (nuestra culpa): no penaliza al modelo y no tiene sentido
 *  reintentar en otro (mismo error). El resto = culpa del modelo → failover. */
export function esCulpaDelRequest(status: number | undefined): boolean {
  return status === 400 || status === 413 || status === 422;
}
