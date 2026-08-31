import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// lk_factura-check — Etapa 5 del pipeline de facturación (PaginaLK).
//
// Lo llama el trigger real `wa_factura_notificar` (ISIS) cuando impacta una factura
// nueva de un cliente, con { source, cuit, fecha }. Evalúa si el GRUPO del pedido está
// COMPLETO (todas las NPs facturadas → cola real `wa_grupo_listo` en ISIS) y, si sí,
// arma el mensaje consolidado (misma lógica/plantillas que producción) y lo ENTREGA.
//
// Desvío (mientras el bot no está conectado al número): el mensaje va al módulo de
// prueba (tabla wa_sim_inbox en PaginaLK), NO a WhatsApp. Controlado por
// app_settings.wa_factura_envio_modo ('modulo' = chat de prueba | 'whatsapp' = real).
// Hoy sólo procesa clientes de PRUEBA (cuit 30999…); datos reales quedan dormant.
// verify_jwt=false (lo llama pg_net desde ISIS).

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

// ── Estado de aprobación de la plantilla en Meta (no enviar si no está APPROVED) ──
const META_API = "https://graph.facebook.com/v21.0";
async function metaToken(): Promise<string> {
  return Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? Deno.env.get("WA_TOKEN") ?? (await getSetting("wa_token")) ?? "";
}
async function metaWaba(): Promise<string> {
  return Deno.env.get("WA_BUSINESS_ACCOUNT_ID") ?? (await getSetting("wa_business_account_id")) ?? "";
}
let _tplStatus: Record<string, string> | null = null;
async function tplStatus(name: string): Promise<string | null> {
  if (!_tplStatus) {
    _tplStatus = {};
    try {
      const token = await metaToken(), waba = await metaWaba();
      if (token && waba) {
        const res = await fetch(`${META_API}/${waba}/message_templates?limit=200`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        // deno-lint-ignore no-explicit-any
        for (const t of (data.data ?? [])) _tplStatus[t.name] = t.status;
      }
    } catch { /* si no se puede verificar, no bloquea */ }
  }
  return _tplStatus[name] ?? null;
}

// ── Lógica de descuento/plantilla (guía docs/plantillas_whatsapp.md) ──
const DTO_DEFAULT: Record<string, number> = {
  contado: 0.25, credito_15_30: 0.20, credito_31_45: 0.15, credito_46_60: 0.10, echeq_90: 0.05, echeq_120: 0.00, no_decidido: 0.25,
};
const PLAZO: Record<string, string> = { credito_15_30: "15 a 30", credito_31_45: "31 a 45", credito_46_60: "46 a 60" };
const TPL: Record<string, { single: string; multi: string }> = {
  contado: { single: "pedido_contado_s", multi: "pedido_contado_p" },
  credito: { single: "pedido_credito_s", multi: "pedido_credito_p" },
  echeq:   { single: "pedido_echeq_s",   multi: "pedido_echeq_p" },
};
function grupoDe(m: string): "contado" | "credito" | "echeq" {
  if ((m || "").startsWith("credito")) return "credito";
  if ((m || "").startsWith("echeq")) return "echeq";
  return "contado";
}
const PAGO_FOOTER = ["", "Datos para el pago:", "Alias: loeke.srl", "CBU: 1910027855002702387450"].join("\n");
const SALUDO = "¡Hola! Tu pedido está listo y estará con vos a la brevedad.";
function textoLegible(grupo: string, esMultiple: boolean, params: string[]): string {
  let cuerpo: string[];
  if (!esMultiple) {
    if (grupo === "contado") cuerpo = [SALUDO, "", `Total de tu factura (con IVA): ${params[0]}`, "", `Pagando al contado (25% de descuento) abonás: ${params[1]}`];
    else if (grupo === "credito") cuerpo = [SALUDO, "", `Total de tu factura (con IVA): ${params[0]}`, "", `Con tu pago a ${params[1]} días abonás: ${params[2]}`, "", `Pagando al contado ahorrarías ${params[3]}.`];
    else cuerpo = [SALUDO, "", `Total de tu factura (con IVA): ${params[0]}`, "", `Con tu pago por e-cheq abonás: ${params[1]}`, "Recordá enviar el e-cheq al momento de recibir el pedido.", "", `Pagando al contado ahorrarías ${params[2]}.`];
  } else {
    const base = [SALUDO, "", `Total de tus facturas (con IVA): ${params[0]}, en ${params[1]} facturas.`, "", `Detalle por factura: ${params[2]}`, ""];
    if (grupo === "contado") cuerpo = [...base, `Pagando al contado (25% de descuento) abonás: ${params[3]}`];
    else if (grupo === "credito") cuerpo = [...base, `Con tu pago a ${params[3]} días abonás: ${params[4]}`, "", `Pagando al contado ahorrarías ${params[5]}.`];
    else cuerpo = [...base, `Con tu pago por e-cheq abonás: ${params[3]}`, "Recordá enviar el e-cheq al momento de recibir el pedido.", "", `Pagando al contado ahorrarías ${params[4]}.`];
  }
  return cuerpo.join("\n") + "\n" + PAGO_FOOTER;
}
// deno-lint-ignore no-explicit-any
function armarMensaje(metodo: string, facturas: any[]) {
  const grupo = grupoDe(metodo);
  const dto = DTO_DEFAULT[metodo] ?? 0.25;
  const totales = facturas.map((f) => Number(f.total || 0));
  const total_sum = totales.reduce((s, t) => s + t, 0);
  const montoContado = total_sum * 0.75;
  const montoCliente = total_sum * (1 - dto);
  const ahorro = montoCliente - montoContado;
  const plazo = PLAZO[metodo] ?? "";
  const n = facturas.length;
  const esMultiple = n > 1;
  const lista = totales.map((t) => fmtARS(t)).join(" / ");
  const template = esMultiple ? TPL[grupo].multi : TPL[grupo].single;
  let params: string[];
  if (!esMultiple) {
    if (grupo === "credito") params = [fmtARS(total_sum), plazo, fmtARS(montoCliente), fmtARS(ahorro)];
    else if (grupo === "echeq") params = [fmtARS(total_sum), fmtARS(montoCliente), fmtARS(ahorro)];
    else params = [fmtARS(total_sum), fmtARS(montoContado)];
  } else {
    const base = [fmtARS(total_sum), String(n), lista];
    if (grupo === "credito") params = [...base, plazo, fmtARS(montoCliente), fmtARS(ahorro)];
    else if (grupo === "echeq") params = [...base, fmtARS(montoCliente), fmtARS(ahorro)];
    else params = [...base, fmtARS(montoContado)];
  }
  return {
    template, language: "es_AR", metodo, grupo, n_facturas: n, multiple: esMultiple,
    params, lista_facturas: lista, texto_legible: textoLegible(grupo, esMultiple, params),
    total_sum, total_fmt: fmtARS(total_sum),
    desglose: {
      total_civa: fmtARS(total_sum), dto_cliente: `${Math.round(dto * 100)}%`,
      monto_cliente: fmtARS(montoCliente), monto_contado: fmtARS(montoContado), ahorro_vs_contado: fmtARS(ahorro),
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return new Response("ok");
  try {
    const body = await req.json().catch(() => ({}));
    const source = (body.source as string) || "lk";
    const cuit = String(body.cuit ?? "");
    const fecha = String(body.fecha ?? "");
    if (!cuit || !fecha) return json({ error: "cuit y fecha requeridos" }, 400);

    const isTest = cuit.startsWith("30999");
    const modo = (await getSetting("wa_factura_envio_modo")) || "modulo";
    // Datos reales quedan dormant hasta conectar el bot (modo whatsapp).
    if (!isTest && modo !== "whatsapp") return json({ skipped: "dormant_real", cuit });

    const g = await gp();

    // Mapear cuit → grupo (cod|destino|dia). Para prueba, desde wa_sim_control (ISIS).
    let cod = "", direccion = "", metodoCtrl = "";
    if (isTest) {
      const { data: ctrl } = await g.from("wa_sim_control").select("*").eq("cuit", cuit).eq("fecha", fecha).maybeSingle();
      if (!ctrl) return json({ skipped: "sin_control", cuit });
      cod = ctrl.cod_cliente; direccion = ctrl.direccion; metodoCtrl = ctrl.metodo;
    } else {
      return json({ skipped: "real_no_implementado", cuit });
    }
    const destino = (direccion || "").toUpperCase() || "(s/dir)";
    const grupoKey = `${cod}|${destino}|${fecha}`;

    // ¿El grupo está completo? (cola real wa_grupo_listo, que llena el trigger de Facturacion_NP)
    // Claim ATÓMICO: sólo un llamado entrega (evita duplicados por trigger + driver concurrentes).
    const { data: claimed } = await g.from("wa_grupo_listo")
      .update({ enviado: true, enviado_at: new Date().toISOString() })
      .eq("grupo_key", grupoKey).eq("enviado", false).select().maybeSingle();
    if (!claimed) {
      const { data: ex } = await g.from("wa_grupo_listo").select("enviado").eq("grupo_key", grupoKey).maybeSingle();
      if (!ex) return json({ complete: false, grupo_key: grupoKey, note: "faltan NPs por facturar" });
      return json({ ok: true, already: true, grupo_key: grupoKey });
    }
    const grupo = claimed;

    // Facturas por fuente (cubre multisource lk+ch, igual que lk_factura-consolidar).
    const { data: fLk } = await g.rpc("wa_factura_grupo", { p_schema: "isis_lk", p_cuit: cuit, p_fecha: fecha });
    const { data: fCh } = await g.rpc("wa_factura_grupo", { p_schema: "isis_ch", p_cuit: cuit, p_fecha: fecha });
    const facturasLk = fLk ?? [], facturasCh = fCh ?? [];
    const multisource = facturasLk.length > 0 && facturasCh.length > 0;
    const facturas = facturasLk.length ? facturasLk : facturasCh;
    const srcUsado = facturasLk.length ? "lk" : "ch";
    if (!facturas.length) return json({ complete: true, note: "grupo completo pero sin documentos parseados aún" });

    const metodos = Array.from(new Set(facturas.map((f: Record<string, unknown>) => f.metodo).filter(Boolean)));
    const metodoMixto = metodos.length > 1;
    const metodo = (facturas[0]?.metodo as string) || metodoCtrl || "no_decidido";

    let estado = "delivered";
    // deno-lint-ignore no-explicit-any
    let mensaje: any = null;
    if (multisource) estado = "held_multisource";
    else if (metodoMixto) estado = "held_metodo_mixto";
    else {
      mensaje = armarMensaje(metodo, facturas);
      // No enviar con plantilla no aprobada por Meta (Meta la rechazaría).
      const st = await tplStatus(mensaje.template);
      mensaje.tpl_status = st;
      if (st && st !== "APPROVED") estado = "held_tpl_no_aprobada";
    }

    const total_sum = facturas.reduce((s: number, f: Record<string, unknown>) => s + Number(f.total || 0), 0);

    // Entregar al destino según modo. Hoy: módulo de prueba (desvío). El grupo ya quedó
    // marcado enviado por el claim atómico; si la entrega falla, lo liberamos.
    const { error: inbErr } = await paginalk.from("wa_sim_inbox").insert({
      source: srcUsado, grupo_key: grupoKey, cuit, cod_cliente: cod,
      business_name: grupo.razon_social ?? "CLIENTE SIMULACIÓN", fecha,
      n_facturas: facturas.length, total_sum, metodo, estado, mensaje,
    });
    if (inbErr) {
      await g.from("wa_grupo_listo").update({ enviado: false, enviado_at: null }).eq("grupo_key", grupoKey);
      return json({ error: "entrega inbox: " + inbErr.message }, 500);
    }

    return json({ ok: true, delivered: true, destino: modo, estado, grupo_key: grupoKey, multisource, source: srcUsado, n_facturas: facturas.length, mensaje });
  } catch (err) {
    console.error("lk_factura-check error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
