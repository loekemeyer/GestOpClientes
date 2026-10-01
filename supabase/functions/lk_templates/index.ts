import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { PLANTILLAS, componentesMeta, validar } from "../_shared/plantillas-meta.ts";
import { leerVersiones, nombreActivo, siguienteNombre, type Versiones } from "../_shared/plantillas-version.ts";
import { PLANTILLAS_FACTURA } from "../_shared/plantillas-factura.ts";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

// Función dedicada a plantillas WhatsApp: listar (Meta) + enviar prueba.
// Sólo depende de _shared/admin-gate.ts (verificación de admin); no toca
// lk_whatsapp-webhook ni lk_chat-test.

const META_API = "https://graph.facebook.com/v21.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Secreto interno (env o Vault vía krikos_secret), igual que notify-tracking-status. Falla cerrada.
const SECRET_NAME = "LK_FN_CRON_SECRET";
async function esLlamadaInterna(req: Request): Promise<boolean> {
  const recibido = req.headers.get("x-lk-secret") ?? "";
  if (!recibido) return false;
  let esperado = Deno.env.get(SECRET_NAME) ?? "";
  if (!esperado) {
    const { data } = await supabase.rpc("krikos_secret", { p_name: SECRET_NAME });
    esperado = typeof data === "string" ? data : "";
  }
  return esperado.length > 0 && recibido === esperado;
}

