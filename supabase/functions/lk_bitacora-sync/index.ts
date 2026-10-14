// lk_bitacora-sync — upsert de la bitácora diaria de trabajo en public.bitacora_dias.
//
// Qué hace: recibe uno o varios "días" de la bitácora (lo que arma scripts/reporte-diario)
// y los inserta/actualiza en la tabla que lee el dashboard (pestaña Bitácora, calendario).
// Es el puente que usa la Routine diaria para escribir en la página, además del Artifact.
//
// NO habla con Meta: no importa _shared/wa-guard.ts a propósito (no es una salida de WhatsApp).
// Usa el service-role que Supabase inyecta solo en las edge functions; nunca va en el repo.
// Protegida por el header x-bitacora-secret, cuyo valor vive en app_settings
// (key 'bitacora_sync_secret'): la function lo lee con service-role y anon no puede leerlo.

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function secretoEsperado(): Promise<string> {
  // Respaldo por env por si alguna vez se carga ahí; la fuente real es app_settings.
  const env = Deno.env.get("BITACORA_SYNC_SECRET");
  if (env) return env;
  const r = await fetch(
    `${URL}/rest/v1/app_settings?key=eq.bitacora_sync_secret&select=value`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
  );
  if (!r.ok) return "";
  const rows = await r.json();
  return rows?.[0]?.value ?? "";
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-bitacora-secret, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JSON_H = { ...CORS, "Content-Type": "application/json" };

function normalizar(d: Record<string, unknown>) {
  return {
    dia: String(d.dia ?? ""),
    commits: Number(d.commits) || 0,
    autores: Array.isArray(d.autores) ? d.autores : [],
    areas: d.areas && typeof d.areas === "object" ? d.areas : {},
    asuntos: Array.isArray(d.asuntos) ? d.asuntos : [],
    audit: d.audit && typeof d.audit === "object" ? d.audit : { abiertos: 0, cerrados: 0 },
    resumen: typeof d.resumen === "string" ? d.resumen : null,
    fuente: typeof d.fuente === "string" ? d.fuente : null,
    updated_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("solo POST", { status: 405, headers: CORS });
  const SECRET = await secretoEsperado();
  if (!SECRET || req.headers.get("x-bitacora-secret") !== SECRET) {
    return new Response(JSON.stringify({ error: "no autorizado" }), { status: 401, headers: JSON_H });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "json inválido" }), { status: 400, headers: JSON_H });
  }

  const lista = Array.isArray(body?.dias)
    ? (body.dias as Record<string, unknown>[])
    : (body?.dia ? [body] : null);
  if (!lista || lista.length === 0) {
    return new Response(JSON.stringify({ error: "faltan dias" }), { status: 400, headers: JSON_H });
  }

  const filas = lista.map(normalizar).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.dia));
  if (filas.length === 0) {
    return new Response(JSON.stringify({ error: "ningun dia con fecha valida" }), { status: 400, headers: JSON_H });
  }

  const resp = await fetch(`${URL}/rest/v1/bitacora_dias?on_conflict=dia`, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(filas),
  });

  if (!resp.ok) {
    const detalle = await resp.text();
    return new Response(JSON.stringify({ error: "upsert falló", detalle }), { status: 502, headers: JSON_H });
  }

  return new Response(JSON.stringify({ ok: true, filas: filas.length }), { headers: JSON_H });
});
