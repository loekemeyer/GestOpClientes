import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Función dedicada a plantillas WhatsApp: listar (Meta) + enviar prueba.
// Autocontenida (no depende de _shared) para no tocar lk_whatsapp-webhook ni lk_chat-test.

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
async function metaToken(): Promise<string> {
  return Deno.env.get("WA_TOKEN")
    ?? Deno.env.get("META_ACCESS_TOKEN")
    ?? (await getSetting("wa_token")) ?? "";
}
async function metaPhoneNumberId(): Promise<string> {
  return Deno.env.get("WA_PHONE_NUMBER_ID")
    ?? Deno.env.get("META_PHONE_NUMBER_ID")
    ?? (await getSetting("wa_phone_number_id")) ?? "";
}
async function metaWabaId(): Promise<string> {
  return Deno.env.get("WA_BUSINESS_ACCOUNT_ID")
    ?? Deno.env.get("META_BUSINESS_ACCOUNT_ID")
    ?? (await getSetting("wa_business_account_id")) ?? "";
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

    if (body.action === "templates_list") return await handleTemplatesList(body.status);
    if (body.action === "template_send") return await handleTemplateSend(body);

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_templates error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function handleTemplatesList(statusFilter?: string) {
  const wabaId = await metaWabaId();
  const token = await metaToken();
  console.log(`templates_list: wabaId=${wabaId ? "len" + wabaId.length : "MISSING"} token=${token ? "len" + token.length : "MISSING"}`);
  if (!wabaId) return json({ error: "WABA ID no configurado (WA_BUSINESS_ACCOUNT_ID o app_settings.wa_business_account_id)" }, 400);
  if (!token) return json({ error: "WA_TOKEN no configurado" }, 400);

  const params = new URLSearchParams({ limit: "100" });
  if (statusFilter ?? "APPROVED") params.set("status", statusFilter ?? "APPROVED");

  const res = await fetch(`${META_API}/${wabaId}/message_templates?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) return json({ error: data.error.message ?? JSON.stringify(data.error) }, 500);

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

  return json({ templates, count: templates.length });
}

async function handleTemplateSend(body: Record<string, unknown>) {
  const { phone, template_name, language, params } = body as {
    phone?: string; template_name?: string; language?: string; params?: unknown[];
  };
  if (!phone || !template_name) return json({ error: "phone y template_name requeridos" }, 400);

  const phoneNumberId = await metaPhoneNumberId();
  const token = await metaToken();
  if (!phoneNumberId) return json({ error: "WA_PHONE_NUMBER_ID no configurado" }, 400);
  if (!token) return json({ error: "WA_TOKEN no configurado" }, 400);

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
    const errMsg = result.error.message ?? JSON.stringify(result.error);
    return json({ ok: false, error: errMsg, to, template_name }, 502);
  }

  // Log en wa_conversations (fire and forget)
  supabase.from("wa_conversations").insert([
    { phone: to, direction: "out", body: `[template: ${template_name}]`, msg_type: "template", customer_id: null, intent: "template_test" },
  ]).then(() => {}).catch((e: unknown) => console.error("conv log err:", e));

  return json({ ok: true, to, template_name, language: lang, result });
}
