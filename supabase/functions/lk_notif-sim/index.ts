import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// lk_notif-sim — Simulador de "avisos automáticos por facturación" para el dashboard.
//
// Reproduce, de forma AISLADA y SIN ENVIAR WhatsApp, el flujo real:
//   1) Un pedido de un cliente se factura en 1..N NPs (comprobantes).
//   2) El bot lleva rastro (np_esperados vs np_facturados) y ESPERA a que impacten
//      TODAS las facturas del cliente antes de armar un único aviso consolidado.
//   3) Al completarse, arma el plan de mensaje con la MISMA lógica de descuento/plantilla
//      que lk_factura-consolidar (contado / crédito / echeq, single vs múltiple).
//
// No toca wa_factura_consolidada, bot_facturado_avisos ni wa_outbox: sólo wa_sim_facturas.
// Autocontenida (no depende de _shared). verify_jwt=false (se llama con anon key).

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
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function fmtARS(n: number): string {
  return "$" + Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function randInt(a: number, b: number): number { return Math.floor(a + Math.random() * (b - a + 1)); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Lógica de descuento/plantilla — espejo de lk_factura-consolidar ──
const DTO_DEFAULT: Record<string, number> = {
  contado: 0.25, credito_15_30: 0.20, credito_31_45: 0.15,
  credito_46_60: 0.10, echeq_90: 0.05, echeq_120: 0.00, no_decidido: 0.25,
};
const PLAZO: Record<string, string> = {
  credito_15_30: "15 a 30", credito_31_45: "31 a 45", credito_46_60: "46 a 60",
};
const METODOS = ["contado", "credito_15_30", "credito_31_45", "credito_46_60", "echeq_90", "echeq_120"];

// Nombres reales aprobados en Meta (cuenta N8N Loekemeyer): _s = single, _p = plural.
const TPL: Record<string, { single: string; multi: string }> = {
  contado: { single: "pedido_contado_s", multi: "pedido_contado_p" },
  credito: { single: "pedido_credito_s", multi: "pedido_credito_p" },
  echeq:   { single: "pedido_echeq_s",   multi: "pedido_echeq_p" },
};

function grupoDe(metodo: string): "contado" | "credito" | "echeq" {
  if (metodo.startsWith("credito")) return "credito";
  if (metodo.startsWith("echeq")) return "echeq";
  return "contado";
}

// Reconstrucción legible del mensaje (la copy real vive en la plantilla de Meta).
function textoLegible(
  grupo: string, esMultiple: boolean, nombre: string, params: string[],
  n: number, plazo: string,
): string {
  const hola = `Hola ${nombre || ""},`.trim();
  if (grupo === "contado") {
    return esMultiple
      ? [`📦 *Tu pedido está facturado* (${n} facturas)`, "", hola,
         `total de tus facturas: *${params[0]}*`, `Facturas: ${params[2]}`, "",
         `💵 Pagando al contado: *${params[3]}*`, "", 'Escribí "Menú" para más opciones.'].join("\n")
      : ["📦 *Tu pedido está facturado*", "", hola,
         `total con IVA: *${params[0]}*`, `💵 Pagando al contado: *${params[1]}*`, "",
         'Escribí "Menú" para más opciones.'].join("\n");
  }
  if (grupo === "credito") {
    return esMultiple
      ? [`📦 *Tu pedido está facturado* (${n} facturas)`, "", hola,
         `total de tus facturas: *${params[0]}*`, `Facturas: ${params[2]}`, "",
         `🗓️ A crédito ${params[3]} días: *${params[4]}*`,
         `💵 Pagando al contado ahorrás *${params[5]}*`, ""].join("\n")
      : ["📦 *Tu pedido está facturado*", "", hola,
         `total con IVA: *${params[0]}*`,
         `🗓️ A crédito ${params[1]} días: *${params[2]}*`,
         `💵 Pagando al contado ahorrás *${params[3]}*`, ""].join("\n");
  }
  // echeq
  return esMultiple
    ? [`📦 *Tu pedido está facturado* (${n} facturas)`, "", hola,
       `total de tus facturas: *${params[0]}*`, `Facturas: ${params[2]}`, "",
       `🧾 Con e-check: *${params[3]}*`, `💵 Pagando al contado ahorrás *${params[4]}*`, ""].join("\n")
    : ["📦 *Tu pedido está facturado*", "", hola,
       `total con IVA: *${params[0]}*`,
       `🧾 Con e-check: *${params[1]}*`, `💵 Pagando al contado ahorrás *${params[2]}*`, ""].join("\n");
}

function armarMensaje(row: {
  metodo: string; grupo: string; totales: number[]; total_sum: number;
  business_name: string | null; np_esperados: number;
}) {
  const metodo = row.metodo;
  const grupo = row.grupo as "contado" | "credito" | "echeq";
  const dto = DTO_DEFAULT[metodo] ?? 0.25;
  const total_sum = row.total_sum;
  const montoContado = total_sum * 0.75;
  const montoCliente = total_sum * (1 - dto);
  const ahorroVsContado = montoCliente - montoContado;
  const plazoLabel = PLAZO[metodo] ?? "";
  const n = row.totales.length;
  const esMultiple = n > 1;
  const listaFacturas = row.totales.map((t) => fmtARS(Number(t || 0))).join(" / ");
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

  const nombre = (row.business_name ?? "").replace(/\s+(S\.?A\.?|S\.?R\.?L\.?|SRL|SA).*/i, "").trim();

  return {
    template, language: "es_AR", metodo, grupo,
    n_facturas: n, multiple: esMultiple, plazo: plazoLabel || null,
    params, lista_facturas: listaFacturas,
    texto_legible: textoLegible(grupo, esMultiple, nombre, params, n, plazoLabel),
    total_fmt: fmtARS(total_sum),
    desglose: {
      total_civa: fmtARS(total_sum),
      dto_cliente: `${Math.round(dto * 100)}%`,
      monto_cliente: fmtARS(montoCliente),
      monto_contado: fmtARS(montoContado),
      ahorro_vs_contado: fmtARS(ahorroVsContado),
    },
  };
}

function maskCuit(cuit: string | null): string {
  const d = (cuit ?? "").replace(/\D/g, "");
  if (d.length < 4) return "••-••••••••-•";
  return `${d.slice(0, 2)}-••••${d.slice(-3, -1)}-${d.slice(-1)}`;
}

async function pickCliente() {
  // Cliente real (con CUIT) elegido server-side; sólo se expone nombre + CUIT enmascarado.
  const { data } = await supabase
    .from("customers")
    .select("cod_cliente, business_name, cuit")
    .not("business_name", "is", null)
    .not("cuit", "is", null)
    .limit(300);
  const rows = (data ?? []).filter((c) => (c.business_name ?? "").trim() !== "");
  if (!rows.length) return { cod_cliente: null, business_name: "Cliente Demo SRL", cuit_masked: maskCuit("30123456780") };
  // deno-lint-ignore no-explicit-any
  const c: any = pick(rows);
  return { cod_cliente: c.cod_cliente != null ? String(c.cod_cliente) : null, business_name: c.business_name, cuit_masked: maskCuit(c.cuit) };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    if (action === "sim_list") {
      const { data, error } = await supabase
        .from("wa_sim_facturas").select("*").order("created_at", { ascending: false }).limit(50);
      if (error) return json({ error: error.message }, 500);
      return json({ items: data ?? [] });
    }

    if (action === "sim_reset") {
      const { error } = await supabase.from("wa_sim_facturas").delete().neq("sim_id", "00000000-0000-0000-0000-000000000000");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "sim_new") {
      const cli = await pickCliente();
      const metodo = (typeof body.metodo === "string" && METODOS.includes(body.metodo)) ? body.metodo : pick(METODOS);
      // np_esperados: 1..4 (para mostrar single vs múltiple/consolidado)
      const np_esperados = Number.isInteger(body.np_esperados) && body.np_esperados >= 1 && body.np_esperados <= 8
        ? body.np_esperados : randInt(1, 4);
      const { data, error } = await supabase.from("wa_sim_facturas").insert({
        source: "lk",
        cod_cliente: cli.cod_cliente,
        business_name: cli.business_name,
        cuit_masked: cli.cuit_masked,
        fecha: new Date().toISOString().slice(0, 10),
        metodo, grupo: grupoDe(metodo),
        np_esperados, np_facturados: 0,
        estado: "waiting",
      }).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, sim: data });
    }

    if (action === "sim_emit") {
      const sim_id = body.sim_id as string;
      if (!sim_id) return json({ error: "sim_id requerido" }, 400);
      const { data: row, error: e1 } = await supabase
        .from("wa_sim_facturas").select("*").eq("sim_id", sim_id).maybeSingle();
      if (e1) return json({ error: e1.message }, 500);
      if (!row) return json({ error: "sim no encontrada" }, 404);
      if (row.estado !== "waiting") return json({ ok: true, sim: row, note: "ya completa" });

      // Generar una factura que "impacta en Supa"
      const np = "9" + String(200000 + randInt(0, 99999));
      const nroComp = 35700 + randInt(1, 999);
      const comprobante = `FC-A-0004-${String(nroComp).padStart(8, "0")}`;
      const totalFactura = randInt(150000, 1800000) + Math.random();

      const np_list = [...(row.np_list ?? []), np];
      const comprobantes = [...(row.comprobantes ?? []), comprobante];
      const totales = [...(row.totales ?? []).map(Number), totalFactura];
      const total_sum = totales.reduce((s, t) => s + Number(t || 0), 0);
      const np_facturados = row.np_facturados + 1;
      const completa = np_facturados >= row.np_esperados;

      let estado = "waiting";
      let mensaje: unknown = null;
      let completed_at: string | null = null;
      if (completa) {
        estado = "complete";
        completed_at = new Date().toISOString();
        mensaje = armarMensaje({
          metodo: row.metodo, grupo: row.grupo, totales, total_sum,
          business_name: row.business_name, np_esperados: row.np_esperados,
        });
      }

      const { data: upd, error: e2 } = await supabase.from("wa_sim_facturas").update({
        np_list, comprobantes, totales, total_sum, np_facturados,
        estado, mensaje, completed_at, updated_at: new Date().toISOString(),
      }).eq("sim_id", sim_id).select().single();
      if (e2) return json({ error: e2.message }, 500);

      return json({
        ok: true, sim: upd,
        emitted: { np, comprobante, total: totalFactura, total_fmt: fmtARS(totalFactura) },
        faltan: Math.max(0, row.np_esperados - np_facturados),
        disparo: completa,
      });
    }

    if (action === "sim_send") {
      // "Enviar" simulado: no se envía WhatsApp real desde el simulador (solo marca el estado).
      const sim_id = body.sim_id as string;
      if (!sim_id) return json({ error: "sim_id requerido" }, 400);
      const { data: row } = await supabase.from("wa_sim_facturas").select("estado").eq("sim_id", sim_id).maybeSingle();
      if (!row) return json({ error: "sim no encontrada" }, 404);
      if (row.estado !== "complete") return json({ error: "todavía faltan facturas" }, 400);
      const { data: upd, error } = await supabase.from("wa_sim_facturas").update({
        estado: "sent_sim", sent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("sim_id", sim_id).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({
        ok: true, sim: upd,
        nota: "SIMULACIÓN: el simulador no envía WhatsApp real, sólo marca el aviso como enviado.",
      });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_notif-sim error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
