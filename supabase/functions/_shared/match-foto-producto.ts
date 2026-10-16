// _shared/match-foto-producto.ts — "¿cuál es el artículo EXACTO de la foto?" (Pablo Olejavetzky, 16/10/2026).
//
// La visión de Fase A (vision-producto.ts) describe la foto en 2-5 palabras y el agente busca por ese texto: trae la
// categoría entera y le pide al cliente que elija ("te mandé las 5, ¿cuál es?"). Para dar el CÓDIGO exacto no alcanza
// con describir: hay que COMPARAR la foto del cliente contra las fotos de los candidatos del catálogo. Eso es lo que
// hace este módulo, con un modelo multimodal (Anthropic): recibe la foto del cliente + las fotos de N candidatos y
// devuelve cuál es el mismo producto, con qué confianza, y qué otros códigos podrían ser.
//
// LLEVA PLATA (es visión paga, no Gemini gratis). Por eso está GATEADO por app_settings.wa_match_foto_modelo:
//   · vacío  → apagado, el webhook sigue con el camino de siempre (describir + ofrecer opciones);
//   · "claude-haiku-5-5" (o el modelo que se setee) → corre el match.
// El gasto se loguea en bot_token_usage (motivo "match_foto"), igual que el lector de pedidos.
//
// Techo honesto: si el artículo NO está en catálogo, cod = null (ningún modelo lo inventa). Dos variantes casi iguales
// desde un ángulo malo → confianza media/baja y el otro candidato en `alternativas`: el agente ofrece los dos, no elige
// por el cliente. Falla silenciosa: ante cualquier problema devuelve cod null y el que llama sigue con el camino normal.

import { supabase } from "./supabase.ts";
import { extrasAnthropic, sinMuestreo, textoAnthropic } from "./anthropic-extras.ts";
import { parseMatch } from "./match-foto-producto-puro.ts";

export { parseMatch } from "./match-foto-producto-puro.ts";

/** US$ por millón de tokens, por modelo. Haiku 5.5: 0,10 / 0,50 (CLAUDE.md). Sonnet 4.6: 3 / 15. */
const TARIFAS: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.10, output: 0.50 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-5-5": { input: 3.0, output: 15.0 },
};
/** Cuántos candidatos del catálogo se comparan como mucho (1 foto del cliente + N del catálogo). 12 cubre categorías enteras
 *  (abrelatas 10, peladores 11): con 6 el artículo correcto quedaba afuera del set y el match elegía el menos malo (Pablo, 16/10).
 *  Barato y rápido porque las fotos van por URL (las baja Anthropic) y Haiku compara ~12 imágenes en pocos segundos. */
export const MAX_CANDIDATOS = 12;
const MAX_FOTO_BYTES = 5 * 1024 * 1024;

export interface CandidatoFoto { cod: string; description: string; url: string }
export interface MatchResultado {
  /** El código del catálogo que es el MISMO producto, o null si ninguno lo es (o no se pudo). */
  cod: string | null;
  confianza: "alta" | "media" | "baja";
  /** Otros códigos plausibles (sin el principal), el más probable primero. */
  alternativas: string[];
  /** Texto crudo del modelo, para diagnosticar desde la alerta sin logs. */
  raw: string;
  gasto_usd: number;
}

const VACIO: MatchResultado = { cod: null, confianza: "baja", alternativas: [], raw: "", gasto_usd: 0 };

/** base64 de bytes sin reventar el stack (btoa por chunks). */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** mime de imagen normalizado (jpeg/png/webp/gif) o null. */
function mimeImagen(mime: string): string | null {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  return /^image\/(jpe?g|png|webp|gif)$/.test(m) ? (m === "image/jpg" ? "image/jpeg" : m) : null;
}

