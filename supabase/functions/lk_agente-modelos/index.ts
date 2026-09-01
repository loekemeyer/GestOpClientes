// lk_agente-modelos — gestión segura de modelos del agente.
// La API key se tipea en el front, viaja acá (server), se valida contra el
// proveedor y se guarda en wa_agente_model_keys (tabla bloqueada, RLS solo
// service_role). Una key = todos sus modelos en "disponibles".
//
// Acciones:
//   check       { api_key, proveedor? }              → detecta proveedor + lista modelos (no guarda)
//   add_key     { api_key, proveedor?, label? }      → valida + guarda key + agrega TODOS sus modelos
//   refresh_key { key_id }                           → re-lista modelos de una key (env o db) y agrega los nuevos
//   delete_key  { key_id }                           → borra la key y todos sus modelos (no env)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function detectProvider(key: string): string | null {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("AIza")) return "google";
  if (key.startsWith("sk-")) return "openai";
  return null;
}

/** Valida la key contra el proveedor y devuelve los modelos disponibles. */
async function listModels(
  provider: string,
  key: string,
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const bodyErr = async (r: Response): Promise<string> => {
    try {
      const t = await r.text();
      try {
        const j = JSON.parse(t);
        return j?.error?.message || j?.error?.type || j?.message || t.slice(0, 300);
      } catch {
        return t.slice(0, 300);
      }
    } catch {
      return "";
    }
  };

  try {
    if (provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) return { ok: false, error: `Anthropic HTTP ${r.status}: ${await bodyErr(r)}` };
      const d = await r.json();
      // deno-lint-ignore no-explicit-any
      return { ok: true, models: (d.data ?? []).map((m: any) => m.id) };
    }
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return { ok: false, error: `OpenAI HTTP ${r.status}: ${await bodyErr(r)}` };
      const d = await r.json();
      // deno-lint-ignore no-explicit-any
      return { ok: true, models: (d.data ?? []).map((m: any) => m.id).sort() };
    }
    if (provider === "google") {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`,
      );
      if (!r.ok) return { ok: false, error: `Google HTTP ${r.status}: ${await bodyErr(r)}` };
      const d = await r.json();
      const models = (d.models ?? [])
        // deno-lint-ignore no-explicit-any
        .filter((m: any) => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes("generateContent"))
        // deno-lint-ignore no-explicit-any
        .map((m: any) => String(m.name).replace(/^models\//, ""));
      return { ok: true, models };
    }
    return { ok: false, error: "Proveedor no soportado (anthropic / openai / google)" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Inserta en wa_agente_modelos los model_id que aún no están para esa key. */
async function syncModels(keyId: number, proveedor: string, last4: string | null, models: string[]): Promise<{ count: number; error?: string }> {
  const { data: existing } = await sb
    .from("wa_agente_modelos")
    .select("model_id")
    .eq("key_id", keyId);
  const have = new Set((existing ?? []).map((r) => r.model_id));
  const rows = models
    .filter((mid) => !have.has(mid))
    .map((mid) => ({
      key_id: keyId,
      proveedor,
      label: mid,
      model_id: mid,
      key_source: "db",
      key_last4: last4,
      secret_ref: null,
      prioridad: null,
      estado: "ok",
    }));
  if (!rows.length) return { count: 0 };
  const { error } = await sb.from("wa_agente_modelos").insert(rows);
  if (error) {
    console.error(`[syncModels] insert falló: ${error.message}`);
    return { count: 0, error: error.message };
  }
  return { count: rows.length };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const action = body.action;

    if (action === "check") {
      const key = String(body.api_key ?? "").trim();
      if (!key) return json({ error: "Pegá la API key" }, 400);
      const provider = (body.proveedor as string) || detectProvider(key);
      if (!provider) return json({ error: "No pude detectar el proveedor por el formato de la key. Elegí uno manualmente." }, 400);
      const res = await listModels(provider, key);
      if (!res.ok) {
        console.error(`[check] ${provider}: ${res.error}`);
        return json({ error: `Key inválida o sin acceso: ${res.error}` }, 400);
      }
      return json({ ok: true, proveedor: provider, models: res.models });
    }

    if (action === "add_key") {
      const key = String(body.api_key ?? "").trim();
      if (!key) return json({ error: "Pegá la API key" }, 400);
      const provider = (body.proveedor as string) || detectProvider(key);
      if (!provider) return json({ error: "No pude detectar el proveedor por el formato de la key. Elegí uno manualmente." }, 400);
      const res = await listModels(provider, key);
      if (!res.ok) {
        console.error(`[add_key] ${provider}: ${res.error}`);
        return json({ error: `Key inválida o sin acceso: ${res.error}` }, 400);
      }
      const last4 = key.slice(-4);
      const { data: keyRow, error: kErr } = await sb
        .from("wa_agente_model_keys")
        .insert({ proveedor: provider, label: (body.label as string) || null, api_key: key, key_source: "db", key_last4: last4 })
        .select("id")
        .single();
      if (kErr) return json({ error: kErr.message }, 500);
      const sync = await syncModels(keyRow.id, provider, last4, res.models ?? []);
      if (sync.error) return json({ error: `Key guardada pero no pude agregar modelos: ${sync.error}` }, 500);
      return json({ ok: true, proveedor: provider, count: sync.count });
    }

    if (action === "refresh_key") {
      const keyId = body.key_id;
      if (!keyId) return json({ error: "key_id requerido" }, 400);
      const { data: k } = await sb
        .from("wa_agente_model_keys")
        .select("id, proveedor, key_source, secret_ref, api_key, key_last4")
        .eq("id", keyId)
        .maybeSingle();
      if (!k) return json({ error: "La key no existe" }, 404);
      const key = k.key_source === "env" ? (Deno.env.get(k.secret_ref ?? "") ?? "") : (k.api_key ?? "");
      if (!key) return json({ error: "No hay credencial disponible para esa key" }, 400);
      const res = await listModels(k.proveedor, key);
      if (!res.ok) return json({ error: `No pude listar modelos: ${res.error}` }, 400);
      const sync = await syncModels(k.id, k.proveedor, k.key_last4, res.models ?? []);
      if (sync.error) return json({ error: `No pude agregar modelos: ${sync.error}` }, 500);
      return json({ ok: true, added: sync.count });
    }

    if (action === "delete_key") {
      const keyId = body.key_id;
      if (!keyId) return json({ error: "key_id requerido" }, 400);
      const { data: k } = await sb
        .from("wa_agente_model_keys")
        .select("id, key_source")
        .eq("id", keyId)
        .maybeSingle();
      if (!k) return json({ error: "La key no existe" }, 404);
      if (k.key_source === "env") return json({ error: "La key de Secrets no se borra desde acá (se administra en Supabase → Secrets)." }, 400);
      await sb.from("wa_agente_modelos").delete().eq("key_id", keyId);
      await sb.from("wa_agente_model_keys").delete().eq("id", keyId);
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
