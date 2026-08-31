import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// lk_notif-sim — DRIVER del simulador end-to-end (PaginaLK).
//
// Siembra el recorrido REAL scopeado a prueba y lo empuja por el pipeline real:
//   sim_new    → pedido en la PPP (PPP_Programacion_Diaria + snapshot) vía RPC ISIS.
//   sim_emit   → factura una NP (Facturacion_NP → trigger real de grupo completo) y sube
//                la factura (PDF REAL de prueba) al bucket + isis_*.documentos (RPC); luego
//                llama lk_factura-check (endpoint real) que, si el grupo está completo, arma
//                el mensaje, COMBINA los PDFs de verdad y ENTREGA (módulo o WhatsApp).
//   fuego_run  → "Prueba de fuego": crea el pedido con un teléfono destino (dest_phone),
//                emite TODAS sus NPs de una y dispara la entrega automática a ese número.
//   sim_state  → estado del recorrido + mensaje entregado.
//   sim_reset  → borra TODO lo de prueba (PPP, Facturacion_NP, documentos, snapshot,
//                grupo_listo, PDFs, inbox). Nada real se toca (cuit 30999… / cod 99999).
//   contact_*  → gestión de la lista blanca de números (wa_envio_contactos). El bot SÓLO
//                puede enviar a números de esta lista. Lista vacía = no envía a nadie.
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

// ── Normalización de teléfono AR → formato WhatsApp canónico (549 + área + número) ──
// Ej: "+54 9 11 6864-8618" / "011 15 6864 8618" / "1168648618" → "5491168648618".
function normalizeAR(raw: string): { phone: string | null; note: string } {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return { phone: null, note: "vacío" };
  if (d.startsWith("00")) d = d.slice(2);          // salida internacional
  if (d.startsWith("549")) return { phone: d, note: "ya canónico" };
  if (d.startsWith("54")) d = d.slice(2);          // país sin el 9 de móvil
  if (d.startsWith("0")) d = d.slice(1);           // 0 de larga distancia
  // Quitar el "15" de móvil local que va DESPUÉS del código de área (área 2/3/4 dígitos).
  if (d.length === 12) {
    for (const k of [2, 3, 4]) { if (d.slice(k, k + 2) === "15") { d = d.slice(0, k) + d.slice(k + 2); break; } }
  }
  if (d.length < 8) return { phone: null, note: "muy corto" };
  return { phone: "549" + d, note: "normalizado" };
}

function today(): string { return new Date().toISOString().slice(0, 10); }
function nuevoCuit(): string { return "30999" + String(randInt(0, 999999)).padStart(6, "0"); }

// ── PDF de prueba REAL (válido) por factura — para que la combinación se pruebe de verdad ──
async function makeFacturaPdf(numero: string, total: number, cond: string, cuit: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 260]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const draw = (t: string, x: number, y: number, size = 11, f = font, c = rgb(0.1, 0.1, 0.12)) =>
    page.drawText(t, { x, y, size, font: f, color: c });
  page.drawRectangle({ x: 0, y: 226, width: 420, height: 34, color: rgb(0.36, 0.13, 0.71) });
  // Sólo ASCII/WinAnsi en drawText (Helvetica no codifica em-dash ni fuera de Latin-1).
  draw("FACTURA (SIMULACION)", 18, 236, 14, bold, rgb(1, 1, 1));
  draw(`Comprobante: FC-A-0004-${numero}`, 18, 196, 11, bold);
  draw(`Cliente: CLIENTE SIMULACION`, 18, 174);
  draw(`CUIT: ${cuit}`, 18, 156);
  draw(`Condicion: ${cond}`, 18, 138);
  draw(`Fecha: ${today()}`, 18, 120);
  draw(`Total (con IVA): ${fmtARS(total)}`, 18, 92, 13, bold, rgb(0.36, 0.13, 0.71));
  draw("Documento de prueba - se elimina al finalizar el test.", 18, 40, 9, font, rgb(0.5, 0.5, 0.55));
  return await doc.save();
}

async function callCheck(source: string, cuit: string, fecha: string) {
  try {
    const res = await fetch(`${SB_URL}/functions/v1/lk_factura-check`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, cuit, fecha }),
    });
    return await res.json();
  } catch (e) { return { error: String(e) }; }
}