async function getSetting(key: string): Promise<string | null> {
  const { data } = await supabase
    .from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

/** Normaliza teléfono argentino a formato canónico (sin +, con 54). */
function canonPhone(raw: string): string {
  let cleaned = raw.replace(/[^0-9]/g, "");
  if (cleaned.startsWith("54")) cleaned = cleaned.slice(2);
  if (cleaned.startsWith("9")) cleaned = cleaned.slice(1);
  if (cleaned.startsWith("0")) cleaned = cleaned.slice(1);
  if (cleaned.length > 10 && /^\d{2,4}15/.test(cleaned)) {
    cleaned = cleaned.replace(/^(\d{2,4})15/, "$1");
  }
  return "54" + cleaned;
}

// ── Config Meta (secrets env → fallback app_settings) ──
// Prioridad: mismos secrets que usa el bot de producción (lk_outbox-flush):
// WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID. Así apunta SIEMPRE al número
// vinculado actual (hoy el de N8N), no a credenciales viejas de app_settings.
async function metaToken(): Promise<string> {
  return Deno.env.get("WHATSAPP_ACCESS_TOKEN")
    ?? Deno.env.get("WA_TOKEN")
    ?? Deno.env.get("META_ACCESS_TOKEN")
    ?? Deno.env.get("LK_WA_TOKEN")
    ?? (await getSetting("wa_token")) ?? "";
}
async function metaPhoneNumberId(): Promise<string> {
  return Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")
    ?? Deno.env.get("WA_PHONE_NUMBER_ID")
    ?? Deno.env.get("META_PHONE_NUMBER_ID")
    ?? Deno.env.get("LK_WA_PHONE_ID")
    ?? (await getSetting("wa_phone_number_id")) ?? "";
}
// Sólo secrets explícitos. El fallback a app_settings.wa_business_account_id se
// aplica DESPUÉS de intentar derivar del número vinculado (ese valor puede ser viejo).
function metaWabaIdEnv(): string {
  return Deno.env.get("WA_BUSINESS_ACCOUNT_ID")
    ?? Deno.env.get("META_BUSINESS_ACCOUNT_ID")
    ?? Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID")
    ?? "";
}

// Deriva el WABA id a partir del phone_number_id (cuando no está seteado o quedó viejo).
// GET /{phone_number_id}?fields=whatsapp_business_account
async function wabaFromPhone(phoneNumberId: string, token: string): Promise<string> {
  if (!phoneNumberId || !token) return "";
  try {
    const res = await fetch(
      `${META_API}/${phoneNumberId}?fields=whatsapp_business_account`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    return data?.whatsapp_business_account?.id ?? "";
  } catch {
    return "";
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();

    // ── Gate de admin (OBLIGATORIO para todo) ──
    // Se deploya con --no-verify-jwt: sin este chequeo es un endpoint HTTP
    // anónimo de internet. `template_send` manda WhatsApp desde el número de la
    // empresa a cualquier destinatario (spam/phishing → baneo del WABA).
    // Llamada interna (SQL/cron vía net.http_post con el secreto LK_FN_CRON_SECRET del Vault, el
    // mismo patrón que notify-tracking-status): sólo puede LISTAR y SINCRONIZAR plantillas, nunca
    // mandar mensajes. Todo lo demás exige sesión de admin del dashboard.
    const interno = await esLlamadaInterna(req);
    if (interno && (body.action === "templates_sync" || body.action === "templates_list" || body.action === "templates_defs" || body.action === "templates_promover" || body.action === "factura_sync")) {
      if (body.action === "factura_sync") return await handleFacturaSync(body, "interno:LK_FN_CRON_SECRET");
      if (body.action === "templates_sync") return await handleTemplatesSync(body, "interno:LK_FN_CRON_SECRET");
      if (body.action === "templates_promover") return await handleTemplatesPromover(body, "interno:LK_FN_CRON_SECRET");
      if (body.action === "templates_list") return await handleTemplatesList(body.status);
      return json({ ok: true, plantillas: PLANTILLAS.map((p) => ({ ...p, errores: validar(p) })) });
    }

    const gate = await requireAdmin(body);
    if (!gate.ok) return json({ error: gate.error }, gate.status);

    if (body.action === "templates_list") return await handleTemplatesList(body.status);
    if (body.action === "template_send") return await handleTemplateSend(body);
    if (body.action === "templates_sync") return await handleTemplatesSync(body, gate.email);
    if (body.action === "templates_promover") return await handleTemplatesPromover(body, gate.email);
    if (body.action === "factura_sync") return await handleFacturaSync(body, gate.email);
    // Definiciones del repo (plantillas-meta.ts), sin consultar a Meta: el panel las muestra
    // aunque el token esté caído.
    if (body.action === "templates_preview") return await handleTemplatesPreview(body);
    if (body.action === "templates_defs") {
      return json({ ok: true, plantillas: PLANTILLAS.map((p) => ({ ...p, errores: validar(p) })) });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_templates error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// WABA id — prioridad: secret explícito → DERIVADO del número vinculado (N8N) →
// app_settings (último recurso; ese valor puede haber quedado del WABA viejo).
async function resolveWaba(token: string) {
  const phoneNumberId = await metaPhoneNumberId();
  let wabaId = metaWabaIdEnv();
  let wabaSource = wabaId ? "secret" : "";
  if (!wabaId) {
    wabaId = await wabaFromPhone(phoneNumberId, token);
    if (wabaId) wabaSource = "derivado_del_numero";
  }
  if (!wabaId) {
    wabaId = (await getSetting("wa_business_account_id")) ?? "";
    if (wabaId) wabaSource = "app_settings";
  }
  return { phoneNumberId, wabaId, wabaSource };
}

async function handleTemplatesList(statusFilter?: string) {
  const token = await metaToken();
  if (!token) return json({ ok: false, error: "Falta el token de WhatsApp (WHATSAPP_ACCESS_TOKEN)." }, 200);

  const { phoneNumberId, wabaId, wabaSource } = await resolveWaba(token);
  if (!wabaId) {
    return json({ ok: false, error: "No se pudo determinar el WABA. Falta WHATSAPP_PHONE_NUMBER_ID válido o WA_BUSINESS_ACCOUNT_ID." }, 200);
  }

  const params = new URLSearchParams({ limit: "100" });
  if (statusFilter ?? "APPROVED") params.set("status", statusFilter ?? "APPROVED");

  const res = await fetch(`${META_API}/${wabaId}/message_templates?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) {
    const e = data.error;
    const msg = `Meta (#${e.code ?? "?"}${e.error_subcode ? "/" + e.error_subcode : ""}): ${e.message ?? JSON.stringify(e)}`;
    return json({ ok: false, error: msg, waba_id: wabaId, waba_source: wabaSource, phone_number_id: phoneNumberId || null }, 200);
  }

  // deno-lint-ignore no-explicit-any
  const templates = (data.data ?? []).map((t: any) => ({
    name: t.name,
    status: t.status,
    category: t.category,
    language: t.language,
    // deno-lint-ignore no-explicit-any
    components: (t.components ?? []).map((c: any) => ({
      type: c.type,
      format: c.format,
      text: c.text,
      example: c.example ?? null,
      // deno-lint-ignore no-explicit-any
      buttons: c.buttons?.map((b: any) => ({ type: b.type, text: b.text, url: b.url })) ?? null,
    })),
  }));

  return json({ templates, count: templates.length, waba_id: wabaId, waba_source: wabaSource });
}

async function handleTemplateSend(body: Record<string, unknown>) {
  const { phone, template_name, language, params } = body as {
    phone?: string; template_name?: string; language?: string; params?: unknown[];
  };
  if (!phone || !template_name) return json({ error: "phone y template_name requeridos" }, 400);

  const phoneNumberId = await metaPhoneNumberId();
  const token = await metaToken();
  if (!phoneNumberId) return json({ ok: false, error: "Falta WHATSAPP_PHONE_NUMBER_ID (número vinculado)." }, 200);
  if (!token) return json({ ok: false, error: "Falta el token de WhatsApp (WHATSAPP_ACCESS_TOKEN)." }, 200);

  const to = canonPhone(String(phone));
  const lang = (language as string) || "es_AR";

  const values = Array.isArray(params) ? params : [];
  const components = values.length
    ? [{ type: "body", parameters: values.map((v) => ({ type: "text", text: String(v ?? "") })) }]
    : undefined;

  const template: Record<string, unknown> = { name: template_name, language: { code: lang } };
  if (components) template.components = components;

  const res = await fetch(`${META_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template }),
  });
  const result = await res.json();

  if (result.error) {
    const e = result.error;
    const errMsg = `Meta (#${e.code ?? "?"}${e.error_subcode ? "/" + e.error_subcode : ""}): ${e.message ?? JSON.stringify(e)}`;
    return json({ ok: false, error: errMsg, to, template_name }, 200);
  }

  // Log en wa_conversations (fire and forget)
  supabase.from("wa_conversations").insert([
    { phone: to, direction: "out", body: `[template: ${template_name}]`, msg_type: "template", customer_id: null, intent: "template_test" },
  ]).then(() => {}).catch((e: unknown) => console.error("conv log err:", e));

  return json({ ok: true, to, template_name, language: lang, result });
}

// ── templates_sync: sube a Meta las plantillas de plantillas-meta.ts ──
// Por defecto es un SIMULACRO: compara el archivo con lo que hay en Meta y
// devuelve el plan (crear / editar / igual) sin tocar nada. Sólo con
// `aplicar: true` crea o edita. `solo: ["nombre", …]` limita a esas plantillas.
// Crear/editar plantillas no manda mensajes (no pasa por wa-guard).
// deno-lint-ignore no-explicit-any
function bodyDe(t: any): string {
  // deno-lint-ignore no-explicit-any
  return (t?.components ?? []).find((c: any) => c.type === "BODY")?.text ?? "";
}
// Botones de respuesta rápida de una plantilla de Meta, en orden (para comparar con `botones` del repo).
// deno-lint-ignore no-explicit-any
function botonesDe(t: any): string {
  // deno-lint-ignore no-explicit-any
  const b = (t?.components ?? []).find((c: any) => c.type === "BUTTONS")?.buttons ?? [];
  // deno-lint-ignore no-explicit-any
  return b.map((x: any) => x.text).join("|");
}

async function guardarVersiones(v: Versiones) {
  await supabase.from("app_settings").upsert({ key: "wa_plantillas_version", value: JSON.stringify(v) }, { onConflict: "key" });
}

// Tiempos de aprobación de Meta (Pablo, 30/09: "saber qué es más rápido", crear una nueva o editar la aprobada).
// app_settings.wa_plantillas_tiempos = { nombre: { tipo: "creada"|"editada", pedida_at, aprobada_at?, estado? } }.
// templates_sync anota cuándo se pidió; templates_promover (cron cada 30 min) anota cuándo la vio APPROVED o REJECTED.
type Tiempos = Record<string, { tipo: string; pedida_at: string; aprobada_at?: string; estado?: string }>;
async function leerTiempos(): Promise<Tiempos> {
  const v = await getSetting("wa_plantillas_tiempos");
  try { return v ? JSON.parse(v) : {}; } catch { return {}; }
}
async function anotarTiempo(nombre: string, tipo: string) {
  const t = await leerTiempos();
  t[nombre] = { tipo, pedida_at: new Date().toISOString() };
  await supabase.from("app_settings").upsert({ key: "wa_plantillas_tiempos", value: JSON.stringify(t) }, { onConflict: "key" });
}

async function handleTemplatesSync(body: Record<string, unknown>, adminEmail: string) {
  const aplicar = body.aplicar === true;
  const solo = Array.isArray(body.solo) ? (body.solo as unknown[]).map(String) : null;
  // `version_nueva: ["pedido_recibido", …]`: en vez de EDITAR la aprobada (1 cada 24 h y se corta mientras Meta revisa)
  // se crea pedido_recibido_v2 y se sigue mandando la activa hasta que Meta apruebe la nueva (templates_promover).
  const pideVersion = new Set(Array.isArray(body.version_nueva) ? (body.version_nueva as unknown[]).map(String) : []);
  const carrera = body.carrera === true;   // con version_nueva: también edita la activa (ver abajo)
  const versiones = await leerVersiones(supabase);
  let versionesCambiaron = false;

  const token = await metaToken();
  if (!token) return json({ ok: false, error: "Falta el token de WhatsApp (WHATSAPP_ACCESS_TOKEN)." }, 200);
  const { wabaId, wabaSource } = await resolveWaba(token);
  if (!wabaId) return json({ ok: false, error: "No se pudo determinar el WABA." }, 200);

  const res = await fetch(
    `${META_API}/${wabaId}/message_templates?limit=250&fields=id,name,status,language,category,components`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();
  if (data.error) {
    return json({ ok: false, error: `Meta (#${data.error.code ?? "?"}): ${data.error.message ?? ""}`, waba_id: wabaId }, 200);
  }
  // deno-lint-ignore no-explicit-any
  const enMeta = new Map<string, any>((data.data ?? []).map((t: any) => [`${t.name}|${t.language}`, t]));

  const nombresMeta = new Set<string>((data.data ?? []).map((t: { name: string }) => t.name));
  const plan = [];
  for (const p of PLANTILLAS) {
    if (solo && !solo.includes(p.name)) continue;
    const errores = validar(p);
    const activa = nombreActivo(versiones, p.name);
    let destino = versiones[p.name]?.nueva ?? activa;
    // Versión nueva pedida y la activa tiene otro texto: se crea base_vN en vez de editar.
    let creaVersion = false;
    // Pablo, 30/09: también si la activa está trabada en revisión (misma plantilla, otro nombre: la que Meta apruebe
    // primero es la que se usa; sirve para medir si una nueva sale más rápido que una edición).
    // Pablo, 30/09: "siempre por la versión nueva": si el texto cambió se crea base_vN (la activa sigue saliendo mientras
    // Meta revisa). Editar en el lugar sólo con `editar_en_lugar: true`.
    const actMeta = enMeta.get(`${activa}|${p.language}`);
    const botonesP = (p.botones ?? []).join("|");
    const iguales = (t: unknown) => bodyDe(t) === p.body && botonesDe(t) === botonesP;
    const difiere = !iguales(actMeta);
    if (actMeta && !versiones[p.name]?.nueva
        && ((difiere && body.editar_en_lugar !== true) || (pideVersion.has(p.name) && actMeta.status !== "APPROVED"))) {
      destino = siguienteNombre(p.name, versiones, nombresMeta);
      creaVersion = true;
    }
    const actual = enMeta.get(`${destino}|${p.language}`);
    // Los disparadores SQL arman un juego fijo de variables para la versión que se manda: una versión nueva con OTRA
    // cantidad de {{n}} rompería el aviso el día que se promueve (auditoría 30/09: pedido_listo_retirar en Meta tiene 2
    // y el repo 1). Sólo con `acepto_variables: true`, después de adaptar el disparador (patrón sql/108).
    const nVars = (t: string) => new Set(t.match(/\{\{\d+\}\}/g) ?? []).size;
    const cambiaVars = !!actMeta && (creaVersion || destino === activa) && nVars(bodyDe(actMeta)) !== nVars(p.body);
    const accion = errores.length ? "invalida"
      : cambiaVars && body.acepto_variables !== true && !(actual && iguales(actual)) ? "cambia_variables"
      : !actual ? "crear" : iguales(actual) ? "igual"
      // La versión nueva todavía en revisión con otro texto: Meta no deja editarla; se reintenta cuando se apruebe.
      : destino !== activa && actual.status === "PENDING" ? "nueva_en_revision" : "editar";
    // deno-lint-ignore no-explicit-any
    const fila: Record<string, any> = {
      name: p.name, nombre_meta: destino, ...(destino !== activa ? { activa } : {}), accion, estado_meta: actual?.status ?? "NO_EXISTE",
      ...(errores.length ? { errores } : {}),
      ...(accion === "editar" ? { texto_meta: bodyDe(actual), texto_nuevo: p.body } : {}),
      ...(accion === "cambia_variables" ? { texto_meta: bodyDe(actMeta), texto_nuevo: p.body,
        aviso: "cambia la cantidad de variables: no se crea hasta adaptar el disparador (acepto_variables: true)" } : {}),
      ...(accion === "editar" && actual?.status === "APPROVED"
        ? { aviso: "aprobada: vuelve a revisión y consume 1 de las ediciones (1/24 h, 10/30 días)" } : {}),
    };

    if (carrera && creaVersion && actMeta?.id && bodyDe(actMeta) !== p.body && actMeta.status !== "PENDING") {
      fila.carrera_plan = `también edita ${activa} (se corta mientras Meta la revisa)`;
    }
    if (aplicar && (accion === "crear" || accion === "editar")) {
      const url = accion === "crear" ? `${META_API}/${wabaId}/message_templates` : `${META_API}/${actual.id}`;
      const payload = accion === "crear"
        ? { name: destino, language: p.language, category: p.category, components: componentesMeta(p) }
        : { components: componentesMeta(p) };
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const out = await r.json();
      fila.resultado = out.error
        ? { ok: false, error: `Meta (#${out.error.code ?? "?"}${out.error.error_subcode ? "/" + out.error.error_subcode : ""}): ${out.error.error_user_msg ?? out.error.message ?? ""}` }
        : { ok: true, id: out.id ?? actual?.id ?? null, status: out.status ?? "PENDING", category: out.category ?? null };
      console.log(`templates_sync ${accion} ${destino} por ${adminEmail}:`, JSON.stringify(fila.resultado));
      if (fila.resultado.ok) await anotarTiempo(destino, accion === "crear" ? "creada" : "editada");
      if (creaVersion && fila.resultado.ok) {
        versiones[p.name] = { activa, nueva: destino };
        versionesCambiaron = true;
        // `carrera: true` (Pablo, 30/09): además de crear base_vN se EDITA la activa con el mismo texto, al mismo tiempo,
        // para medir qué aprueba Meta antes. Costo: la activa editada no se puede mandar mientras Meta la revisa, así que
        // el aviso se corta hasta que se apruebe una de las dos. Sólo sirve si las variables no cambian con la versión
        // (un disparador que arma distinto según la versión activa, como sql/108, se rompería).
        if (carrera && actMeta?.id && bodyDe(actMeta) !== p.body && actMeta.status !== "PENDING") {
          const re = await fetch(`${META_API}/${actMeta.id}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ components: componentesMeta(p) }),
          });
          const oe = await re.json();
          fila.carrera = oe.error
            ? { ok: false, error: `Meta (#${oe.error.code ?? "?"}): ${oe.error.error_user_msg ?? oe.error.message ?? ""}` }
            : { ok: true, editada: activa };
          console.log(`templates_sync carrera editar ${activa} por ${adminEmail}:`, JSON.stringify(fila.carrera));
          if (fila.carrera.ok) await anotarTiempo(activa, "editada");
        }
      }
    }
    plan.push(fila);
  }
  if (versionesCambiaron) await guardarVersiones(versiones);

  return json({ ok: true, aplicado: aplicar, waba_id: wabaId, waba_source: wabaSource, plan });
}

// ── templates_promover: pasa a mandar la versión nueva cuando Meta la aprobó (cron cada 30 min, sql/096) ──
// Con `borrar_vieja: true` además borra de Meta la versión anterior (irreversible: el nombre no se puede reusar por un
// tiempo). Por defecto NO borra: la vieja queda aprobada y sin uso.
async function handleTemplatesPromover(body: Record<string, unknown>, quien: string) {
  const versiones = await leerVersiones(supabase);
  const pendientes = Object.entries(versiones).filter(([, x]) => x.nueva);
  const tiempos = await leerTiempos();
  const sinResolver = Object.entries(tiempos).filter(([, x]) => !x.aprobada_at && !x.estado);
  if (!pendientes.length && !sinResolver.length) return json({ ok: true, promovidas: [], pendientes: [] });
  const token = await metaToken();
  if (!token) return json({ ok: false, error: "Falta el token de WhatsApp (WHATSAPP_ACCESS_TOKEN)." }, 200);
  const { wabaId } = await resolveWaba(token);
  if (!wabaId) return json({ ok: false, error: "No se pudo determinar el WABA." }, 200);
  const res = await fetch(`${META_API}/${wabaId}/message_templates?limit=250&fields=name,status`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.error) return json({ ok: false, error: `Meta: ${data.error.message ?? ""}` }, 200);
  const estado = new Map<string, string>((data.data ?? []).map((t: { name: string; status: string }) => [t.name, t.status]));
  // Tiempos: la primera vez que se la ve APPROVED (o REJECTED) queda la hora (resolución: la del cron, 30 min).
  if (sinResolver.length) {
    const ahora = new Date().toISOString();
    for (const [n, x] of sinResolver) {
      const st = estado.get(n);
      if (st === "APPROVED") x.aprobada_at = ahora;
      else if (st === "REJECTED") { x.estado = "REJECTED"; x.aprobada_at = ahora; }
    }
    await supabase.from("app_settings").upsert({ key: "wa_plantillas_tiempos", value: JSON.stringify(tiempos) }, { onConflict: "key" });
  }
  const promovidas: Array<Record<string, unknown>> = [], siguen: Array<Record<string, unknown>> = [];
  for (const [base, x] of pendientes) {
    const st = estado.get(x.nueva!) ?? "NO_EXISTE";
    if (st !== "APPROVED") { siguen.push({ base, nueva: x.nueva, estado: st }); continue; }
    const vieja = x.activa ?? base;
    versiones[base] = { activa: x.nueva };
    let borrada: unknown = null;
    if (body.borrar_vieja === true && vieja !== x.nueva) {
      const d = await fetch(`${META_API}/${wabaId}/message_templates?name=${encodeURIComponent(vieja)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      borrada = await d.json();
    }
    promovidas.push({ base, ahora: x.nueva, antes: vieja, borrada });
    console.log(`templates_promover ${base}: ${vieja} → ${x.nueva} por ${quien}`);
  }
  if (promovidas.length) await guardarVersiones(versiones);
  return json({ ok: true, promovidas, pendientes: siguen });
}

// ── factura_sync: edita en Meta las plantillas de factura (6 de Loekemeyer + 6 de Chef, pedido_*_chef) con el texto de
// _shared/plantillas-factura.ts. Las de Chef que todavía no existen en Meta se CREAN (acción "crear", 01/10); a las de
// Loekemeyer que no existen sólo se les avisa ("no_existe") ──
// (Pablo, 30/09: "¿no podés cambiarlo vos en WhatsApp Manager?"). Tienen encabezado Documento y Meta pide un PDF de
// muestra al editar: se genera uno de ejemplo, se sube con la API de subidas (app del token) y se manda su handle.
// Simulacro por defecto; `aplicar: true` aplica. `solo: [...]` limita. Crea SIEMPRE versión nueva (base_vN, Pablo 30/09):
// la activa sigue saliendo mientras Meta revisa y lk_promover-plantillas pasa a la nueva cuando la aprueba.
// `editar_en_lugar: true` edita la vigente (se corta el aviso mientras Meta la revisa).
async function handleFacturaSync(body: Record<string, unknown>, quien: string) {
  const aplicar = body.aplicar === true;
  const enLugar = body.editar_en_lugar === true;   // sólo a pedido: corta el aviso mientras Meta revisa
  const solo = Array.isArray(body.solo) ? (body.solo as unknown[]).map(String) : null;
  const token = await metaToken();
  if (!token) return json({ ok: false, error: "Falta el token de WhatsApp (WHATSAPP_ACCESS_TOKEN)." }, 200);
  const { wabaId } = await resolveWaba(token);
  if (!wabaId) return json({ ok: false, error: "No se pudo determinar el WABA." }, 200);
  const res = await fetch(`${META_API}/${wabaId}/message_templates?limit=250&fields=id,name,status,language,components`,
    { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.error) return json({ ok: false, error: `Meta: ${data.error.message ?? ""}` }, 200);
  // deno-lint-ignore no-explicit-any
  const enMeta = new Map<string, any>((data.data ?? []).map((t: any) => [t.name, t]));
  const nombresMeta = new Set<string>(enMeta.keys());
  const versiones = await leerVersiones(supabase);
  let versionesCambiaron = false;
  let handle: string | null = null;
  const plan = [];
  for (const p of PLANTILLAS_FACTURA) {
    if (solo && !solo.includes(p.name)) continue;
    const activa = nombreActivo(versiones, p.name);
    const nueva = versiones[p.name]?.nueva;
    const t = enMeta.get(activa);
    // deno-lint-ignore no-explicit-any
    const comp = (x: any, tipo: string) => (x?.components ?? []).find((c: any) => c.type === tipo);
    const actual = comp(t, "BODY")?.text ?? null;
    const tNueva = nueva ? enMeta.get(nueva) : null;
    let accion: string, destino = activa;
    if (!t) accion = p.empresa === "chef" ? "crear" : "no_existe";
    else if (actual === p.body) accion = "igual";
    else if (nueva) { destino = nueva; accion = comp(tNueva, "BODY")?.text === p.body ? "igual_nueva_en_revision" : "nueva_con_otro_texto"; }
    else if (enLugar) accion = "editar";
    else { destino = siguienteNombre(p.name, versiones, nombresMeta); accion = "crear_version"; }
    // deno-lint-ignore no-explicit-any
    const fila: Record<string, any> = { name: p.name, activa, nombre_meta: destino, accion, estado_meta: (destino === activa ? t : tNueva)?.status ?? "NO_EXISTE",
      ...(accion === "editar" || accion === "crear" || accion === "crear_version" || accion === "nueva_con_otro_texto" ? { texto_meta: actual, texto_nuevo: p.body } : {}) };
    if (aplicar && (accion === "editar" || accion === "crear" || accion === "crear_version")) {
      try {
        handle ??= await subirPdfMuestra(token);
        const pie = comp(t, "FOOTER");
        const components = [
          { type: "HEADER", format: "DOCUMENT", example: { header_handle: [handle] } },
          { type: "BODY", text: p.body, example: { body_text: [p.ejemplos] } },
          ...(pie?.text ? [{ type: "FOOTER", text: pie.text }] : []),
        ];
        const r = accion === "editar"
          ? await fetch(`${META_API}/${t.id}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ components }) })
          : await fetch(`${META_API}/${wabaId}/message_templates`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ name: destino, language: t?.language ?? "es_AR", category: "UTILITY", components }) });
        const out = await r.json();
        fila.resultado = out.error
          ? { ok: false, error: `Meta (#${out.error.code ?? "?"}${out.error.error_subcode ? "/" + out.error.error_subcode : ""}): ${out.error.error_user_msg ?? out.error.message ?? ""}` }
          : { ok: true, id: out.id ?? t?.id, status: out.status ?? "PENDING" };
      } catch (e) { fila.resultado = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      console.log(`factura_sync ${accion} ${destino} por ${quien}:`, JSON.stringify(fila.resultado));
      if (fila.resultado.ok) {
        await anotarTiempo(destino, accion === "editar" ? "editada" : "creada");
        if (accion === "crear_version") { versiones[p.name] = { activa, nueva: destino }; versionesCambiaron = true; nombresMeta.add(destino); }
      }
    }
    plan.push(fila);
  }
  if (versionesCambiaron) await guardarVersiones(versiones);
  return json({ ok: true, aplicado: aplicar, plan });
}

// PDF de muestra para el encabezado Documento (Meta lo pide al crear/editar): se genera acá y se sube con la API de
// subidas reanudables de la app dueña del token. Devuelve el handle ("h").
async function subirPdfMuestra(token: string): Promise<string> {
  let appId = "";
  const a = await (await fetch(`${META_API}/app?access_token=${encodeURIComponent(token)}`)).json();
  appId = a?.id ?? "";
  if (!appId) {
    const d = await (await fetch(`${META_API}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`)).json();
    appId = d?.data?.app_id ?? "";
  }
  if (!appId) throw new Error("no se pudo saber la app del token (para subir el PDF de muestra)");
  const doc = await PDFDocument.create();
  const pag = doc.addPage([420, 300]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  pag.drawText("Loekemeyer - Factura de ejemplo", { x: 40, y: 240, size: 18, font: f });
  pag.drawText("Documento de muestra para la plantilla de WhatsApp.", { x: 40, y: 200, size: 11, font: f });
  const bytes = await doc.save();
  const ses = await (await fetch(`${META_API}/${appId}/uploads?file_name=factura_ejemplo.pdf&file_length=${bytes.length}&file_type=application/pdf&access_token=${encodeURIComponent(token)}`,
    { method: "POST" })).json();
  if (!ses?.id) throw new Error(`Meta uploads: ${ses?.error?.message ?? JSON.stringify(ses).slice(0, 200)}`);
  const up = await (await fetch(`${META_API}/${ses.id}`, {
    method: "POST", headers: { Authorization: `OAuth ${token}`, file_offset: "0" }, body: bytes,
  })).json();
  if (!up?.h) throw new Error(`Meta upload: ${up?.error?.message ?? JSON.stringify(up).slice(0, 200)}`);
  return up.h;
}

// ── templates_preview: chat de prueba de plantillas (dashboard) ──
// Sin order_id: lista los últimos pedidos web LK para elegir. Con order_id: arma la
// secuencia de avisos que recibiría ese cliente (texto real de plantillas-meta.ts con
// sus datos). Sólo lee: no encola ni manda nada.
const fechaCorta = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "");
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
// "miércoles 30/09": fecha de salida con día de la semana, sin año.
const fechaLarga = (d?: string | null) =>
  d ? `${DIAS[new Date(d.slice(0, 10) + "T12:00:00Z").getUTCDay()]} ${fechaCorta(d)}` : "";
function masDias(d: string | null, n: number): string | null {
  if (!d) return null;
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
// deno-lint-ignore no-explicit-any
function modoDe(np: any): "propio" | "expreso" | "retira" {
  if (np.retiro_fecha || /retira/i.test(np.nombre_expreso ?? "")) return "retira";
  return np.nombre_expreso ? "expreso" : "propio";
}

async function handleTemplatesPreview(body: Record<string, unknown>) {
  const orderId = Number(body.order_id) || 0;
  if (!orderId) {
    const { data, error } = await supabase.from("v_pedidos_web_np")
      .select("order_id,razon_social,nombre_expreso,retiro_fecha")
      .eq("empresa", "lk").order("order_id", { ascending: false }).limit(150);
    if (error) return json({ ok: false, error: error.message }, 200);
    const vistos = new Set<number>();
    const pedidos = [];
    for (const r of data ?? []) {
      if (vistos.has(r.order_id)) continue;
      vistos.add(r.order_id);
      pedidos.push({ order_id: r.order_id, razon_social: r.razon_social, modo: modoDe(r) });
      if (pedidos.length >= 40) break;
    }
    return json({ ok: true, pedidos });
  }

  const [{ data: nps, error: e1 }, { data: ord }, { data: est }] = await Promise.all([
    supabase.from("v_pedidos_web_np")
      .select("order_id,np_idx,razon_social,direccion,localidad,nombre_expreso,retiro_fecha,fecha_recep")
      .eq("empresa", "lk").eq("order_id", orderId).order("np_idx"),
    supabase.from("orders").select("created_at").eq("id", orderId).maybeSingle(),
    supabase.rpc("bot_estado_pedidos_gv", { p_ids: [orderId] }),
  ]);
  if (e1) return json({ ok: false, error: e1.message }, 200);
  const np = nps?.[0];
  if (!np) return json({ ok: false, error: `No encontré el pedido web LK ${orderId}.` }, 200);

  const modo = modoDe(np);
  const estado = est?.[0] ?? null;
  const pedidoEl = (ord?.created_at ?? np.fecha_recep ?? "").slice(0, 10);
  const salida = modo === "retira" ? (np.retiro_fecha ?? estado?.fecha_entrega ?? null) : (estado?.fecha_entrega ?? null);
  const rs = np.razon_social ?? "";
  const fp = fechaCorta(pedidoEl);
  const sal = fechaLarga(salida) || "(sin fecha todavía)";
  const nueva = fechaLarga(masDias(salida, 2)) || "(nueva fecha)";
  const expreso = np.nombre_expreso ?? "";
  const direccion = [np.direccion, np.localidad].filter(Boolean).join(", ");

  const P = (etapa: string, name: string, params: string[], opcional = false) => {
    const def = PLANTILLAS.find((x) => x.name === name);
    const texto = (def?.body ?? "").replace(/\{\{(\d+)\}\}/g, (m, n) => params[Number(n) - 1] ?? m);
    return { etapa, template: name, params, texto, opcional };
  };
  const pasos = modo === "expreso"
    ? [P("Programado", "pedido_programado_expreso", [fp, sal, expreso.replace(/^expreso\s+/i, "")]),
       P("Cambio de fecha", "pedido_reprogramado", [fp, nueva], true),
       { etapa: "Facturado", template: "pedido_{contado|credito|echeq}_{s|p}", params: [], texto: "", opcional: false, nota: "Factura con datos de pago + PDF (plantillas existentes; se prueban en el simulador de facturas)." },
       P("Carga camión", "pedido_en_viaje_expreso", [fp, expreso.replace(/^expreso\s+/i, "")])]
    : modo === "retira"
    ? [P("Programado", "pedido_programado_retira", [fp, sal]),
       P("Cambio de fecha", "pedido_reprogramado", [fp, nueva], true),
       { etapa: "Facturado", template: "pedido_{contado|credito|echeq}_{s|p}", params: [], texto: "", opcional: false, nota: "Factura con datos de pago + PDF (plantillas existentes; se prueban en el simulador de facturas)." },
       P("Facturado · listo", "pedido_listo_retirar", [fp])]
    : [P("Programado", "pedido_programado", [fp, sal, direccion || "tu dirección de entrega"]),
       P("Cambio de fecha", "pedido_reprogramado", [fp, nueva], true),
       { etapa: "Facturado", template: "pedido_{contado|credito|echeq}_{s|p}", params: [], texto: "", opcional: false, nota: "Factura con datos de pago + PDF (plantillas existentes; se prueban en el simulador de facturas)." },
       P("Carga camión", "pedido_en_viaje", [fp, direccion])];

  return json({
    ok: true,
    pedido: { order_id: orderId, razon_social: rs, modo, pedido_el: pedidoEl, salida, expreso, direccion, estado_actual: estado?.status ?? null, nps: nps?.length ?? 0 },
    pasos,
  });
}
