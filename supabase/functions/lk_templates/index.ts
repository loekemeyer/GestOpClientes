import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { PLANTILLAS, componentesMeta, validar } from "./plantillas-meta.ts";

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
    const gate = await requireAdmin(body);
    if (!gate.ok) return json({ error: gate.error }, gate.status);

    if (body.action === "templates_list") return await handleTemplatesList(body.status);
    if (body.action === "template_send") return await handleTemplateSend(body);
    if (body.action === "templates_sync") return await handleTemplatesSync(body, gate.email);
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

async function handleTemplatesSync(body: Record<string, unknown>, adminEmail: string) {
  const aplicar = body.aplicar === true;
  const solo = Array.isArray(body.solo) ? (body.solo as unknown[]).map(String) : null;

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

  const plan = [];
  for (const p of PLANTILLAS) {
    if (solo && !solo.includes(p.name)) continue;
    const errores = validar(p);
    const actual = enMeta.get(`${p.name}|${p.language}`);
    const accion = errores.length ? "invalida" : !actual ? "crear" : bodyDe(actual) === p.body ? "igual" : "editar";
    // deno-lint-ignore no-explicit-any
    const fila: Record<string, any> = {
      name: p.name, accion, estado_meta: actual?.status ?? "NO_EXISTE",
      ...(errores.length ? { errores } : {}),
      ...(accion === "editar" ? { texto_meta: bodyDe(actual), texto_nuevo: p.body } : {}),
      ...(accion === "editar" && actual?.status === "APPROVED"
        ? { aviso: "aprobada: vuelve a revisión y consume 1 de las ediciones (1/24 h, 10/30 días)" } : {}),
    };

    if (aplicar && (accion === "crear" || accion === "editar")) {
      const url = accion === "crear" ? `${META_API}/${wabaId}/message_templates` : `${META_API}/${actual.id}`;
      const payload = accion === "crear"
        ? { name: p.name, language: p.language, category: p.category, components: componentesMeta(p) }
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
      console.log(`templates_sync ${accion} ${p.name} por ${adminEmail}:`, JSON.stringify(fila.resultado));
    }
    plan.push(fila);
  }

  return json({ ok: true, aplicado: aplicar, waba_id: wabaId, waba_source: wabaSource, plan });
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
    ? [P("Programado", "pedido_programado_expreso", [rs, fp, sal, expreso]),
       P("Cambio de fecha", "pedido_reprogramado", [rs, fp, nueva], true),
       P("Inicio de picking", "pedido_preparando", [rs, fp, sal]),
       { etapa: "Facturado", template: "pedido_{contado|credito|echeq}_{s|p}", params: [], texto: "", opcional: false, nota: "Factura con datos de pago + PDF (plantillas existentes; se prueban en el simulador de facturas)." },
       P("Carga camión", "pedido_en_viaje_expreso", [rs, fp, expreso])]
    : modo === "retira"
    ? [P("Programado", "pedido_programado_retira", [rs, fp, sal]),
       P("Cambio de fecha", "pedido_reprogramado", [rs, fp, nueva], true),
       P("Inicio de picking", "pedido_preparando", [rs, fp, sal]),
       { etapa: "Facturado", template: "pedido_{contado|credito|echeq}_{s|p}", params: [], texto: "", opcional: false, nota: "Factura con datos de pago + PDF (plantillas existentes; se prueban en el simulador de facturas)." },
       P("Facturado · listo", "pedido_listo_retirar", [rs, fp])]
    : [P("Programado", "pedido_programado", [rs, fp, sal]),
       P("Cambio de fecha", "pedido_reprogramado", [rs, fp, nueva], true),
       P("Inicio de picking", "pedido_preparando", [rs, fp, sal]),
       { etapa: "Facturado", template: "pedido_{contado|credito|echeq}_{s|p}", params: [], texto: "", opcional: false, nota: "Factura con datos de pago + PDF (plantillas existentes; se prueban en el simulador de facturas)." },
       P("Carga camión", "pedido_en_viaje", [rs, fp, direccion])];

  return json({
    ok: true,
    pedido: { order_id: orderId, razon_social: rs, modo, pedido_el: pedidoEl, salida, expreso, direccion, estado_actual: estado?.status ?? null, nps: nps?.length ?? 0 },
    pasos,
  });
}
