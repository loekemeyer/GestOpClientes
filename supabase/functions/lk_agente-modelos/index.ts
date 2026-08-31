// lk_agente-modelos — gestión segura de modelos del agente.
// La API key se tipea en el front, viaja acá (server), se valida contra el
// proveedor y se guarda en wa_agente_model_keys (tabla bloqueada, RLS solo
// service_role). El navegador nunca lee la key.
//
// Acciones:
//   check  { api_key, proveedor? }            → detecta proveedor + lista modelos (no guarda)
//   save   { api_key, proveedor, model_id, label?, notas? } → valida + guarda key + config
//   delete { id }                             → borra modelo (y su key si es 'db')

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

/** Adivina el proveedor por el formato de la key. */
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
  try {
    if (provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) return { ok: false, error: `Anthropic HTTP ${r.status}` };
      const d = await r.json();
      // deno-lint-ignore no-explicit-any
      return { ok: true, models: (d.data ?? []).map((m: any) => m.id) };
    }
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return { ok: false, error: `OpenAI HTTP ${r.status}` };
      const d = await r.json();
      // deno-lint-ignore no-explicit-any
      return { ok: true, models: (d.data ?? []).map((m: any) => m.id).sort() };
    }
    if (provider === "google") {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      );
      if (!r.ok) return { ok: false, error: `Google HTTP ${r.status}` };
      const d = await r.json();
      // deno-lint-ignore no-explicit-any
      return { ok: true, models: (d.models ?? []).map((m: any) => String(m.name).replace(/^models\//, "")) };
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const action = body.action;

    if (action === "check") {
      const key = String(body.api_key ?? "").trim();
      if (!key) return json({ error: "Pegá la API key" }, 400);
      const provider = (body.proveedor as string) || detectProvider(key);
      if (!provider) {
        return json({ error: "No pude detectar el proveedor por el formato de la key. Elegí uno manualmente." }, 400);
      }
      const res = await listModels(provider, key);
      if (!res.ok) return json({ error: `Key inválida o sin acceso: ${res.error}` }, 400);
      return json({ ok: true, proveedor: provider, models: res.models });
    }

    if (action === "save") {
      const key = String(body.api_key ?? "").trim();
      const proveedor = String(body.proveedor ?? "").trim();
      const model_id = String(body.model_id ?? "").trim();
      const label = String(body.label ?? "").trim() || model_id;
      const notas = body.notas ? String(body.notas) : null;
      if (!key || !proveedor || !model_id) return json({ error: "Faltan datos (key, proveedor, model_id)" }, 400);

      // Re-validar antes de guardar
      const res = await listModels(proveedor, key);
      if (!res.ok) return json({ error: `Key inválida: ${res.error}` }, 400);

      // Guardar la key en la tabla bloqueada
      const { data: keyRow, error: kErr } = await sb
        .from("wa_agente_model_keys")
        .insert({ api_key: key })
        .select("id")
        .single();
      if (kErr) return json({ error: kErr.message }, 500);

      const { error: mErr } = await sb.from("wa_agente_modelos").insert({
        proveedor,
        label,
        model_id,
        secret_ref: null,
        key_source: "db",
        key_id: keyRow.id,
        key_last4: key.slice(-4),
        activo: true,
        es_default: false,
        notas,
      });
      if (mErr) {
        // rollback de la key si el modelo falló
        await sb.from("wa_agente_model_keys").delete().eq("id", keyRow.id);
        return json({ error: mErr.message }, 500);
      }
      return json({ ok: true, last4: key.slice(-4) });
    }

    if (action === "delete") {
      const id = body.id;
      if (!id) return json({ error: "id requerido" }, 400);
      const { data: m } = await sb
        .from("wa_agente_modelos")
        .select("id, key_id, es_default")
        .eq("id", id)
        .maybeSingle();
      if (!m) return json({ error: "El modelo no existe" }, 404);
      if (m.es_default) return json({ error: "No se puede borrar el modelo default. Marcá otro como default primero." }, 400);
      await sb.from("wa_agente_modelos").delete().eq("id", id);
      if (m.key_id) await sb.from("wa_agente_model_keys").delete().eq("id", m.key_id);
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
