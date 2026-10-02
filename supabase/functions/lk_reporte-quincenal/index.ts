import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import { leerVersiones, nombreActivo } from "../_shared/plantillas-version.ts";

// lk_reporte-quincenal — manda por WhatsApp el PDF de Pedidos Importación de Gestión Virgilio
// ("Reporte quincenal a pedir", Luis 02/10/2026: D6 a Thomy y Damián, D7 cada quincena).
//
// El PDF NO se arma acá: lo arma la pantalla de Gestión (importacion.js), corrida sin pantalla por el
// workflow `reporte-quincenal-importacion.yml` del repo loekemeyer/Gestion-Virgilio (días 1 y 16).
// Armarlo de nuevo en Deno sería una segunda copia de la misma lógica.
//
// Quién la puede llamar (verify_jwt=false, la autenticación es propia):
//   · ese workflow, con el token OIDC de GitHub Actions en x-gh-oidc (repo + main + archivo del workflow, sin secretos)
//   · una llamada interna con x-lk-secret = LK_FN_CRON_SECRET (como lk_templates)
//
// Acciones:
//   subir     → { fecha }                       devuelve una URL firmada para subir el PDF a Storage
//   enviar    → { fecha, params[5], forzar? }   manda la plantilla con el PDF a los destinatarios
//   plantilla → { aplicar? } (SÓLO interna)     crea la plantilla en Meta (simulacro por defecto)
//
// Destinatarios: los de la lista blanca (wa_envio_contactos) cuyo `label` arranca con alguno de
// app_settings.reporte_quincenal_destinos (default "Thomy,Damián"). Todo envío pasa por wa-guard
// (llave wa_envio_automatico): con la llave en 'prueba' sólo salen a la lista blanca.
// Una quincena no se manda dos veces: queda un `enviado.json` al lado del PDF (salvo `forzar`).

const META_API = "https://graph.facebook.com/v21.0";
const PLANTILLA = "reporte_quincenal_a_pedir";
const BUCKET = "gv-reportes";
const REPO_GH = "loekemeyer/gestion-virgilio";
const WORKFLOW_GH = ".github/workflows/reporte-quincenal-importacion.yml";
const AUDIENCIA = "lk-reporte-quincenal";

// Texto de la plantilla (es la fuente: la acción `plantilla` lo sube a Meta).
export const PLANTILLA_BODY =
  "Reporte quincenal a pedir — {{1}}.\n\nA pedir: u$s {{2}} FOB en {{3}} proveedores.\nEn curso: u$s {{4}}.\nMás urgentes: {{5}}.\n\nEl detalle va en el PDF adjunto.";
