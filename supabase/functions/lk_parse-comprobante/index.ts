// lk_parse-comprobante — Parser de comprobantes de pago con visión.
//
// Cadena de modelos leída de wa_agente_modelos WHERE tarea='parse_comprobante'
// (ORDER BY prioridad ASC). Primario: Claude Haiku 4.5 (vision). Fallback:
// Gemini 2.5 Flash (free tier). En caída del primario: cooldown 5 min y sigue.
//
// El schema del JSON de salida es intencionalmente FLEXIBLE en el "resto" de
// los campos (los comprobantes argentinos varían mucho: MP, transferencia,
// cheque, POS, depósito, QR…). Solo son estrictos: `monto_total` (para poder
// matchear) y `es_comprobante`/`confianza` (para saber si vale la pena seguir).
//
// Acciones (POST JSON):
//   { action:"parse", comprobante_id:"uuid" }
//       → descarga el archivo del bucket wa-comprobantes (según storage_path
//         de la fila), lo pasa al modelo, y actualiza la fila con los datos
//         extraídos + status.
//   { action:"parse_inline", data_b64:"…", mime_type:"image/png" }
//       → parsea sin tocar tabla (para testing/curl).
//   { action:"chain_status" }
//       → devuelve la cadena activa y último error de cada modelo.
//
// verify_jwt=false (llamada interna desde el webhook o desde el dashboard).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DEFAULT_TIMEOUT_MS = 45_000;
const COOLDOWN_MS = 5 * 60_000;
const MAX_IMG_BYTES = 5 * 1024 * 1024;  // Anthropic vision recomienda <5MB

const SYSTEM_PROMPT = `Sos un extractor experto de comprobantes de pago argentinos (transferencias bancarias, MercadoPago, cheques, depósitos, pagos con QR, cupones POS, boletas de pago, etc.).

Tu única tarea: leer el archivo y devolver un JSON válido con este schema.

SCHEMA (respondé SOLO el JSON, sin markdown, sin texto adicional):

{
  "es_comprobante": boolean,          // true si es un comprobante de pago legítimo
  "confianza": number,                // 0.0 a 1.0 — qué tan seguro estás del parseo
  "tipo": "transferencia" | "mercadopago" | "cheque" | "deposito" | "pos" | "qr" | "otro" | null,
  "monto_total": number | null,       // OBLIGATORIO cuando es_comprobante=true. En pesos, sin separadores, sin símbolo. Ej: 12345.67
  "moneda": "ARS" | "USD" | "OTRA",
  "fecha_operacion": "YYYY-MM-DD" | null,
  "resto": {
    // Cualquier dato adicional relevante — variables según el tipo de comprobante.
    // Ejemplos (usá los que apliquen, agregá los que veas):
    //   banco_origen, banco_destino, titular_origen, titular_destino,
    //   cbu, cvu, alias, cuit_origen, cuit_destino,
    //   numero_operacion, numero_referencia, numero_cheque,
    //   codigo_barras, medio_pago, observaciones, etc.
  }
}

REGLAS:
1. Sé LIBERAL sobre "resto" — extraé todo dato útil que veas.
2. Sé ESTRICTO sobre "monto_total": solo devolvé un número real y verificado. Si no lo podés leer con certeza, dejalo null y bajá la confianza.
3. Si el archivo NO es un comprobante de pago (foto random, meme, documento no relacionado), devolvé:
   {"es_comprobante": false, "confianza": <0-0.3>, "tipo": null, "monto_total": null, "moneda": "ARS", "fecha_operacion": null, "resto": {"motivo": "no es comprobante"}}
4. Nunca inventes datos. Preferí null y baja confianza a un valor equivocado.
5. Respondé SOLO el JSON. No agregues explicaciones, markdown, ni texto antes/después.`;

const USER_PROMPT = "Extraé los datos de este comprobante según el schema.";