const SISTEMA =
  "Sos un comparador visual de un mayorista de bazar y cocina. Te paso la FOTO que mandó un cliente y las fotos de " +
  "varios productos del catálogo, cada una con su CÓDIGO. Tu tarea es decir cuál de los candidatos es el MISMO producto " +
  "que el de la foto del cliente (no sólo parecido: el mismo). No inventes: si ninguno es el mismo producto, cod = null. " +
  "Si dudás entre dos, poné el más probable en cod y el otro en alternativas, con confianza media o baja. " +
  "Respondé SOLO JSON, sin texto antes ni después: " +
  '{"cod":"<código>"|null,"confianza":"alta"|"media"|"baja","alternativas":["<otro código>"]}';

const bloqueImagen = (mime: string, bytes: Uint8Array) =>
  ({ type: "image", source: { type: "base64", media_type: mime, data: toBase64(bytes) } });
// Las fotos del catálogo se pasan por URL: las baja Anthropic, no nuestro server (antes bajábamos hasta 6, ~decenas de segundos
// en el camino crítico). La foto del cliente sí va en base64 (ya tenemos los bytes y no es pública).
const bloqueImagenUrl = (url: string) => ({ type: "image", source: { type: "url", url } });
const esUrlHttp = (u: string) => /^https?:\/\//i.test(u);

const TRANSITORIOS = new Set([429, 500, 502, 503, 504, 529]);

/** Compara la foto del cliente contra los candidatos y dice cuál es el exacto. Nunca tira: devuelve cod null ante cualquier problema. */
export async function matchFotoProducto(
  apiKey: string,
  fotoCliente: { bytes: Uint8Array; mime: string },
  candidatos: CandidatoFoto[],
  modelo = "claude-haiku-5-5",
  phone: string | null = null,
): Promise<MatchResultado> {
  const mimeCli = mimeImagen(fotoCliente.mime);
  if (!apiKey || !mimeCli || !fotoCliente.bytes?.length || fotoCliente.bytes.length > MAX_FOTO_BYTES) return VACIO;
  const lista = candidatos.slice(0, MAX_CANDIDATOS);
  if (!lista.length) return VACIO;

  // Sólo candidatos con URL http(s) válida (Anthropic la baja). Si no queda ninguno, no hay con qué comparar.
  const usables = lista.filter((c) => esUrlHttp(c.url));
  if (!usables.length) return VACIO;

  // deno-lint-ignore no-explicit-any
  const content: any[] = [{ type: "text", text: "FOTO DEL CLIENTE:" }, bloqueImagen(mimeCli, fotoCliente.bytes),
    { type: "text", text: "CANDIDATOS DEL CATÁLOGO:" }];
  for (const c of usables) {
    content.push({ type: "text", text: `Código ${c.cod}: ${c.description}` });
    content.push(bloqueImagenUrl(c.url));
  }
  const codsValidos = new Set(usables.map((c) => String(c.cod)));

  let res: Response;
  try {
    for (let intento = 0; ; intento++) {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: modelo, system: SISTEMA, messages: [{ role: "user", content }],
          ...(sinMuestreo(modelo) ? {} : { temperature: 0 }), ...extrasAnthropic(modelo), max_tokens: 200 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok || intento === 1 || !TRANSITORIOS.has(res.status)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) {
    console.warn("[match-foto] fetch", e instanceof Error ? e.message : e);
    return VACIO;
  }
  if (!res.ok) {
    console.warn("[match-foto] HTTP", res.status, (await res.text()).slice(0, 200));
    return VACIO;
  }
  const r = await res.json();
  const it = Number(r?.usage?.input_tokens ?? 0), ot = Number(r?.usage?.output_tokens ?? 0);
  const tarifa = TARIFAS[modelo] ?? { input: 3.0, output: 15.0 };
  const gasto = (it * tarifa.input + ot * tarifa.output) / 1_000_000;
  supabase.from("bot_token_usage").insert({
    model: modelo, input_tokens: it, output_tokens: ot, function_name: "lk_whatsapp-webhook", phone, motivo: "match_foto",
    estimated_cost_usd: gasto,
  }).then(() => {}, (e: unknown) => console.error("[match-foto] log de uso:", e));

  const raw = textoAnthropic(r?.content).trim();
  return { ...parseMatch(raw, codsValidos), raw: raw.slice(0, 200), gasto_usd: gasto };
}
