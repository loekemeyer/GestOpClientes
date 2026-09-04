import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// lk_tpl-check — diagnóstico: estado en Meta de las plantillas que usa el bot.
// Usa el MISMO token que lk_factura-check (secret de proyecto WHATSAPP_ACCESS_TOKEN,
// fallback a app_settings.wa_token). Read-only: no envía nada. verify_jwt=false.

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
async function getSetting(k: string): Promise<string> {
  const { data } = await sb.from("app_settings").select("value").eq("key", k).maybeSingle();
  return data?.value ?? "";
}
const NUESTRAS = ["pedido_contado_s", "pedido_contado_p", "pedido_credito_s", "pedido_credito_p", "pedido_echeq_s", "pedido_echeq_p"];
const H = { "Content-Type": "application/json" };

serve(async () => {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? Deno.env.get("WA_TOKEN") ?? (await getSetting("wa_token"));
  const waba = Deno.env.get("WA_BUSINESS_ACCOUNT_ID") ?? (await getSetting("wa_business_account_id"));
  const fuente = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ? "env:WHATSAPP_ACCESS_TOKEN"
    : Deno.env.get("WA_TOKEN") ? "env:WA_TOKEN" : "app_settings:wa_token";
  if (!token || !waba) return new Response(JSON.stringify({ error: "sin token/waba", tiene_token: !!token, tiene_waba: !!waba }), { status: 200, headers: H });
  const url = `https://graph.facebook.com/v21.0/${waba}/message_templates?limit=200&fields=name,status,category,language`;
  // deno-lint-ignore no-explicit-any
  let data: any;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    data = await res.json();
    if (!res.ok) return new Response(JSON.stringify({ error: data?.error?.message ?? `HTTP ${res.status}`, code: data?.error?.code ?? null, fuente }), { status: 200, headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), fuente }), { status: 200, headers: H });
  }
  // deno-lint-ignore no-explicit-any
  const byName: Record<string, any> = {};
  for (const t of (data.data ?? [])) byName[t.name] = { status: t.status, language: t.language };
  const plantillas = NUESTRAS.map((n) => ({ name: n, status: byName[n]?.status ?? "NO_EXISTE", language: byName[n]?.language ?? null }));
  return new Response(JSON.stringify({ ok: true, fuente_token: fuente, plantillas, total_en_meta: (data.data ?? []).length, checked_at: new Date().toISOString() }), { status: 200, headers: H });
});
