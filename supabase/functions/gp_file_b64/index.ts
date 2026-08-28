import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Devuelve un objeto de storage como base64. SOLO LECTURA. DEPLOY TARGET: GP (hrxfctzncixxqmpfhskv).
// Se invoca por pg_net desde la propia DB (supabase.co está bloqueado para el agente/proxy),
// para poder traer un PDF (factura o NP) a disco local para inspección/muestra.
// POST { bucket, path } -> { size, b64 }
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

Deno.serve(async (req) => {
  try {
    const { bucket, path } = await req.json();
    if (!bucket || !path) return new Response(JSON.stringify({ error: "bucket y path requeridos" }), { status: 400 });
    const { data, error } = await sb.storage.from(bucket).download(path);
    if (error || !data) return new Response(JSON.stringify({ error: error?.message ?? "download" }), { status: 404 });
    const bytes = new Uint8Array(await data.arrayBuffer());
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return new Response(JSON.stringify({ size: bytes.length, b64: btoa(bin) }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
