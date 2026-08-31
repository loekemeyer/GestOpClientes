import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// lk_notif-sim — Simulador END-TO-END del aviso proactivo por facturación.
//
// Ejercita el pipeline REAL sin tocar datos reales:
//   1) sim_emit sube un PDF de prueba al bucket `isis-lk` e inserta una factura de
//      prueba en `isis_lk.documentos` (proyecto ISIS), marcada datos->>'_sim'='1'.
//   2) El trigger REAL `wa_sim_documentos_trg` (gateado SOLO a filas de prueba) detecta
//      cuando impactaron TODAS las facturas del grupo y encola el aviso en wa_sim_avisos.
//   3) sim_state lee esa cola y arma el mensaje consolidado (misma lógica que
//      lk_factura-consolidar / docs/plantillas_whatsapp.md). NO envía WhatsApp.
//
// Aislación: CUIT ficticio (30999…) + marcador datos._sim. Ningún documento real lo tiene.
// sim_reset borra filas y PDFs de prueba. verify_jwt=false (anon key desde el dashboard).

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
    if (!_isisUrl || !_isisKey) throw new Error("Credenciales ISIS no configuradas");
  }
  return { url: _isisUrl, key: _isisKey };
}
// deno-lint-ignore no-explicit-any
let _gpPub: any = null;
async function gpPub() {
  if (!_gpPub) { const { url, key } = await isisCreds(); _gpPub = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }); }
  return _gpPub;
}