// ── Utils ────────────────────────────────────────────────────────────────
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`Timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// deno-lint-ignore no-explicit-any
function extractFirstJson(text: string): any {
  // El modelo puede devolver el JSON envuelto en ```json … ``` o con texto
  // alrededor. Buscamos el primer bloque válido.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("El modelo no devolvió JSON");
  const slice = candidate.slice(start, end + 1);
  return JSON.parse(slice);
}

// ── Chain loading ────────────────────────────────────────────────────────
interface ChainRow {
  id: number;
  proveedor: string;
  model_id: string;
  key_source: string;
  secret_ref: string | null;
  api_key: string | null;
  is_free_tier: boolean;
}

async function loadChain(): Promise<ChainRow[]> {
  const { data: mods } = await sb
    .from("wa_agente_modelos")
    .select("id, proveedor, model_id, key_id, prioridad, estado, cooldown_hasta, is_free_tier")
    .eq("tarea", "parse_comprobante")
    .eq("activo", true)
    .not("prioridad", "is", null)
    .order("prioridad", { ascending: true });

  const rows = mods ?? [];
  const now = Date.now();
  const usable = rows.filter((r) => {
    if (r.estado !== "ok") return false;
    if (r.cooldown_hasta && new Date(r.cooldown_hasta).getTime() > now) return false;
    return true;
  });
  if (!usable.length) return [];

  const keyIds = [...new Set(usable.map((r) => r.key_id).filter(Boolean))];
  const { data: keys } = await sb
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
    };
  });
}

function resolveKey(row: ChainRow): string {
  if (row.key_source === "env") return Deno.env.get(row.secret_ref ?? "") ?? "";
  return row.api_key ?? "";
}

async function markDown(id: number, msg: string) {
  const until = new Date(Date.now() + COOLDOWN_MS).toISOString();
  try {
    await sb.from("wa_agente_modelos").update({
      estado: "caido",
      cooldown_hasta: until,
      ultimo_error: msg.slice(0, 500),
    }).eq("id", id);
  } catch (e) { console.error("markDown", e); }
}

// ── Providers ────────────────────────────────────────────────────────────
interface ParseInput { data_b64: string; mime_type: string }
interface ParseOutput {
  parsed: Record<string, unknown>;
  provider: string;
  model_id: string;
  model_row_id: number;
  input_tokens: number;
  output_tokens: number;
  raw_text: string;
}

async function callAnthropicVision(
  row: ChainRow, key: string, input: ParseInput, timeoutMs: number,
): Promise<ParseOutput> {
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
        model: row.model_id,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            input.mime_type === "application/pdf"
              ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.data_b64 } }
              : { type: "image",    source: { type: "base64", media_type: input.mime_type, data: input.data_b64 } },
            { type: "text", text: USER_PROMPT },
          ],
        }],
      }),
    },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const d = await r.json();
  const raw = d.content?.[0]?.text ?? "";
  const parsed = extractFirstJson(raw);
  return {
    parsed,
    provider: "anthropic",
    model_id: row.model_id,
    model_row_id: row.id,
    input_tokens: d.usage?.input_tokens ?? 0,
    output_tokens: d.usage?.output_tokens ?? 0,
    raw_text: raw,
  };
}

async function callGeminiVision(
  row: ChainRow, key: string, input: ParseInput, timeoutMs: number,
): Promise<ParseOutput> {
  const body = {
    systemInstruction: { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: input.mime_type, data: input.data_b64 } },
        { text: USER_PROMPT },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };
  const r = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(row.model_id)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`Google ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const d = await r.json();
  // deno-lint-ignore no-explicit-any
  const parts: any[] = d.candidates?.[0]?.content?.parts ?? [];
  const raw = parts.map((p) => p?.text ?? "").join("");
  const parsed = extractFirstJson(raw);
  return {
    parsed,
    provider: "google",
    model_id: row.model_id,
    model_row_id: row.id,
    input_tokens: d.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: d.usageMetadata?.candidatesTokenCount ?? 0,
    raw_text: raw,
  };
}

async function callByProvider(row: ChainRow, input: ParseInput, timeoutMs: number): Promise<ParseOutput> {
  const key = resolveKey(row);
  if (!key) throw new Error("Sin key resoluble");
  if (row.proveedor === "anthropic") return callAnthropicVision(row, key, input, timeoutMs);
  if (row.proveedor === "google")    return callGeminiVision(row, key, input, timeoutMs);
  throw new Error(`Proveedor no soportado: ${row.proveedor}`);
}

