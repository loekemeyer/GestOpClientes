import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

// Orquestador de consolidación de facturas (ON-DEMAND, sin cron, sin timeout, SIN envío).
// DEPLOY TARGET: PaginaLK (kwkclwhmoygunqmlegrg).
//
// Dado (source, cuit, fecha): junta las facturas de esa fuente para ese cliente/día,
// combina los PDFs en uno, calcula el total, y deja el registro en wa_factura_consolidada.
// NO envía nada. Si el mismo cliente/día aparece en LK y Chef → estado 'held_multisource'.
//
// POST { source?='lk', cuit, fecha }
//   -> { ok, estado, n_facturas, total_sum, comprobantes, pdf_signed_url, cliente }

const SOURCES: Record<string, { schema: string; bucket: string }> = {
  lk: { schema: "isis_lk", bucket: "isis-lk" },
  ch: { schema: "isis_ch", bucket: "isis-ch" },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const paginalk = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function getSetting(key: string): Promise<string | null> {
  const { data } = await paginalk.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

let _isisUrl = "", _isisKey = "";
async function isisCreds() {
  if (!_isisUrl || !_isisKey) {
    _isisUrl = Deno.env.get("ISIS_SUPABASE_URL") ?? (await getSetting("isis_supabase_url")) ?? "";
    _isisKey = Deno.env.get("ISIS_SUPABASE_SERVICE_KEY") ?? (await getSetting("isis_supabase_service_key")) ?? "";
    if (!_isisUrl || !_isisKey) throw new Error("Credenciales ISIS (GP) no configuradas");
  }
  return { url: _isisUrl, key: _isisKey };
}
// Cliente GP ligado a un schema específico (como getIsisClient). Sin schema = para storage.
async function gpClient(schema?: string) {
  const { url, key } = await isisCreds();
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(schema ? { db: { schema } } : {}),
  });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Formato moneda AR: 683480.25 -> "$683.480" (redondeado, miles con punto, sin decimales)
function fmtARS(n: number): string {
  const r = Math.round(n);
  return "$" + r.toLocaleString("es-AR");
}

// Lee facturas vía RPC public.wa_factura_grupo (los schemas isis_* no están
// expuestos en PostgREST; el RPC es SECURITY DEFINER y los alcanza).
// deno-lint-ignore no-explicit-any
async function facturasDe(gp: any, schema: string, cuit: string, fecha: string) {
  const { data, error } = await gp.rpc("wa_factura_grupo", {
    p_schema: schema, p_cuit: cuit, p_fecha: fecha,
  });
  if (error) throw new Error(`query ${schema}: ${error.message}`);
  return data ?? [];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const source = (body.source as string) || "lk";
    const cuit = body.cuit as string;
    const fecha = body.fecha as string;

    if (!SOURCES[source]) return json({ error: `source inválida: ${source}` }, 400);
    if (!cuit || !fecha) return json({ error: "cuit y fecha requeridos" }, 400);

    const { schema, bucket } = SOURCES[source];
    const gp = await gpClient();   // cliente GP (public): rpc + storage

    // 1. Facturas de esta fuente
    const facturas = await facturasDe(gp, schema, cuit, fecha);
    if (!facturas.length) return json({ error: "sin facturas para ese cliente/día en " + source }, 404);

    // 2. Chequeo multi-fuente (LK + Chef mismo cliente/día → suspenso)
    let multisource = false;
    for (const other of Object.keys(SOURCES)) {
      if (other === source) continue;
      try {
        const otras = await facturasDe(gp, SOURCES[other].schema, cuit, fecha);
        if (otras.length) multisource = true;
      } catch { /* schema puede no existir/estar vacío */ }
    }

    // 3. Datos consolidados
    // deno-lint-ignore no-explicit-any
    const total_sum = facturas.reduce((s: number, f: any) => s + Number(f.total || 0), 0);
    // deno-lint-ignore no-explicit-any
    const comprobantes = facturas.map((f: any) => f.comprobante_id);
    // deno-lint-ignore no-explicit-any
    const factura_ids = facturas.map((f: any) => f.id);
    // deno-lint-ignore no-explicit-any
    const nombre = facturas[0]?.contraparte_nombre ?? null;

    // 4. Cliente en PaginaLK (por CUIT normalizado) → teléfono
    const cuitDigits = cuit.replace(/[^0-9]/g, "");
    const { data: custs } = await paginalk.from("customers")
      .select("cod_cliente, business_name, whatsapp, cuit").limit(500);
    // deno-lint-ignore no-explicit-any
    const cust = (custs ?? []).find((c: any) => (c.cuit ?? "").replace(/[^0-9]/g, "") === cuitDigits) ?? null;

    // 5. Combinar PDFs (documento nuevo; originales intactos)
    const merged = await PDFDocument.create();
    const errores: { path: string; error: string }[] = [];
    for (const f of facturas) {
      const { data, error } = await gp.storage.from(bucket).download(f.storage_path);
      if (error || !data) { errores.push({ path: f.storage_path, error: error?.message ?? "download" }); continue; }
      try {
        const bytes = new Uint8Array(await data.arrayBuffer());
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      } catch (e) { errores.push({ path: f.storage_path, error: e instanceof Error ? e.message : String(e) }); }
    }
    if (merged.getPageCount() === 0) return json({ error: "no se pudo combinar ningún PDF", errores }, 502);

    const outBytes = await merged.save();
    const out_path = `combinadas/${source}_${cuitDigits}_${fecha}.pdf`;
    const up = await gp.storage.from(bucket).upload(out_path, outBytes, { contentType: "application/pdf", upsert: true });
    if (up.error) return json({ error: "upload: " + up.error.message }, 500);
    const signed = await gp.storage.from(bucket).createSignedUrl(out_path, 60 * 60 * 24 * 7);
    const pdf_signed_url = signed.data?.signedUrl ?? null;

    // Candado de calidad: solo confiable si TODAS las facturas parsearon bien.
    // deno-lint-ignore no-explicit-any
    const confiable = facturas.every((f: any) =>
      (f.confianza ?? "alta") === "alta" && f.totales_ok !== false);

    const estado = multisource ? "held_multisource" : (confiable ? "complete" : "held_revision");

    // Plan del mensaje: qué plantilla, qué params, qué documento (header). NO se envía acá.
    // Escala de descuentos (config: wa_descuentos_escala). Orden fijo del cuerpo de la plantilla:
    //   crédito: contado 25%, 15-30d 20%, 31-45d 15%, 46-60d 10%  |  e-cheq: 90d 5%, 120d 0%
    let escala = [0.25, 0.20, 0.15, 0.10, 0.05, 0.00];
    try {
      const cfg = await getSetting("wa_descuentos_escala");
      if (cfg) { const arr = JSON.parse(cfg); if (Array.isArray(arr) && arr.length === 6) escala = arr.map(Number); }
    } catch { /* usa default */ }
    const montos = escala.map((d) => total_sum * (1 - d));        // montos por tramo
    const montosFmt = montos.map((m) => fmtARS(m));

    const tplUnica = (await getSetting("wa_tpl_factura_unica")) || "pedido_armado_factura_unica";
    const tplMultiple = (await getSetting("wa_tpl_facturas_multiples")) || "pedido_armado_facturas_multiples";
    const esMultiple = facturas.length > 1;
    const mensaje = {
      // n_facturas == 1 -> plantilla única (header = PDF de 1 página)
      // n_facturas  > 1 -> plantilla múltiple (header = PDF combinado)
      template: esMultiple ? tplMultiple : tplUnica,
      language: "es_AR",
      // Params posicionales:
      //   única:    {{1}} total, {{2..7}} montos escala (contado,20,15,10,5,0)
      //   múltiple: {{1}} total, {{2}} cantidad, {{3..8}} montos escala
      params: esMultiple
        ? [fmtARS(total_sum), String(facturas.length), ...montosFmt]
        : [fmtARS(total_sum), ...montosFmt],
      document: { link: pdf_signed_url, filename: `factura_${cuitDigits}_${fecha}.pdf` },
      total_fmt: fmtARS(total_sum),
      // desglose legible de la escala
      descuentos: escala.map((d, i) => ({ off: `${Math.round(d * 100)}%`, monto: montosFmt[i] })),
      to: cust?.whatsapp ?? null,
    };

    // 6. Registrar en wa_factura_consolidada (idempotente por source+cuit+fecha). NO envía.
    const { error: upErr } = await paginalk.from("wa_factura_consolidada").upsert({
      source, cuit, cod_cliente: cust?.cod_cliente ?? null,
      business_name: cust?.business_name ?? nombre,
      fecha, factura_ids, comprobantes, n_facturas: facturas.length,
      total_sum, pdf_path: `${bucket}/${out_path}`, estado,
      detalle: {
        pages: merged.getPageCount(),
        errores: errores.length ? errores : undefined,
        whatsapp: cust?.whatsapp ?? null,
        pdf_signed_url,
        confiable,
        mensaje,
        generated_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "source,cuit,fecha" });
    if (upErr) return json({ error: "upsert consolidada: " + upErr.message }, 500);

    return json({
      ok: true,
      estado,
      source,
      cuit,
      fecha,
      n_facturas: facturas.length,
      total_sum,
      comprobantes,
      pages: merged.getPageCount(),
      pdf_path: `${bucket}/${out_path}`,
      pdf_signed_url,
      confiable,
      mensaje,
      cliente: cust ? { cod_cliente: cust.cod_cliente, business_name: cust.business_name, whatsapp: cust.whatsapp } : { business_name: nombre, matched: false },
      nota: "SIN ENVÍO (etapa consolidación). El plan de mensaje queda listo para el sender.",
    });
  } catch (err) {
    console.error("lk_factura-consolidar error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
