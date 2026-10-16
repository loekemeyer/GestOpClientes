// lk_bitacora-resumen — arma el resumen en lenguaje simple (lista de viñetas) de un día de
// trabajo, a partir de las áreas y los títulos de los cambios. Lo usa la carga diaria de la
// bitácora (scripts/reporte-diario/bitacora-cargar.mjs, que corre en GitHub Actions).
//
// Por qué una edge y no llamar al modelo desde el runner: la key de Anthropic es un secreto de
// las Edge Functions (Deno.env ANTHROPIC_API_KEY), no está en la base, así que GitHub Actions no
// la puede leer. Esta function sí la tiene en su entorno. Se protege con el mismo header
// x-bitacora-secret que lk_bitacora-sync (valor en app_settings, key 'bitacora_sync_secret').
//
// Modelo FIJO claude-haiku-5-5 (decisión de Pablo, 16/10). NO habla con Meta: no importa wa-guard.

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AKEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODELO = "claude-haiku-5-5";

async function secretoEsperado(): Promise<string> {
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

function armarPrompt(areas: unknown, asuntos: string[]): string {
  return (
    "A partir de la lista de cambios de un dia de trabajo en un bot de WhatsApp y su panel, escribi un resumen para alguien que NO programa. " +
    "Reglas: entre 4 y 8 vinetas, cada una una linea corta (maximo unos 90 caracteres), contando QUE cambio para el negocio o para quien usa el bot o el panel. " +
    "Ignora por completo lo que sea documentacion, notas internas, merges, tests o refactors. " +
    "Nada de terminos tecnicos (nada de SQL, deploy, commit, endpoint, API, funcion, tabla, migracion, branch, base de datos). " +
    "No uses punto y coma. Devolve SOLO las vinetas, cada una empezando con '• ', sin titulo ni texto extra.\n\n" +
    `Areas tocadas: ${JSON.stringify(areas)}\nCambios:\n${asuntos.join("\n")}`
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("solo POST", { status: 405, headers: CORS });

  const SECRET = await secretoEsperado();
  if (!SECRET || req.headers.get("x-bitacora-secret") !== SECRET) {
    return new Response(JSON.stringify({ error: "no autorizado" }), { status: 401, headers: JSON_H });
  }
  if (!AKEY) {
    return new Response(JSON.stringify({ error: "sin ANTHROPIC_API_KEY" }), { status: 500, headers: JSON_H });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "json inválido" }), { status: 400, headers: JSON_H });
  }

  const asuntos = (Array.isArray(body?.asuntos) ? body.asuntos : [])
    .map((s) => String(s))
    .filter(Boolean);
  if (asuntos.length === 0) {
    return new Response(JSON.stringify({ error: "faltan asuntos" }), { status: 400, headers: JSON_H });
  }
  const areas = body?.areas && typeof body.areas === "object" ? body.areas : {};

  let data: Record<string, unknown>;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 600,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: armarPrompt(areas, asuntos) }],
      }),
    });
    if (!r.ok) {
      const detalle = await r.text();
      return new Response(JSON.stringify({ error: "anthropic falló", status: r.status, detalle }), { status: 502, headers: JSON_H });
    }
    data = await r.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "anthropic error", detalle: String(e) }), { status: 502, headers: JSON_H });
  }

  const texto = (Array.isArray(data?.content) ? data.content : [])
    .filter((b: Record<string, unknown>) => b?.type === "text")
    .map((b: Record<string, unknown>) => String(b?.text ?? ""))
    .join("");
  const vinetas = texto
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("•"))
    .map((l) => l.replace(/;/g, ","));

  if (vinetas.length < 2) {
    return new Response(JSON.stringify({ error: "sin viñetas", texto }), { status: 502, headers: JSON_H });
  }
  return new Response(JSON.stringify({ ok: true, resumen: vinetas.join("\n"), modelo: MODELO }), { headers: JSON_H });
});
