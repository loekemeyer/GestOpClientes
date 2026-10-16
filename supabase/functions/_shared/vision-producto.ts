// _shared/vision-producto.ts — Visión sobre fotos de productos (Pablo, 14/10/2026).
//
// Fase A: cuando un cliente manda una foto que el clasificador de texto no marcó como reclamo ni pago, se le
// pasa a un modelo con visión para saber QUÉ es (describirFotoProducto): dañado va a reclamo; un COMPROBANTE
// DE PAGO sin texto (captura de transferencia, depósito, eCheq) va al flujo de pago; un producto se describe
// en 2-5 palabras para buscarlo; una lista escrita sigue el flujo de pedido. El comprobante-por-visión (Pablo,
// 16/10) cubre el hueco de la imagen SIN caption: RE_ADJ_PAGO necesita texto, acá no.
//
// Fase B: etiquetado de atributos visuales del catálogo (extraerAtributosProducto): una vez por
// producto, se le pide al modelo color/material/forma para poder buscar "el pelapapas de mango rojo".
//
// El modelo lo fija app_settings.wa_vision_modelo (propio, NO el llm_modelo_pruebas que flipean los
// testers: el webhook nunca lee esa llave). Sin wa_vision_modelo seteado la visión queda DORMIDA.
// Sólo proveedor Google por ahora (Gemini free = US$0). Falla silenciosa: ante cualquier problema
// devuelve sin_vision / null y el que llama sigue con el flujo de siempre.

import { partesGoogle, resolveModelById, type ResolvedModel } from "./bot-llm.ts";
import { getSetting, supabase } from "./supabase.ts";
import { extrasAnthropic, sinMuestreo, textoAnthropic } from "./anthropic-extras.ts";

export type VisionResultado =
  | { tipo: "danado"; raw?: string }
  | { tipo: "comprobante"; raw?: string }
  | { tipo: "lista"; raw?: string }
  | { tipo: "busqueda"; terminos: string; raw?: string }
  | { tipo: "sin_vision"; raw?: string }; // `raw`: texto crudo del modelo (o el motivo del sin_vision) — para diagnosticar desde la alerta, sin logs.

const PROMPT_FASE_A =
  "Sos asistente de un mayorista de bazar y cocina. Un cliente mandó esta foto por WhatsApp.\n" +
  "- Si es un COMPROBANTE DE PAGO (transferencia bancaria, depósito, recibo de pago, captura de homebanking o de " +
  "una billetera virtual como Mercado Pago, cheque o eCheq), respondé exactamente: COMPROBANTE. Esto tiene prioridad: " +
  "aunque tenga muchos renglones o números, si es un pago respondé COMPROBANTE y nada más.\n" +
  "- Si es una LISTA o NOTA escrita con varios productos (un pedido), respondé exactamente: LISTA\n" +
  "- Si es UN producto y está roto, partido, abollado o dañado, respondé exactamente: DANIADO\n" +
  "- Si es UN producto en buen estado, describí QUÉ es en 2 a 5 palabras, pensado para buscarlo en un " +
  "catálogo (ej: pelador de papas, cuchillo de cocina, olla de aluminio, tabla de madera).\n" +
  "Respondé sólo eso, sin saludar ni explicar.";

const PROMPT_ATRIBUTOS =
  "Sos asistente de un mayorista de bazar y cocina. Mirá la foto de UN producto del catálogo. Devolvé " +
  "SOLO un JSON (sin texto antes ni después, sin ```), en español y en minúsculas, con sus rasgos VISUALES:\n" +
  '{"colores":["..."],"material":"...","forma":"...","otros":["..."]}\n' +
  "- colores: 1 a 3 colores que se vean (ej: rojo, negro, transparente). Si es metal sin pintar, \"metalico\".\n" +
  "- material: material principal si se nota (plastico, madera, acero, aluminio, vidrio, silicona), si no \"\".\n" +
  "- forma: forma o tamaño distintivo (alargado, redondo, chico, grande), si no \"\".\n" +
  "- otros: hasta 3 rasgos visuales más que lo distingan (ej: mango ergonomico, con tapa, antiadherente).\n" +
  "No inventes: si algo no se ve, dejalo vacío.";

export interface AtributosProducto {
  /** Blob buscable en minúsculas: "rojo negro plastico alargado mango ergonomico". */
  texto: string;
  /** JSON estructurado tal como lo devolvió el modelo (colores/material/forma/otros). */
  datos: Record<string, unknown>;
}

/** Base64 de un Uint8Array sin dependencias (btoa por chunks, para no reventar el stack con fotos grandes). */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** mime aceptado (JPEG/PNG/WebP) y tamaño ≤5MB. Devuelve el mime normalizado o null. */
function fotoValida(bytes: Uint8Array, mime: string): string | null {
  const m0 = (mime || "").toLowerCase().split(";")[0].trim();
  if (!/^image\/(jpe?g|png|webp)$/.test(m0)) return null;
  if (!bytes?.length || bytes.length > 5 * 1024 * 1024) return null;
  return m0;
}

/** Modelo de visión configurado (wa_vision_modelo). null = dormida o no-Google. */
async function modeloVision(): Promise<ResolvedModel | null> {
  const modeloId = ((await getSetting("wa_vision_modelo")) || "").split(",")[0].trim();
  if (!modeloId) return null; // visión dormida hasta que se setee wa_vision_modelo
  const m = await resolveModelById(modeloId);
  return m && m.provider === "google" ? m : null; // por ahora sólo Gemini
}

