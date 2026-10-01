// Transcripción de audios de WhatsApp con Whisper de Groq (Pablo Olejavetzky, 01/10/2026: "armalo con Groq Whisper").
//
// El audio se baja de Meta, se transcribe y el TEXTO entra al flujo normal del bot (handleMessage), igual que si el cliente lo
// hubiera escrito: FAQ, agente, "ya pagué", pedidos. Claude no recibe audio (la API sólo acepta texto, imagen y PDF), por eso
// hace falta otro servicio.
//
// ⚠ Apagado de fábrica: `app_settings.wa_audio_activo` = 1 lo prende (sin fila = 0). Con la llave apagada el bot contesta lo
// de siempre ("no podemos escuchar audios"). Antes de prenderlo con audios REALES de clientes: activar Zero Data Retention en
// el panel de Groq (la doc de Groq dice que por defecto no retiene datos de inferencia, pero no aclara si los usa para
// entrenar; con ZDR no retiene nada).
//
// Proveedor: la clave sale de `wa_agente_model_keys` (proveedor 'groq'), la misma que usa la cadena de modelos. Plan gratis de
// Groq para Whisper (doc 01/10): 20 pedidos/min, 2.000/día, 7.200 s de audio/hora, 28.800 s/día, archivo de hasta 25 MB. Si se
// pasa del límite o falla, el que llama cae al mensaje de "escribilo" y avisa a una persona: nadie queda sin respuesta.
//
// Cuesta US$ 0 en el plan gratis, por eso el registro en bot_token_usage va con costo 0 (sólo cuenta cuántos audios hubo). Si se
// pasa a plan pago: whisper-large-v3 US$ 0,111/hora de audio, whisper-large-v3-turbo US$ 0,04/hora.
import { getSetting, supabase } from "./supabase.ts";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/** Mismo límite diario en el plan gratis que turbo; se puede cambiar con app_settings.wa_audio_modelo. */
const MODELO_DEF = "whisper-large-v3";
/** Una nota de voz de WhatsApp (ogg/opus) pesa ~6-8 KB por segundo: 3 MB son unos 7 minutos. Más que eso, que lo escriba. */
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
/** Sesga el vocabulario de Whisper hacia nombres propios del negocio (mejora "Loekemeyer", "Chef", "CBU"). */
const PISTA = "Mensaje de WhatsApp de un cliente de Loekemeyer y Chef, mayoristas de artículos de cocina y bazar. Pedidos, facturas, pagos, transferencias, entregas.";

export type ResultadoAudio = { ok: true; texto: string } | { ok: false; motivo: string };

export async function audioActivo(): Promise<boolean> {
  return Number((await getSetting("wa_audio_activo")) ?? "0") === 1;
}

/** Extensión que Groq acepta para ese mime (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm). null = formato que no lee (ej. amr). */
export function extensionAudio(mime: string): string | null {
  const m = String(mime ?? "").toLowerCase().split(";")[0].trim();
  if (m === "audio/ogg" || m === "audio/opus" || m === "application/ogg") return "ogg";
  if (m === "audio/mpeg" || m === "audio/mp3") return "mp3";
  if (m === "audio/mp4" || m === "audio/x-m4a" || m === "audio/m4a" || m === "audio/aac") return "m4a";
  if (m === "audio/wav" || m === "audio/x-wav" || m === "audio/wave") return "wav";
  if (m === "audio/webm") return "webm";
  if (m === "audio/flac" || m === "audio/x-flac") return "flac";
  return null;
}

// Whisper "inventa" texto cuando el audio es silencio o ruido: frases de subtítulos que no dijo nadie.
const RE_ALUCINACION = /(amara\.org|subt[ií]tulos?\s+(por|realizados|de)|suscr[ií]b|gracias\s+por\s+(ver|mirar)|^\W*gracias\W*$)/i;

/** Texto prolijo de la respuesta de Whisper; "" si no hay nada que entender (vacío o alucinación de silencio). */
export function limpiarTranscripcion(t: unknown): string {
  const s = String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (!s || (s.length < 90 && RE_ALUCINACION.test(s))) return "";
  return s;
}

/** Llamada a Groq con la clave ya resuelta. Sin base de datos: se prueba con un fetch simulado. */
export async function transcribirConClave(
  bytes: Uint8Array, mime: string, clave: string, modelo: string, fetchFn: typeof fetch = fetch,
): Promise<ResultadoAudio> {
  if (!bytes.length) return { ok: false, motivo: "audio_vacio" };
  if (bytes.length > MAX_AUDIO_BYTES) return { ok: false, motivo: "audio_largo" };
  const ext = extensionAudio(mime);
  if (!ext) return { ok: false, motivo: `formato_no_soportado:${mime}` };
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: mime }), `audio.${ext}`);
  form.append("model", modelo);
  form.append("language", "es");
  form.append("temperature", "0");
  form.append("response_format", "json");
  form.append("prompt", PISTA);
  let res: Response;
  try {
    res = await fetchFn(GROQ_URL, { method: "POST", headers: { Authorization: `Bearer ${clave}` }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, motivo: `red:${e instanceof Error ? e.name : "error"}` };
  }
  if (res.status === 429) return { ok: false, motivo: "limite_groq" };
  if (!res.ok) return { ok: false, motivo: `groq_${res.status}` };
  // deno-lint-ignore no-explicit-any
  const j: any = await res.json().catch(() => null);
  const texto = limpiarTranscripcion(j?.text);
  return texto ? { ok: true, texto } : { ok: false, motivo: "sin_texto" };
}

async function claveGroq(): Promise<string> {
  const { data } = await supabase.from("wa_agente_model_keys").select("key_source, secret_ref, api_key")
    .eq("proveedor", "groq").order("id").limit(1).maybeSingle();
  return data?.key_source === "env" ? (Deno.env.get(data?.secret_ref ?? "") ?? "") : (data?.api_key ?? "");
}

/** Transcribe un audio de un cliente. No mira la llave `wa_audio_activo` (la mira el que llama con `audioActivo`). */
export async function transcribirAudio(bytes: Uint8Array, mime: string, phone: string | null): Promise<ResultadoAudio> {
  let clave = "";
  try { clave = await claveGroq(); } catch (e) { console.error("[audio] clave de Groq:", e instanceof Error ? e.message : e); }
  if (!clave) return { ok: false, motivo: "sin_clave_groq" };
  const modelo = ((await getSetting("wa_audio_modelo")) ?? "").trim() || MODELO_DEF;
  const r = await transcribirConClave(bytes, mime, clave, modelo);
  // Sólo cuenta cuántos audios hubo (costo 0 en el plan gratis). Nunca guarda el texto ni el audio.
  supabase.from("bot_token_usage").insert({
    model: `groq/${modelo}`, input_tokens: 0, output_tokens: 0, function_name: "lk_whatsapp-webhook", phone,
    motivo: r.ok ? "audio_transcripcion" : `audio_fallo:${r.motivo}`.slice(0, 60), estimated_cost_usd: 0,
  }).then(() => {}, (e: unknown) => console.error("[audio] log de uso:", e));
  return r;
}