async function parseWithFailover(input: ParseInput): Promise<ParseOutput> {
  const chain = await loadChain();
  if (!chain.length) throw new Error("Cadena parse_comprobante vacía o toda en cooldown");

  const errors: string[] = [];
  for (const row of chain) {
    try {
      return await callByProvider(row, input, DEFAULT_TIMEOUT_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[parser] ${row.proveedor}/${row.model_id}: ${msg}`);
      errors.push(`${row.proveedor}/${row.model_id}: ${msg}`);
      await markDown(row.id, msg);
    }
  }
  throw new Error(`Todos los modelos fallaron: ${errors.join(" | ")}`);
}

// ── Storage helpers ──────────────────────────────────────────────────────
async function downloadFromBucket(bucket: string, path: string): Promise<{ b64: string; mime: string; bytes: number }> {
  const { data, error } = await sb.storage.from(bucket).download(path);
  if (error) throw new Error(`Storage download: ${error.message}`);
  const buf = new Uint8Array(await data.arrayBuffer());
  if (buf.length > MAX_IMG_BYTES) {
    // No re-encodeamos acá; el modelo puede fallar por tamaño y caemos al fallback.
    console.warn(`[parser] archivo ${path} pesa ${buf.length}B (>${MAX_IMG_BYTES})`);
  }
  return {
    b64: encodeBase64(buf),
    mime: data.type || "application/octet-stream",
    bytes: buf.length,
  };
}

function encodeBase64(buf: Uint8Array): string {
  // Chunked para no explotar la stack con archivos grandes.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── Handlers ─────────────────────────────────────────────────────────────
async function handleParse(body: Record<string, unknown>) {
  const comprobanteId = String(body.comprobante_id ?? "");
  if (!comprobanteId) return json({ ok: false, error: "comprobante_id requerido" }, 400);

  const { data: row, error } = await sb.from("wa_comprobantes")
    .select("id, storage_bucket, storage_path, mime_type, status")
    .eq("id", comprobanteId).maybeSingle();
  if (error || !row) return json({ ok: false, error: "comprobante no encontrado" }, 404);

  let dl;
  try {
    dl = await downloadFromBucket(row.storage_bucket, row.storage_path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("wa_comprobantes").update({
      status: "error", ultimo_error: msg,
    }).eq("id", comprobanteId);
    return json({ ok: false, error: msg }, 500);
  }

  let result: ParseOutput;
  try {
    result = await parseWithFailover({ data_b64: dl.b64, mime_type: dl.mime });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("wa_comprobantes").update({
      status: "error", ultimo_error: msg, parsed_at: new Date().toISOString(),
    }).eq("id", comprobanteId);
    return json({ ok: false, error: msg }, 502);
  }

  const p = result.parsed;
  const esComp = !!p.es_comprobante;
  const conf = typeof p.confianza === "number" ? p.confianza : null;
  const monto = typeof p.monto_total === "number" ? p.monto_total : null;

  await sb.from("wa_comprobantes").update({
    parsed_at: new Date().toISOString(),
    parse_provider: `${result.provider}:${result.model_id}`,
    parse_model_id: result.model_row_id,
    parse_confidence: conf,
    parse_raw: p,
    es_comprobante: esComp,
    tipo: typeof p.tipo === "string" ? p.tipo : null,
    monto_total: monto,
    moneda: typeof p.moneda === "string" ? p.moneda : "ARS",
    fecha_operacion: typeof p.fecha_operacion === "string" ? p.fecha_operacion : null,
    status: esComp ? "parsed" : "no_comprobante",
    ultimo_error: null,
  }).eq("id", comprobanteId);

  return json({
    ok: true,
    comprobante_id: comprobanteId,
    provider: result.provider,
    model_id: result.model_id,
    is_free_tier: (await loadChain()).find((c) => c.id === result.model_row_id)?.is_free_tier ?? false,
    tokens: { in: result.input_tokens, out: result.output_tokens },
    extracted: p,
  });
}

async function handleParseInline(body: Record<string, unknown>) {
  const dataB64 = String(body.data_b64 ?? "");
  const mime = String(body.mime_type ?? "");
  if (!dataB64 || !mime) return json({ ok: false, error: "data_b64 y mime_type requeridos" }, 400);

  try {
    const result = await parseWithFailover({ data_b64: dataB64, mime_type: mime });
    return json({
      ok: true,
      provider: result.provider,
      model_id: result.model_id,
      tokens: { in: result.input_tokens, out: result.output_tokens },
      extracted: result.parsed,
      raw_text_preview: result.raw_text.slice(0, 500),
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

async function handleChainStatus() {
  const { data } = await sb
    .from("wa_agente_modelos")
    .select("id, proveedor, model_id, prioridad, activo, estado, cooldown_hasta, ultimo_error, is_free_tier, key_id")
    .eq("tarea", "parse_comprobante")
    .order("prioridad", { ascending: true });
  return json({ ok: true, chain: data ?? [] });
}

// ── Server ───────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    if (action === "parse")         return await handleParse(body);
    if (action === "parse_inline")  return await handleParseInline(body);
    if (action === "chain_status")  return await handleChainStatus();
    return json({ error: "action desconocida", valid: ["parse", "parse_inline", "chain_status"] }, 400);
  } catch (e) {
    console.error("lk_parse-comprobante error:", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