/** Una llamada de visión a Gemini. Devuelve el texto o null ante cualquier problema (nunca tira). */
async function pedirVision(modelo: ResolvedModel, mime: string, bytes: Uint8Array, prompt: string, maxTokens: number): Promise<string | null> {
  try {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: toBase64(bytes) } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo.model)}:generateContent?key=${encodeURIComponent(modelo.key)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    if (!res.ok) {
      console.warn("[vision-producto] HTTP", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const d = await res.json();
    // deno-lint-ignore no-explicit-any
    const { text } = partesGoogle((d as any).candidates?.[0]?.content?.parts ?? []);
    return String(text ?? "").trim() || null;
  } catch (e) {
    console.warn("[vision-producto] pedirVision", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Clasifica el texto de Fase A en el resultado. Puro. */
function clasificarFaseA(t: string | null): VisionResultado {
  if (!t) return { tipo: "sin_vision", raw: "vacio_o_error" };
  const w0 = t.split(/\s+/)[0] ?? "";
  if (/comprobante/i.test(t)) return { tipo: "comprobante", raw: t };
  if (/^lista/i.test(w0)) return { tipo: "lista", raw: t };
  if (/dani?ado|dañado/i.test(w0)) return { tipo: "danado", raw: t };
  // Limpia a términos de búsqueda simples (sin signos raros), tope 80 chars.
  const terminos = t.replace(/["'`*_#]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return terminos ? { tipo: "busqueda", terminos, raw: t } : { tipo: "sin_vision", raw: t };
}

const MODELO_FASE_A = "claude-haiku-5-5"; // Pablo, 16/10: "saca gemini de toda ecuacion". Fase A describe con Haiku (rápido y confiable; Gemini free tardaba 9-11 s y devolvía vacío).
const TARIFA_HAIKU = { input: 0.10, output: 0.50 }; // US$ por millón

/** Una llamada de visión a Anthropic (Haiku) con el prompt de Fase A. Loguea el gasto. Devuelve el texto o null. Nunca tira. */
async function pedirVisionAnthropic(apiKey: string, mime: string, bytes: Uint8Array, phone: string | null): Promise<string | null> {
  try {
    const body = {
      model: MODELO_FASE_A, system: PROMPT_FASE_A,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime, data: toBase64(bytes) } },
        { type: "text", text: "¿Qué es esta foto?" }] }],
      ...(sinMuestreo(MODELO_FASE_A) ? {} : { temperature: 0 }), ...extrasAnthropic(MODELO_FASE_A), max_tokens: 64,
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) { console.warn("[vision-producto] Anthropic", res.status, (await res.text()).slice(0, 200)); return null; }
    const d = await res.json();
    const it = Number(d?.usage?.input_tokens ?? 0), ot = Number(d?.usage?.output_tokens ?? 0);
    supabase.from("bot_token_usage").insert({
      model: MODELO_FASE_A, input_tokens: it, output_tokens: ot, function_name: "lk_whatsapp-webhook", phone, motivo: "vision_describe",
      estimated_cost_usd: (it * TARIFA_HAIKU.input + ot * TARIFA_HAIKU.output) / 1_000_000,
    }).then(() => {}, (e: unknown) => console.error("[vision-producto] log de uso:", e));
    return textoAnthropic(d?.content).trim() || null;
  } catch (e) {
    console.warn("[vision-producto] pedirVisionAnthropic", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Fase A: mira la foto del cliente con Haiku (Gemini quedó fuera, Pablo 16/10). Sólo JPEG/PNG/WebP. Nunca tira: ante cualquier problema devuelve sin_vision. */
export async function describirFotoProducto(bytes: Uint8Array, mime: string, apiKey: string, phone: string | null = null): Promise<VisionResultado> {
  const m0 = fotoValida(bytes, mime);
  if (!m0) return { tipo: "sin_vision", raw: "foto_invalida" };
  if (!apiKey) return { tipo: "sin_vision", raw: "sin_api_key" };
  return clasificarFaseA(await pedirVisionAnthropic(apiKey, m0, bytes, phone));
}

/** Fase B: extrae los atributos visuales de la foto de UN producto del catálogo. null si no se pudo. */
export async function extraerAtributosProducto(bytes: Uint8Array, mime: string): Promise<AtributosProducto | null> {
  const m0 = fotoValida(bytes, mime);
  if (!m0) return null;
  const modelo = await modeloVision();
  if (!modelo) return null;

  const raw = await pedirVision(modelo, m0, bytes, PROMPT_ATRIBUTOS, 200);
  if (!raw) return null;
  // El modelo puede envolver el JSON en ```json ... ```: tomo del primer { al último }.
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  let datos: Record<string, unknown>;
  try {
    datos = JSON.parse(raw.slice(i, j + 1));
  } catch {
    return null;
  }
  // Aplana colores/material/forma/otros a un blob de palabras únicas en minúsculas para buscar por ILIKE.
  const piezas: string[] = [];
  const empujar = (v: unknown) => {
    if (typeof v === "string") piezas.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") piezas.push(x);
  };
  empujar(datos.colores); empujar(datos.material); empujar(datos.forma); empujar(datos.otros);
  const texto = [...new Set(
    piezas.join(" ").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 2),
  )].join(" ").slice(0, 200);
  return { texto, datos };
}
