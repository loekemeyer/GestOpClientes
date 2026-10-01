import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// lk_tpl-check — diagnóstico: estado en Meta de las plantillas que usa el bot.
// Usa el MISMO token que lk_factura-check (secret de proyecto WHATSAPP_ACCESS_TOKEN,
// fallback a app_settings.wa_token). Read-only: no envía nada. verify_jwt=false.
// Devuelve `plantillas` (las 14 que usa el bot) y `otras` (el resto de la cuenta).

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
async function getSetting(k: string): Promise<string> {
  const { data } = await sb.from("app_settings").select("value").eq("key", k).maybeSingle();
  return data?.value ?? "";
}
// Factura (6 de Loekemeyer + 6 de Chef, _chef) + seguimiento de pedido (8, lk_templates/plantillas-meta.ts).
const NUESTRAS = [
  "pedido_contado_s", "pedido_contado_p", "pedido_credito_s", "pedido_credito_p", "pedido_echeq_s", "pedido_echeq_p",
  "pedido_contado_s_chef", "pedido_contado_p_chef", "pedido_credito_s_chef", "pedido_credito_p_chef", "pedido_echeq_s_chef", "pedido_echeq_p_chef",
  "pedido_programado", "pedido_programado_expreso", "pedido_programado_retira", "pedido_reprogramado",
  "pedido_preparando", "pedido_en_viaje", "pedido_en_viaje_expreso", "pedido_listo_retirar",
  "comprobante_recibido", "comprobante_recibido_chef",
];
const H = { "Content-Type": "application/json" };

serve(async (req) => {
  // {"modo":"artifact"} (Pablo, 30/09): devuelve lo mismo que scripts/plantillas-artifact/datos.sql, así la Routine diaria
  // arma el artifact y el informe de estados con un curl, sin MCP de Supabase (las Routines no lo tienen). Sólo lectura.
  const modo = req.method === "POST" ? String((await req.json().catch(() => ({})))?.modo ?? "") : "";
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? Deno.env.get("WA_TOKEN") ?? (await getSetting("wa_token"));
  const waba = Deno.env.get("WA_BUSINESS_ACCOUNT_ID") ?? (await getSetting("wa_business_account_id"));
  const fuente = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ? "env:WHATSAPP_ACCESS_TOKEN"
    : Deno.env.get("WA_TOKEN") ? "env:WA_TOKEN" : "app_settings:wa_token";
  if (!token || !waba) return new Response(JSON.stringify({ error: "sin token/waba", tiene_token: !!token, tiene_waba: !!waba }), { status: 200, headers: H });
  const url = `https://graph.facebook.com/v21.0/${waba}/message_templates?limit=200&fields=name,status,category,language,rejected_reason${modo === "artifact" ? ",components" : ""}`;
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
  for (const t of (data.data ?? [])) byName[t.name] = t;
  const fila = (n: string) => ({
    name: n, status: byName[n]?.status ?? "NO_EXISTE", category: byName[n]?.category ?? null,
    language: byName[n]?.language ?? null,
    ...(byName[n]?.rejected_reason && byName[n].rejected_reason !== "NONE" ? { rejected_reason: byName[n].rejected_reason } : {}),
  });
  if (modo === "artifact") return new Response(JSON.stringify(await datosArtifact(data.data ?? [])), { status: 200, headers: H });
  const plantillas = NUESTRAS.map(fila);
  // El resto de las plantillas de la cuenta (sólo nombre/estado), para ver qué más hay cargado.
  const otras = Object.keys(byName).filter((n) => !NUESTRAS.includes(n)).sort().map(fila);
  return new Response(JSON.stringify({ ok: true, fuente_token: fuente, plantillas, otras, total_en_meta: (data.data ?? []).length, checked_at: new Date().toISOString() }), { status: 200, headers: H });
});

// Misma forma que datos.sql: { generado, llave, versiones, plantillas[], uso{} } + tiempos y rechazos de 24 h.
// deno-lint-ignore no-explicit-any
async function datosArtifact(ts: any[]) {
  // deno-lint-ignore no-explicit-any
  const comp = (t: any, tipo: string) => (t.components ?? []).find((c: any) => c.type === tipo);
  const plantillas = ts.map((t) => ({
    name: t.name, status: t.status, category: t.category, language: t.language,
    header: comp(t, "HEADER")?.format ?? null, header_text: comp(t, "HEADER")?.text ?? null,
    body: comp(t, "BODY")?.text ?? null, footer: comp(t, "FOOTER")?.text ?? null,
    // deno-lint-ignore no-explicit-any
    buttons: comp(t, "BUTTONS")?.buttons?.map((b: any) => b.text) ?? null,
    ejemplos: comp(t, "BODY")?.example?.body_text?.[0] ?? null,
    ...(t.rejected_reason && t.rejected_reason !== "NONE" ? { rejected_reason: t.rejected_reason } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const json = (v: string) => { try { return v ? JSON.parse(v) : {}; } catch { return {}; } };
  const desde30 = new Date(Date.now() - 30 * 86400_000).toISOString(), desde24 = Date.now() - 86400_000;
  const { data: filas } = await sb.from("wa_outbox").select("template_name, status, created_at, error")
    .not("template_name", "is", null).gte("created_at", desde30).limit(10000);
  const uso: Record<string, { enviados: number; retenidos: number; ultimo: string }> = {};
  const rechazos_24h: Record<string, { n: number; error: string }> = {};
  for (const f of filas ?? []) {
    const u = uso[f.template_name] ??= { enviados: 0, retenidos: 0, ultimo: "" };
    if (f.status === "sent") u.enviados++;
    if (String(f.status).startsWith("held")) u.retenidos++;
    const dia = String(f.created_at).slice(0, 10);
    if (dia > u.ultimo) u.ultimo = dia;
    if (f.error && f.status !== "sent" && new Date(f.created_at).getTime() > desde24) {   // los que al final salieron no cuentan
      const r = rechazos_24h[f.template_name] ??= { n: 0, error: "" };
      r.n++; r.error = String(f.error).slice(0, 120);
    }
  }
  return {
    generado: new Date().toISOString(), llave: await getSetting("wa_envio_automatico"),
    versiones: json(await getSetting("wa_plantillas_version")), tiempos: json(await getSetting("wa_plantillas_tiempos")),
    plantillas, uso, rechazos_24h,
  };
}