// Emite UNA NP del pedido (factura NP + PDF real + documento) y llama a lk_factura-check.
// deno-lint-ignore no-explicit-any
async function emitOne(g: any, ctrl: any) {
  const cuit = ctrl.cuit as string;
  const source = ctrl.source || "lk";
  const schema = source === "ch" ? "isis_ch" : "isis_lk";
  const { data: prev } = await g.rpc("wa_factura_grupo", { p_schema: schema, p_cuit: cuit, p_fecha: ctrl.fecha });
  const idx = (prev ?? []).length;
  if (idx >= ctrl.np_esperados) return { done: true, faltan: 0, disparo: false, note: "pedido ya facturado" };

  const np = (ctrl.np_list ?? [])[idx] ?? ("9990" + cuit.slice(5) + (idx + 1));
  const { error: fErr } = await g.rpc("wa_sim_factura_np", { p_cuit: cuit, p_np: np });
  if (fErr) throw new Error("factura_np: " + fErr.message);

  const numero = (cuit.slice(5) + (idx + 1)).padStart(8, "0");
  const path = `sim/${cuit}/${numero}.pdf`;
  const total = randInt(150000, 1800000) + Math.random();
  const subt = Math.round((total / 1.21) * 100) / 100;
  const cond = COND[ctrl.metodo] ?? "Contado";
  const pdf = await makeFacturaPdf(numero, total, cond, cuit);
  const up = await g.storage.from(bucketDe(source)).upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (up.error) throw new Error("upload PDF: " + up.error.message);

  const { data: comp, error: dErr } = await g.rpc("wa_sim_insert_documento", {
    p_source: source, p_cuit: cuit, p_fecha: ctrl.fecha, p_numero: numero, p_total: total, p_subt: subt,
    p_condicion: cond, p_nombre: "CLIENTE SIMULACIÓN", p_storage_path: path,
  });
  if (dErr) throw new Error("insert documento: " + dErr.message);

  const check = await callCheck(source, cuit, ctrl.fecha);
  const nNow = idx + 1;
  return {
    done: false, np, source,
    emitted: { comprobante: comp ?? `FC-A-0004-${numero}`, total, total_fmt: fmtARS(total) },
    faltan: Math.max(0, ctrl.np_esperados - nNow),
    disparo: !!(check && (check.delivered || check.already)),
    check,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    // ── Gestión de contactos (lista blanca) — no requiere ISIS ──
    if (action === "contact_list") {
      const { data } = await paginalk.from("wa_envio_contactos").select("*").order("created_at", { ascending: true });
      return json({ items: data ?? [] });
    }
    if (action === "contact_preview") {
      const r = normalizeAR(String(body.phone ?? ""));
      return json(r);
    }
    if (action === "contact_add") {
      const r = normalizeAR(String(body.phone ?? ""));
      if (!r.phone) return json({ error: "Teléfono inválido: " + r.note }, 400);
      const label = (String(body.label ?? "").trim() || null);
      const { error } = await paginalk.from("wa_envio_contactos").upsert({ phone: r.phone, label }, { onConflict: "phone" });
      if (error) return json({ error: error.message }, 500);
      const { data } = await paginalk.from("wa_envio_contactos").select("*").order("created_at", { ascending: true });
      return json({ ok: true, phone: r.phone, note: r.note, items: data ?? [] });
    }
    if (action === "contact_remove") {
      let q = paginalk.from("wa_envio_contactos").delete();
      if (body.id) q = q.eq("id", body.id); else if (body.phone) q = q.eq("phone", String(body.phone)); else return json({ error: "id o phone requerido" }, 400);
      const { error } = await q;
      if (error) return json({ error: error.message }, 500);
      const { data } = await paginalk.from("wa_envio_contactos").select("*").order("created_at", { ascending: true });
      return json({ ok: true, items: data ?? [] });
    }

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

    // ── sim_emit: factura una NP → dispara pipeline real → check entrega ──
    if (action === "sim_emit") {
      const cuit = String(body.cuit ?? "");
      if (!cuit) return json({ error: "cuit requerido" }, 400);
      const { data: ctrl } = await g.from("wa_sim_control").select("*").eq("cuit", cuit).eq("fecha", today()).maybeSingle();
      if (!ctrl) return json({ error: "pedido no encontrado" }, 404);
      const r = await emitOne(g, ctrl);
      if (r.done) return json({ ok: true, note: r.note, faltan: 0, disparo: false });
      return json({ ok: true, ...r });
    }

    // ── fuego_run: Prueba de fuego — pedido + emite TODO + entrega automática al número ──
    if (action === "fuego_run") {
      const metodo = (typeof body.metodo === "string" && METODOS.includes(body.metodo)) ? body.metodo : pick(METODOS);
      const np = Number.isInteger(body.np_esperados) && body.np_esperados >= 1 && body.np_esperados <= 6 ? body.np_esperados : 1;
      const source = body.source === "ch" ? "ch" : "lk";
      const dest = normalizeAR(String(body.dest_phone ?? ""));
      if (!dest.phone) return json({ error: "Seleccioná un número destino válido" }, 400);
      // El número DEBE estar en la lista blanca (defensa; el envío real re-valida en el check).
      const { data: wl } = await paginalk.from("wa_envio_contactos").select("phone").eq("phone", dest.phone).maybeSingle();
      if (!wl) return json({ error: "El número no está en la lista de contactos autorizados" }, 403);

      const cuit = nuevoCuit();
      const { error: seErr } = await g.rpc("wa_sim_seed_order", { p_cuit: cuit, p_np_esperados: np, p_metodo: metodo, p_source: source, p_dest_phone: dest.phone });
      if (seErr) return json({ error: "seed: " + seErr.message }, 500);

      const emits = [];
      let lastCheck = null;
      for (let i = 0; i < np; i++) {
        const { data: ctrl } = await g.from("wa_sim_control").select("*").eq("cuit", cuit).eq("fecha", today()).maybeSingle();
        const r = await emitOne(g, ctrl);
        emits.push({ np: r.np, emitted: r.emitted, disparo: r.disparo, faltan: r.faltan });
        if (r.check) lastCheck = r.check;
      }
      return json({ ok: true, cuit, fecha: today(), metodo, source, np_esperados: np, dest_phone: dest.phone, emits, check: lastCheck });
    }

    // ── real_sweep: enviar los pedidos REALES completos de hoy al número de redirección (Thomy) ──
    if (action === "real_sweep") {
      const { data: groups } = await g.rpc("wa_envio_grupos_pendientes");
      const results = [];
      for (const gr of (groups ?? [])) {
        let r;
        try {
          const res = await fetch(`${SB_URL}/functions/v1/lk_factura-check`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "grupo", ...gr }),
          });
          r = await res.json();
        } catch (e) { r = { error: String(e) }; }
        results.push({ group_key: gr.group_key, cod_cliente: gr.cod_cliente, dia: gr.dia, n_facturas: gr.n_facturas, metodos: gr.metodos, ...r });
      }
      const est = (r: Record<string, unknown>) => String(r.estado || r.skipped || (r.error ? "error" : "")) ;
      const summary = {
        total: results.length,
        enviados: results.filter((r) => est(r) === "sent_whatsapp").length,
        retenidos: results.filter((r) => est(r).startsWith("held")).length,
        ya_enviados: results.filter((r) => est(r) === "ya_enviado").length,
        errores: results.filter((r) => est(r) === "error" || est(r) === "error_envio").length,
      };
      return json({ ok: true, summary, results });
    }

    // ── dashboard: métricas del pipeline por día (±3) + feed de eventos ──
    if (action === "dashboard") {
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const base = new Date();
      const desde = new Date(base); desde.setDate(base.getDate() - 3);
      const hasta = new Date(base); hasta.setDate(base.getDate() + 3);
      const { data: rango } = await g.rpc("wa_dashboard_rango", { p_desde: iso(desde), p_hasta: iso(hasta) });
      const { data: log } = await g.rpc("wa_pipeline_log_reciente", { p_limit: 40 });
      return json({ rango: rango ?? [], log: log ?? [], hoy: today() });
    }

    // ── sim_state: recorrido de cada pedido + mensaje entregado ──
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
          np_esperados: c.np_esperados, np_facturados: facturas.length, dest_phone: c.dest_phone || null,
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
      const list = ((paths ?? []) as string[]).slice();
      // También los PDFs combinados generados por lk_factura-check (sim/<cuit>/combinada_*.pdf).
      const combos = new Set<string>();
      for (const p of list) { const m = p.match(/^sim\/(30999\d+)\//); if (m) combos.add(`sim/${m[1]}/combinada_${today()}.pdf`); }
      const all = list.concat(Array.from(combos));
      if (all.length) {
        for (const b of ["isis-lk", "isis-ch"]) { try { await g.storage.from(b).remove(all); } catch (_e) { /* ignore */ } }
      }
      const { data: n } = await g.rpc("wa_sim_cleanup_all");
      await paginalk.from("wa_sim_inbox").delete().like("cuit", "30999%");
      return json({ ok: true, docs: n ?? 0, pdfs: all.length });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_notif-sim error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