const BUCKET = "isis-lk";
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function fmtARS(n: number): string {
  return "$" + Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function randInt(a: number, b: number): number { return Math.floor(a + Math.random() * (b - a + 1)); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Lógica de descuento/plantilla — espejo de lk_factura-consolidar y de la guía ──
const DTO_DEFAULT: Record<string, number> = {
  contado: 0.25, credito_15_30: 0.20, credito_31_45: 0.15,
  credito_46_60: 0.10, echeq_90: 0.05, echeq_120: 0.00, no_decidido: 0.25,
};
const PLAZO: Record<string, string> = { credito_15_30: "15 a 30", credito_31_45: "31 a 45", credito_46_60: "46 a 60" };
const METODOS = ["contado", "credito_15_30", "credito_31_45", "credito_46_60", "echeq_90", "echeq_120"];
// metodo → condicion_venta (reverso de wa_metodo_norm en ISIS)
const COND: Record<string, string> = {
  contado: "Contado", credito_15_30: "Crédito 15 a 30 días", credito_31_45: "Crédito 31 a 45 días",
  credito_46_60: "Crédito 46 a 60 días", echeq_90: "E-cheq 90 días", echeq_120: "E-cheq 120 días", no_decidido: "Contado",
};
const TPL: Record<string, { single: string; multi: string }> = {
  contado: { single: "pedido_contado_s", multi: "pedido_contado_p" },
  credito: { single: "pedido_credito_s", multi: "pedido_credito_p" },
  echeq:   { single: "pedido_echeq_s",   multi: "pedido_echeq_p" },
};
function grupoDe(m: string): "contado" | "credito" | "echeq" {
  if (m.startsWith("credito")) return "credito";
  if (m.startsWith("echeq")) return "echeq";
  return "contado";
}

const PAGO_FOOTER = ["", "Datos para el pago:", "Alias: loeke.srl", "CBU: 1910027855002702387450"].join("\n");
const SALUDO = "¡Hola! Tu pedido está listo y estará con vos a la brevedad.";

// Texto EXACTO de las plantillas (docs/plantillas_whatsapp.md).
function textoLegible(grupo: string, esMultiple: boolean, params: string[]): string {
  let cuerpo: string[];
  if (!esMultiple) {
    if (grupo === "contado") {
      cuerpo = [SALUDO, "", `Total de tu factura (con IVA): ${params[0]}`, "", `Pagando al contado (25% de descuento) abonás: ${params[1]}`];
    } else if (grupo === "credito") {
      cuerpo = [SALUDO, "", `Total de tu factura (con IVA): ${params[0]}`, "", `Con tu pago a ${params[1]} días abonás: ${params[2]}`, "", `Pagando al contado ahorrarías ${params[3]}.`];
    } else {
      cuerpo = [SALUDO, "", `Total de tu factura (con IVA): ${params[0]}`, "", `Con tu pago por e-cheq abonás: ${params[1]}`, "Recordá enviar el e-cheq al momento de recibir el pedido.", "", `Pagando al contado ahorrarías ${params[2]}.`];
    }
  } else {
    const base = [SALUDO, "", `Total de tus facturas (con IVA): ${params[0]}, en ${params[1]} facturas.`, "", `Detalle por factura: ${params[2]}`, ""];
    if (grupo === "contado") {
      cuerpo = [...base, `Pagando al contado (25% de descuento) abonás: ${params[3]}`];
    } else if (grupo === "credito") {
      cuerpo = [...base, `Con tu pago a ${params[3]} días abonás: ${params[4]}`, "", `Pagando al contado ahorrarías ${params[5]}.`];
    } else {
      cuerpo = [...base, `Con tu pago por e-cheq abonás: ${params[3]}`, "Recordá enviar el e-cheq al momento de recibir el pedido.", "", `Pagando al contado ahorrarías ${params[4]}.`];
    }
  }
  return cuerpo.join("\n") + "\n" + PAGO_FOOTER;
}

// deno-lint-ignore no-explicit-any
function armarMensaje(metodo: string, _business: string | null, facturas: any[]) {
  const grupo = grupoDe(metodo);
  const dto = DTO_DEFAULT[metodo] ?? 0.25;
  const totales = facturas.map((f) => Number(f.total || 0));
  const total_sum = totales.reduce((s, t) => s + t, 0);
  const montoContado = total_sum * 0.75;
  const montoCliente = total_sum * (1 - dto);
  const ahorroVsContado = montoCliente - montoContado;
  const plazoLabel = PLAZO[metodo] ?? "";
  const n = facturas.length;
  const esMultiple = n > 1;
  const listaFacturas = totales.map((t) => fmtARS(t)).join(" / ");
  const template = esMultiple ? TPL[grupo].multi : TPL[grupo].single;

  let params: string[];
  if (!esMultiple) {
    if (grupo === "credito") params = [fmtARS(total_sum), plazoLabel, fmtARS(montoCliente), fmtARS(ahorroVsContado)];
    else if (grupo === "echeq") params = [fmtARS(total_sum), fmtARS(montoCliente), fmtARS(ahorroVsContado)];
    else params = [fmtARS(total_sum), fmtARS(montoContado)];
  } else {
    const base = [fmtARS(total_sum), String(n), listaFacturas];
    if (grupo === "credito") params = [...base, plazoLabel, fmtARS(montoCliente), fmtARS(ahorroVsContado)];
    else if (grupo === "echeq") params = [...base, fmtARS(montoCliente), fmtARS(ahorroVsContado)];
    else params = [...base, fmtARS(montoContado)];
  }

  return {
    template, language: "es_AR", metodo, grupo, n_facturas: n, multiple: esMultiple, plazo: plazoLabel || null,
    params, lista_facturas: listaFacturas, texto_legible: textoLegible(grupo, esMultiple, params),
    total_fmt: fmtARS(total_sum),
    desglose: {
      total_civa: fmtARS(total_sum), dto_cliente: `${Math.round(dto * 100)}%`,
      monto_cliente: fmtARS(montoCliente), monto_contado: fmtARS(montoContado), ahorro_vs_contado: fmtARS(ahorroVsContado),
    },
  };
}

const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 150]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

function today(): string { return new Date().toISOString().slice(0, 10); }
function nuevoCuit(): string { return "30999" + String(randInt(0, 999999)).padStart(6, "0"); }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    // ── sim_new: crea el grupo de prueba (cuit ficticio, N facturas esperadas) ──
    if (action === "sim_new") {
      const metodo = (typeof body.metodo === "string" && METODOS.includes(body.metodo)) ? body.metodo : pick(METODOS);
      const np = Number.isInteger(body.np_esperados) && body.np_esperados >= 1 && body.np_esperados <= 6 ? body.np_esperados : randInt(1, 3);
      const cuit = nuevoCuit();
      const fecha = today();
      const business = "CLIENTE SIMULACIÓN";
      const pub = await gpPub();
      const { error } = await pub.from("wa_sim_control").insert({ cuit, fecha, np_esperados: np, business_name: business, metodo });
      if (error) return json({ error: "control: " + error.message }, 500);
      return json({ ok: true, sim: { cuit, fecha, np_esperados: np, np_facturados: 0, metodo, business_name: business, estado: "waiting" } });
    }

    // ── sim_emit: sube PDF + inserta 1 factura de prueba → dispara el trigger ISIS ──
    if (action === "sim_emit") {
      const cuit = String(body.cuit ?? "");
      if (!cuit) return json({ error: "cuit requerido" }, 400);
      const pub = await gpPub();
      const { data: ctrl } = await pub.from("wa_sim_control").select("*").eq("cuit", cuit).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!ctrl) return json({ error: "grupo no encontrado" }, 404);

      const { data: prev } = await pub.rpc("wa_factura_grupo", { p_schema: "isis_lk", p_cuit: cuit, p_fecha: ctrl.fecha });
      const nPrev = (prev ?? []).length;
      if (nPrev >= ctrl.np_esperados) return json({ ok: true, note: "grupo ya completo", faltan: 0, disparo: false });

      const numero = String(99001 + nPrev).padStart(8, "0");
      const path = `sim/${cuit}/${numero}.pdf`;
      const up = await pub.storage.from(BUCKET).upload(path, PDF_BYTES, { contentType: "application/pdf", upsert: true });
      if (up.error) return json({ error: "upload PDF: " + up.error.message }, 500);

      const total = randInt(150000, 1800000) + Math.random();
      const subt = Math.round((total / 1.21) * 100) / 100;
      // isis_lk no está expuesto por PostgREST → insert vía RPC pública (gateada a CUIT 30999…).
      const { data: comp, error: insErr } = await pub.rpc("wa_sim_insert_documento", {
        p_cuit: cuit, p_fecha: ctrl.fecha, p_numero: numero, p_total: total, p_subt: subt,
        p_condicion: COND[ctrl.metodo] ?? "Contado", p_nombre: ctrl.business_name, p_storage_path: path,
      });
      if (insErr) return json({ error: "insert documento: " + insErr.message }, 500);

      // El trigger ISIS ya corrió (síncrono). Ver si encoló el aviso.
      const nNow = nPrev + 1;
      const disparo = nNow >= ctrl.np_esperados;
      const comprobante = comp ?? `FC-A-0004-${numero}`;
      return json({ ok: true, emitted: { comprobante, total, total_fmt: fmtARS(total), storage_path: path }, faltan: Math.max(0, ctrl.np_esperados - nNow), disparo });
    }

    // ── sim_state: estado de todos los grupos + mensaje si el trigger ya disparó ──
    if (action === "sim_state") {
      const pub = await gpPub();
      const { data: controls } = await pub.from("wa_sim_control").select("*").order("created_at", { ascending: false }).limit(30);
      const out = [];
      for (const c of (controls ?? [])) {
        const { data: facturas } = await pub.rpc("wa_factura_grupo", { p_schema: "isis_lk", p_cuit: c.cuit, p_fecha: c.fecha });
        const fs = facturas ?? [];
        const { data: aviso } = await pub.from("wa_sim_avisos").select("*").eq("cuit", c.cuit).eq("fecha", c.fecha).maybeSingle();
        const metodos = Array.from(new Set(fs.map((f: Record<string, unknown>) => f.metodo).filter(Boolean)));
        const metodoMixto = metodos.length > 1;
        let estado = "waiting";
        let mensaje = null;
        if (aviso) {
          if (metodoMixto) estado = "held_metodo_mixto";
          else { estado = "complete"; mensaje = armarMensaje(c.metodo, c.business_name, fs); }
        }
        out.push({
          cuit: c.cuit, fecha: c.fecha, business_name: c.business_name, metodo: c.metodo,
          np_esperados: c.np_esperados, np_facturados: fs.length,
          comprobantes: fs.map((f: Record<string, unknown>) => f.comprobante_id),
          totales: fs.map((f: Record<string, unknown>) => Number(f.total || 0)),
          disparado: !!aviso, estado, mensaje, created_at: c.created_at,
        });
      }
      return json({ items: out });
    }

    // ── sim_reset: borra facturas y PDFs de prueba (nada real se toca) ──
    if (action === "sim_reset") {
      const pub = await gpPub();
      // 1) paths de los PDF de prueba (vía RPC; isis_lk no está expuesto)
      const { data: paths } = await pub.rpc("wa_sim_paths");
      const list = (paths ?? []) as string[];
      if (list.length) { try { await pub.storage.from(BUCKET).remove(list); } catch (_e) { /* best effort */ } }
      // 2) borrar filas de prueba (documentos + control + avisos) vía RPC gateada
      const { data: n } = await pub.rpc("wa_sim_cleanup");
      return json({ ok: true, borradas: list.length, docs: n ?? 0 });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_notif-sim error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