const PLANTILLA_EJEMPLOS = ["02/10", "85.154", "6", "200.228", "Zhixin y Kangli (prioridad 2)"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lk-secret, x-gh-oidc",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
async function getSetting(key: string): Promise<string | null> {
  const { data } = await sb.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function metaToken(): Promise<string> {
  return Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? Deno.env.get("WA_TOKEN") ?? (await getSetting("wa_token")) ?? "";
}
async function metaPhoneId(): Promise<string> {
  return Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? (await getSetting("wa_phone_number_id")) ?? "";
}
async function metaWaba(token: string): Promise<string> {
  const env = Deno.env.get("WA_BUSINESS_ACCOUNT_ID") ?? Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID") ?? "";
  if (env) return env;
  const phone = await metaPhoneId();
  if (phone && token) {
    try {
      const d = await (await fetch(`${META_API}/${phone}?fields=whatsapp_business_account`, { headers: { Authorization: `Bearer ${token}` } })).json();
      if (d?.whatsapp_business_account?.id) return d.whatsapp_business_account.id;
    } catch { /* cae al setting */ }
  }
  return (await getSetting("wa_business_account_id")) ?? "";
}

// ── Autenticación ──
async function esInterna(req: Request): Promise<boolean> {
  const recibido = req.headers.get("x-lk-secret") ?? "";
  if (!recibido) return false;
  let esperado = Deno.env.get("LK_FN_CRON_SECRET") ?? "";
  if (!esperado) {
    const { data } = await sb.rpc("krikos_secret", { p_name: "LK_FN_CRON_SECRET" });
    esperado = typeof data === "string" ? data : "";
  }
  return esperado.length > 0 && recibido === esperado;
}
const JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
// El token OIDC lo emite GitHub sólo para un run de ese repo; se exige además main y el archivo del
// workflow, así un workflow de otra rama o de un fork no puede mandar nada.
async function esWorkflowGestion(req: Request): Promise<string | null> {
  // Va en un header propio y no en Authorization: el gateway de Supabase no tiene que tocar un JWT ajeno.
  const tok = (req.headers.get("x-gh-oidc") ?? "").trim();
  if (!tok || tok.split(".").length !== 3) return null;
  try {
    const { payload } = await jwtVerify(tok, JWKS, { issuer: "https://token.actions.githubusercontent.com", audience: AUDIENCIA });
    const repo = String(payload.repository ?? "").toLowerCase();
    const ref = String(payload.ref ?? "");
    const wf = String(payload.workflow_ref ?? "").toLowerCase();
    if (repo !== REPO_GH || ref !== "refs/heads/main") return null;
    if (!wf.startsWith(`${REPO_GH}/${WORKFLOW_GH}@`)) return null;
    return `gh:${payload.run_id ?? "?"}`;
  } catch (e) {
    console.warn("[lk_reporte-quincenal] OIDC rechazado:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ── Storage ──
async function asegurarBucket() {
  const { data } = await sb.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await sb.storage.createBucket(BUCKET, {
    public: false, fileSizeLimit: 52428800, allowedMimeTypes: ["application/pdf", "application/json"],
  });
  if (error && !/already exists/i.test(error.message)) throw new Error(`bucket ${BUCKET}: ${error.message}`);
}
const fechaOk = (f: unknown) => typeof f === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f);
const rutaPdf = (fecha: string) => `importacion/${fecha}/Reporte-quincenal-a-pedir-${fecha}.pdf`;
const rutaMarca = (fecha: string) => `importacion/${fecha}/enviado.json`;

async function accionSubir(body: Record<string, unknown>) {
  if (!fechaOk(body.fecha)) return json({ ok: false, error: "fecha (AAAA-MM-DD) obligatoria" }, 400);
  await asegurarBucket();
  const path = rutaPdf(String(body.fecha));
  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error || !data) return json({ ok: false, error: error?.message ?? "sin URL de subida" }, 500);
  return json({ ok: true, path, signedUrl: data.signedUrl, token: data.token });
}

// ── Destinatarios ──
async function destinatarios(): Promise<{ label: string; phone: string }[]> {
  const pref = ((await getSetting("reporte_quincenal_destinos")) ?? "Thomy,Damián")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const { data, error } = await sb.from("wa_envio_contactos").select("label, phone");
  if (error) throw new Error(`wa_envio_contactos: ${error.message}`);
  // deno-lint-ignore no-explicit-any
  return (data ?? []).filter((c: any) => pref.some((p) => String(c.label ?? "").toLowerCase().startsWith(p)))
    // deno-lint-ignore no-explicit-any
    .map((c: any) => ({ label: String(c.label), phone: String(c.phone).replace(/\D/g, "") }));
}

async function estadoPlantilla(token: string, nombre: string): Promise<string | null> {
  const waba = await metaWaba(token);
  if (!waba) return null;
  const d = await (await fetch(`${META_API}/${waba}/message_templates?name=${encodeURIComponent(nombre)}&fields=name,status`,
    { headers: { Authorization: `Bearer ${token}` } })).json();
  // deno-lint-ignore no-explicit-any
  const t = (d?.data ?? []).find((x: any) => x.name === nombre);
  return t?.status ?? null;
}

async function accionEnviar(body: Record<string, unknown>, quien: string) {
  if (!fechaOk(body.fecha)) return json({ ok: false, error: "fecha (AAAA-MM-DD) obligatoria" }, 400);
  const fecha = String(body.fecha);
  const params = Array.isArray(body.params) ? (body.params as unknown[]).map((x) => String(x ?? "").trim()) : [];
  if (params.length !== 5 || params.some((p) => !p)) return json({ ok: false, error: "params: hacen falta las 5 variables" }, 400);
  const forzar = body.forzar === true;

  // ¿ya salió esta quincena?
  const marca = await sb.storage.from(BUCKET).download(rutaMarca(fecha));
  if (marca.data && !forzar) {
    return json({ ok: true, ya_enviado: true, detalle: JSON.parse(await marca.data.text()) });
  }
  const path = rutaPdf(fecha);
  const { data: firmado, error: eFirma } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (eFirma || !firmado?.signedUrl) return json({ ok: false, error: `no está el PDF ${path}: ${eFirma?.message ?? ""}` }, 409);

  const token = await metaToken(), phoneId = await metaPhoneId();
  if (!token || !phoneId) return json({ ok: false, error: "faltan WHATSAPP_ACCESS_TOKEN / phone id" }, 500);
  const nombre = nombreActivo(await leerVersiones(sb), PLANTILLA);
  const estado = await estadoPlantilla(token, nombre);
  if (estado !== "APPROVED") return json({ ok: false, error: `la plantilla ${nombre} está ${estado ?? "NO_EXISTE"} en Meta: no se manda` }, 409);

  const dest = await destinatarios();
  if (!dest.length) return json({ ok: false, error: "no hay destinatarios en la lista blanca" }, 409);
  const filename = `Reporte quincenal a pedir ${fecha.slice(8, 10)}-${fecha.slice(5, 7)}.pdf`;
  const resultados = [];
  for (const d of dest) {
    const payload = {
      messaging_product: "whatsapp", to: d.phone, type: "template",
      template: {
        name: nombre, language: { code: "es_AR" },
        components: [
          { type: "header", parameters: [{ type: "document", document: { link: firmado.signedUrl, filename } }] },
          { type: "body", parameters: params.map((t) => ({ type: "text", text: t })) },
        ],
      },
    };
    try {
      const r = await fetch(`${META_API}/${phoneId}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const out = await r.json();
      resultados.push(r.ok
        ? { label: d.label, ok: true, wamid: out?.messages?.[0]?.id ?? null }
        : { label: d.label, ok: false, error: out?.error?.message ?? `HTTP ${r.status}` });
    } catch (e) {
      resultados.push({ label: d.label, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const algunOk = resultados.some((x) => x.ok);
  if (algunOk) {
    const detalle = { fecha, plantilla: nombre, params, quien, enviado_at: new Date().toISOString(), resultados };
    await sb.storage.from(BUCKET).upload(rutaMarca(fecha), new Blob([JSON.stringify(detalle)], { type: "application/json" }),
      { upsert: true, contentType: "application/json" });
  }
  console.log(`[lk_reporte-quincenal] ${fecha} por ${quien}:`, JSON.stringify(resultados));
  return json({ ok: algunOk, resultados }, algunOk ? 200 : 502);
}

// ── Plantilla en Meta (sólo llamada interna; simulacro salvo aplicar:true) ──
async function subirPdfMuestra(token: string): Promise<string> {
  let appId = (await (await fetch(`${META_API}/app?access_token=${encodeURIComponent(token)}`)).json())?.id ?? "";
  if (!appId) {
    const d = await (await fetch(`${META_API}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`)).json();
    appId = d?.data?.app_id ?? "";
  }
  if (!appId) throw new Error("no se pudo saber la app del token");
  const doc = await PDFDocument.create();
  const pag = doc.addPage([420, 300]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  pag.drawText("Loekemeyer - Reporte quincenal a pedir", { x: 30, y: 240, size: 16, font: f });
  pag.drawText("Documento de muestra para la plantilla de WhatsApp.", { x: 30, y: 200, size: 11, font: f });
  const bytes = await doc.save();
  const ses = await (await fetch(`${META_API}/${appId}/uploads?file_name=reporte_ejemplo.pdf&file_length=${bytes.length}&file_type=application/pdf&access_token=${encodeURIComponent(token)}`, { method: "POST" })).json();
  if (!ses?.id) throw new Error(`Meta uploads: ${ses?.error?.message ?? JSON.stringify(ses).slice(0, 200)}`);
  const up = await (await fetch(`${META_API}/${ses.id}`, { method: "POST", headers: { Authorization: `OAuth ${token}`, file_offset: "0" }, body: bytes })).json();
  if (!up?.h) throw new Error(`Meta upload: ${up?.error?.message ?? JSON.stringify(up).slice(0, 200)}`);
  return up.h;
}
async function accionPlantilla(body: Record<string, unknown>) {
  const token = await metaToken();
  if (!token) return json({ ok: false, error: "sin token" }, 500);
  const waba = await metaWaba(token);
  if (!waba) return json({ ok: false, error: "sin WABA" }, 500);
  const estado = await estadoPlantilla(token, PLANTILLA);
  if (estado) return json({ ok: true, accion: "ya_existe", estado });
  if (body.aplicar !== true) return json({ ok: true, accion: "crear (simulacro)", body: PLANTILLA_BODY, ejemplos: PLANTILLA_EJEMPLOS });
  const handle = await subirPdfMuestra(token);
  const r = await fetch(`${META_API}/${waba}/message_templates`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: PLANTILLA, language: "es_AR", category: "UTILITY",
      components: [
        { type: "HEADER", format: "DOCUMENT", example: { header_handle: [handle] } },
        { type: "BODY", text: PLANTILLA_BODY, example: { body_text: [PLANTILLA_EJEMPLOS] } },
      ],
    }),
  });
  const out = await r.json();
  if (out.error) return json({ ok: false, error: `Meta (#${out.error.code ?? "?"}): ${out.error.error_user_msg ?? out.error.message ?? ""}` }, 502);
  console.log("[lk_reporte-quincenal] plantilla creada:", JSON.stringify(out));
  return json({ ok: true, accion: "creada", id: out.id ?? null, estado: out.status ?? "PENDING" });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const interna = await esInterna(req);
    const gh = interna ? null : await esWorkflowGestion(req);
    if (!interna && !gh) return json({ ok: false, error: "no autorizado" }, 401);
    const quien = interna ? "interno:LK_FN_CRON_SECRET" : String(gh);
    if (body.action === "subir") return await accionSubir(body);
    if (body.action === "enviar") return await accionEnviar(body, quien);
    if (body.action === "plantilla") {
      if (!interna) return json({ ok: false, error: "la plantilla sólo se crea con llamada interna" }, 403);
      return await accionPlantilla(body);
    }
    return json({ ok: false, error: "action desconocida" }, 400);
  } catch (e) {
    console.error("lk_reporte-quincenal error:", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
