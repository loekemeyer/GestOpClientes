import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

// Combinador de PDFs de facturas.
// DEPLOY TARGET: proyecto GP (hrxfctzncixxqmpfhskv) — donde viven los buckets isis-lk / isis-ch.
// Baja N PDFs de un bucket privado, los une en 1, lo sube y devuelve una URL firmada.
//
// POST { bucket, paths: string[], out_path, expires_seconds? }
//   -> { ok, bucket, out_path, pages, size, signed_url }

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
    const { bucket, paths, out_path } = body as {
      bucket?: string; paths?: string[]; out_path?: string;
    };
    const expires = Number(body.expires_seconds) || 60 * 60 * 24 * 7; // 7 días

    if (!bucket || !Array.isArray(paths) || !paths.length || !out_path) {
      return json({ error: "bucket, paths[] y out_path requeridos" }, 400);
    }

    const merged = await PDFDocument.create();
    const errores: { path: string; error: string }[] = [];

    for (const path of paths) {
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error || !data) {
        errores.push({ path, error: error?.message ?? "no se pudo descargar" });
        continue;
      }
      try {
        const bytes = new Uint8Array(await data.arrayBuffer());
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      } catch (e) {
        errores.push({ path, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (merged.getPageCount() === 0) {
      return json({ error: "ningún PDF se pudo combinar", detalle: errores }, 502);
    }

    const outBytes = await merged.save();

    const up = await supabase.storage.from(bucket).upload(out_path, outBytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (up.error) return json({ error: "upload falló: " + up.error.message }, 500);

    const signed = await supabase.storage.from(bucket).createSignedUrl(out_path, expires);

    return json({
      ok: true,
      bucket,
      out_path,
      pages: merged.getPageCount(),
      size: outBytes.length,
      combinados: paths.length - errores.length,
      errores: errores.length ? errores : undefined,
      signed_url: signed.data?.signedUrl ?? null,
    });
  } catch (err) {
    console.error("factura_combine error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
