import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// lk_notif-sim — DRIVER del simulador end-to-end (PaginaLK).
//
// Siembra el recorrido REAL scopeado a prueba y lo empuja por el pipeline real:
//   sim_new   → pedido en la PPP (PPP_Programacion_Diaria + snapshot) vía RPC ISIS.
//   sim_emit  → factura una NP (Facturacion_NP → trigger real de grupo completo) y sube
//               la factura al bucket + isis_*.documentos (RPC); luego llama lk_factura-check
//               (el endpoint real) que, si el grupo está completo, arma el mensaje y lo
//               ENTREGA al módulo (wa_sim_inbox) — NO a WhatsApp.
//   sim_state → estado del recorrido + mensaje entregado.
//   sim_reset → borra TODO lo de prueba (PPP, Facturacion_NP, documentos, snapshot,
//               grupo_listo, PDFs, inbox). Nada real se toca (cuit 30999… / cod 99999).
// verify_jwt=false.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const paginalk = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
async function getSetting(key: string): Promise<string | null> {
  const { data } = await paginalk.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
let _isisUrl = "", _isisKey = "";
// deno-lint-ignore no-explicit-any
let _gp: any = null;
async function gp() {
  if (!_gp) {
    _isisUrl = Deno.env.get("ISIS_SUPABASE_URL") ?? (await getSetting("isis_supabase_url")) ?? "";
    _isisKey = Deno.env.get("ISIS_SUPABASE_SERVICE_KEY") ?? (await getSetting("isis_supabase_service_key")) ?? "";
    if (!_isisUrl || !_isisKey) throw new Error("Credenciales ISIS no configuradas");
    _gp = createClient(_isisUrl, _isisKey, { auth: { autoRefreshToken: false, persistSession: false } });
  }
  return _gp;
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function fmtARS(n: number): string {
  return "$" + Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function randInt(a: number, b: number): number { return Math.floor(a + Math.random() * (b - a + 1)); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

const METODOS = ["contado", "credito_15_30", "credito_31_45", "credito_46_60", "echeq_90", "echeq_120"];
const COND: Record<string, string> = {
  contado: "Contado", credito_15_30: "Crédito 15 a 30 días", credito_31_45: "Crédito 31 a 45 días",
  credito_46_60: "Crédito 46 a 60 días", echeq_90: "E-cheq 90 días", echeq_120: "E-cheq 120 días", no_decidido: "Contado",
};
function bucketDe(source: string) { return source === "ch" ? "isis-ch" : "isis-lk"; }
const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 150]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

function today(): string { return new Date().toISOString().slice(0, 10); }
function nuevoCuit(): string { return "30999" + String(randInt(0, 999999)).padStart(6, "0"); }

async function callCheck(source: string, cuit: string, fecha: string) {
  // Llama al endpoint real lk_factura-check (idempotente con el trigger).
  try {
    const res = await fetch(`${SB_URL}/functions/v1/lk_factura-check`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, cuit, fecha }),
    });
    return await res.json();
  } catch (e) { return { error: String(e) }; }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;
    const g = await gp();

    // ── sim_new: pedido de prueba en la PPP (recorrido arranca) ──
    if (action === "sim_new") {
      const metodo = (typeof body.metodo === "string" && METODOS.includes(body.metodo)) ? body.metodo : pick(METODOS);
      const np = Number.isInteger(body.np_esperados) && body.np_esperados >= 1 && body.np_esperados <= 6 ? body.np_esperados : randInt(1, 3);
      const source = body.source === "ch" ? "ch" : "lk";
      const cuit = nuevoCuit();
      const { data, error } = await g.rpc("wa_sim_seed_order", { p_cuit: cuit, p_np_esperados: np, p_metodo: metodo, p_source: source });
      if (error) return json({ error: "seed: " + error.message }, 500);
      return json({ ok: true, sim: { cuit, fecha: today(), np_esperados: np, np_facturados: 0, metodo, source, business_name: "CLIENTE SIMULACIÓN", nps: data?.nps ?? [] } });
    }

    // ── sim_emit: factura una NP → dispara pipeline real → check entrega al módulo ──
    if (action === "sim_emit") {
      const cuit = String(body.cuit ?? "");
      if (!cuit) return json({ error: "cuit requerido" }, 400);
      const { data: ctrl } = await g.from("wa_sim_control").select("*").eq("cuit", cuit).eq("fecha", today()).maybeSingle();
      if (!ctrl) return json({ error: "pedido no encontrado" }, 404);
      const source = ctrl.source || "lk";
      const { data: prev } = await g.rpc("wa_factura_grupo", { p_schema: source === "ch" ? "isis_ch" : "isis_lk", p_cuit: cuit, p_fecha: ctrl.fecha });
      const idx = (prev ?? []).length;
      if (idx >= ctrl.np_esperados) return json({ ok: true, note: "pedido ya facturado", faltan: 0, disparo: false });

      const np = (ctrl.np_list ?? [])[idx] ?? ("9990" + cuit.slice(5) + (idx + 1));
      // 1) NP facturada (Facturacion_NP) → dispara trigger real de grupo completo
      const { error: fErr } = await g.rpc("wa_sim_factura_np", { p_cuit: cuit, p_np: np });
      if (fErr) return json({ error: "factura_np: " + fErr.message }, 500);

      // 2) PDF al bucket + documento parseado (isis_*.documentos)
      // numero ÚNICO por pedido (deriva del CUIT) → comprobante_id no colisiona entre pedidos.
      const numero = (cuit.slice(5) + (idx + 1)).padStart(8, "0");
      const path = `sim/${cuit}/${numero}.pdf`;
      const up = await g.storage.from(bucketDe(source)).upload(path, PDF_BYTES, { contentType: "application/pdf", upsert: true });
      if (up.error) return json({ error: "upload PDF: " + up.error.message }, 500);
      const total = randInt(150000, 1800000) + Math.random();
      const subt = Math.round((total / 1.21) * 100) / 100;
      const { data: comp, error: dErr } = await g.rpc("wa_sim_insert_documento", {
        p_source: source, p_cuit: cuit, p_fecha: ctrl.fecha, p_numero: numero, p_total: total, p_subt: subt,
        p_condicion: COND[ctrl.metodo] ?? "Contado", p_nombre: "CLIENTE SIMULACIÓN", p_storage_path: path,
      });
      if (dErr) return json({ error: "insert documento: " + dErr.message }, 500);

      // 3) Etapa 5 real: check completitud → consolidar → entregar al módulo
      const check = await callCheck(source, cuit, ctrl.fecha);
      const nNow = idx + 1;
      return json({
        ok: true, np, source,
        emitted: { comprobante: comp ?? `FC-A-0004-${numero}`, total, total_fmt: fmtARS(total) },
        faltan: Math.max(0, ctrl.np_esperados - nNow),
        disparo: !!(check && (check.delivered || check.already)),
        check,
      });
    }

    // ── sim_state: recorrido de cada pedido + mensaje entregado al módulo ──
    if (action === "sim_state") {
      const { data: controls } = await g.from("wa_sim_control").select("*").eq("fecha", today()).order("created_at", { ascending: false }).limit(30);
      const out = [];
      for (const c of (controls ?? [])) {
        const schema = c.source === "ch" ? "isis_ch" : "isis_lk";
        const { data: fs } = await g.rpc("wa_factura_grupo", { p_schema: schema, p_cuit: c.cuit, p_fecha: c.fecha });
        const facturas = fs ?? [];
        const destino = ("SIM-" + c.cuit).toUpperCase();
        const grupoKey = `${c.cod_cliente}|${destino}|${c.fecha}`;
        const { data: grupo } = await g.from("wa_grupo_listo").select("*").eq("grupo_key", grupoKey).maybeSingle();
        const { data: inbox } = await paginalk.from("wa_sim_inbox").select("*").eq("grupo_key", grupoKey).order("created_at", { ascending: false }).limit(1).maybeSingle();
        out.push({
          cuit: c.cuit, fecha: c.fecha, business_name: c.business_name, metodo: c.metodo, source: c.source,
          np_esperados: c.np_esperados, np_facturados: facturas.length,
          comprobantes: facturas.map((f: Record<string, unknown>) => f.comprobante_id),
          totales: facturas.map((f: Record<string, unknown>) => Number(f.total || 0)),
          grupo_completo: !!grupo, aviso: inbox || null, created_at: c.created_at,
        });
      }
      return json({ items: out });
    }

    // ── sim_reset: limpieza total (PDFs + filas de prueba en ISIS + inbox en PaginaLK) ──
    if (action === "sim_reset") {
      const { data: paths } = await g.rpc("wa_sim_paths");
      const list = (paths ?? []) as string[];
      if (list.length) {
        for (const b of ["isis-lk", "isis-ch"]) { try { await g.storage.from(b).remove(list); } catch (_e) { /* ignore */ } }
      }
      const { data: n } = await g.rpc("wa_sim_cleanup_all");
      await paginalk.from("wa_sim_inbox").delete().like("cuit", "30999%");
      return json({ ok: true, docs: n ?? 0, pdfs: list.length });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_notif-sim error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
