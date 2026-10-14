// lk_etiquetar-productos — Fase B (Pablo, 14/10/2026): etiqueta los atributos VISUALES del catálogo.
//
// Para cada producto activo con foto, baja la imagen del bucket products-images, se la pasa al modelo de
// visión (wa_vision_modelo, Gemini free = US$0) y guarda color/material/forma en wa_producto_atributos
// (sql/152). El tool buscar_productos del agente filtra con eso ("el pelapapas de mango rojo").
//
// Es un backfill idempotente y resumible: por defecto sólo toma los que FALTAN (no están en la tabla), de
// a `limit` por llamada, para respetar la cuota del plan gratis de Gemini (15 por minuto). Se llama en
// tandas hasta que `restantes` sea 0. No le habla a nadie por WhatsApp (no importa wa-guard).
//
// Gate: secreto interno x-lk-secret (env o Vault), igual que lk_templates. Falla cerrada.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { supabase, getSetting } from "../_shared/supabase.ts";
import { extraerAtributosProducto } from "../_shared/vision-producto.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lk-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SECRET_NAME = "LK_FN_CRON_SECRET";
async function esLlamadaInterna(req: Request): Promise<boolean> {
  const recibido = req.headers.get("x-lk-secret") ?? "";
  if (!recibido) return false;
  let esperado = Deno.env.get(SECRET_NAME) ?? "";
  if (!esperado) {
    const { data } = await supabase.rpc("krikos_secret", { p_name: SECRET_NAME });
    esperado = typeof data === "string" ? data : "";
  }
  return esperado.length > 0 && recibido === esperado;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await esLlamadaInterna(req))) return json({ error: "no_autorizado" }, 401);

  let body: { limit?: number; soloFaltantes?: boolean; cods?: string[] } = {};
  try { body = await req.json(); } catch { /* body vacío */ }

  const modeloId = ((await getSetting("wa_vision_modelo")) || "").split(",")[0].trim();
  if (!modeloId) return json({ error: "wa_vision_modelo no seteado: la visión está dormida" }, 400);

  const limit = Math.min(Math.max(Number(body.limit ?? 10) || 10, 1), 30);
  const soloFaltantes = body.soloFaltantes !== false; // default true

  // 1) Elegir los cods a procesar
  let objetivos: string[];
  if (Array.isArray(body.cods) && body.cods.length) {
    const { data } = await supabase.from("products").select("cod").eq("active", true).in("cod", body.cods.map(String));
    objetivos = (data ?? []).map((r) => String(r.cod));
  } else {
    const { data: act } = await supabase.from("products").select("cod").eq("active", true);
    let cods = (act ?? []).map((r) => String(r.cod));
    if (soloFaltantes) {
      const { data: ya } = await supabase.from("wa_producto_atributos").select("cod");
      const tienen = new Set((ya ?? []).map((r) => String(r.cod)));
      cods = cods.filter((c) => !tienen.has(c));
    }
    cods.sort();
    objetivos = cods;
  }

  const restantesAntes = objetivos.length;
  const tanda = objetivos.slice(0, limit);

  let etiquetados = 0;
  const saltados: Array<{ cod: string; motivo: string }> = [];

  for (const cod of tanda) {
    try {
      const { data: img } = await supabase.rpc("bot_obtener_imagenes_producto", { p_cod: cod });
      const url = (img?.[0]?.image_urls ?? [])[0] as string | undefined;
      if (!url) { saltados.push({ cod, motivo: "sin_imagen" }); continue; }

      const r = await fetch(url);
      if (!r.ok) { saltados.push({ cod, motivo: `descarga_${r.status}` }); continue; }
      const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      const bytes = new Uint8Array(await r.arrayBuffer());

      const atr = await extraerAtributosProducto(bytes, mime);
      if (!atr || !atr.texto) { saltados.push({ cod, motivo: "sin_atributos" }); continue; }

      const { error } = await supabase.from("wa_producto_atributos").upsert({
        cod, atributos_texto: atr.texto, datos: atr.datos, modelo: modeloId, actualizado_at: new Date().toISOString(),
      }, { onConflict: "cod" });
      if (error) { saltados.push({ cod, motivo: "upsert:" + error.message }); continue; }
      etiquetados++;
    } catch (e) {
      saltados.push({ cod, motivo: e instanceof Error ? e.message.slice(0, 80) : "error" });
    }
    await new Promise((res) => setTimeout(res, 300)); // suaviza la ráfaga (cuota 15/min del plan gratis)
  }

  return json({
    modelo: modeloId,
    procesados: tanda.length,
    etiquetados,
    saltados,
    restantes: Math.max(0, restantesAntes - tanda.length),
  });
});
