import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

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

// ── Lista blanca de envío (wa_envio_contactos). El bot SÓLO envía a estos números. ──
async function whitelist(): Promise<string[]> {
  const { data } = await paginalk.from("wa_envio_contactos").select("phone");
  return (data ?? []).map((r: { phone: string }) => r.phone);
}

// ── Combinación REAL de PDFs (pdf-lib) — mismo patrón que lk_factura-consolidar ──
// deno-lint-ignore no-explicit-any
async function combinarPdfs(g: any, srcUsado: string, cuit: string, fecha: string) {
  const bucket = srcUsado === "ch" ? "isis-ch" : "isis-lk";
  const { data: paths } = await g.rpc("wa_sim_factura_paths", { p_source: srcUsado, p_cuit: cuit, p_fecha: fecha });
  const list = (paths ?? []) as string[];
  if (!list.length) return null;
  const merged = await PDFDocument.create();
  let ok = 0;
  for (const p of list) {
    try {
      const dl = await g.storage.from(bucket).download(p);
      if (dl.error || !dl.data) continue;
      const buf = new Uint8Array(await dl.data.arrayBuffer());
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((pg: unknown) => merged.addPage(pg as never));
      ok++;
    } catch { /* omite PDF ilegible */ }
  }
  if (!ok) return null;
  const bytes = await merged.save();
  const outPath = `sim/${cuit}/combinada_${fecha}.pdf`;
  const up = await g.storage.from(bucket).upload(outPath, bytes, { contentType: "application/pdf", upsert: true });
  if (up.error) return { path: outPath, url: null, n: ok, error: up.error.message };
  const { data: signed } = await g.storage.from(bucket).createSignedUrl(outPath, 3600);
  return { path: outPath, url: signed?.signedUrl ?? null, n: ok };
}

// ── Combinación REAL por lista explícita de paths (grupos reales linkeados) ──
// deno-lint-ignore no-explicit-any
async function combinarPaths(g: any, source: string, paths: string[], outName: string) {
  const bucket = source === "ch" ? "isis-ch" : "isis-lk";
  const list = (paths ?? []).filter(Boolean);
  if (!list.length) return null;
  const merged = await PDFDocument.create();
  let ok = 0;
  for (const p of list) {
    try {
      const dl = await g.storage.from(bucket).download(p);
      if (dl.error || !dl.data) continue;
      const buf = new Uint8Array(await dl.data.arrayBuffer());
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((pg: unknown) => merged.addPage(pg as never));
      ok++;
    } catch { /* omite ilegible */ }
  }
  if (!ok) return null;
  const bytes = await merged.save();
  const outPath = `shadow/${outName}.pdf`;
  const up = await g.storage.from(bucket).upload(outPath, bytes, { contentType: "application/pdf", upsert: true });
  if (up.error) return { path: outPath, url: null, n: ok, error: up.error.message };
  const { data: signed } = await g.storage.from(bucket).createSignedUrl(outPath, 3600);
  return { path: outPath, url: signed?.signedUrl ?? null, n: ok };
}

// ── Envío REAL por WhatsApp (Meta Cloud API) con header documento + cuerpo plantilla ──
async function waPhoneId(): Promise<string> {
  return Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? (await getSetting("wa_phone_number_id")) ?? "";
}
// deno-lint-ignore no-explicit-any
async function enviarWhatsapp(to: string, mensaje: any, pdfUrl: string | null) {
  const token = await metaToken(), phoneId = await waPhoneId();
  if (!token) return { error: "sin WHATSAPP_ACCESS_TOKEN" };
  if (!phoneId) return { error: "sin wa_phone_number_id" };
  const components: unknown[] = [];
  if (pdfUrl) {
    components.push({ type: "header", parameters: [{ type: "document", document: { link: pdfUrl, filename: "facturas.pdf" } }] });
  }
  components.push({ type: "body", parameters: (mensaje.params ?? []).map((t: string) => ({ type: "text", text: t })) });
  const payload = {
    messaging_product: "whatsapp", to, type: "template",
    template: { name: mensaje.template, language: { code: mensaje.language || "es_AR" }, components },
  };
  try {
    const res = await fetch(`${META_API}/${phoneId}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) return { error: data?.error?.message || `HTTP ${res.status}`, raw: data };
    return { ok: true, wamid: data?.messages?.[0]?.id ?? null };
  } catch (e) { return { error: String(e) }; }
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

// ── Modo GRUPO: envío REAL redirigido de un grupo real ya linkeado (NP↔factura) ──
// Recibe el grupo completo (comprobantes/paths/totales/metodos) y lo entrega SÓLO al número
// de redirección (Thomy) — nunca al cliente. Guardas: config de redirección + fecha de HOY +
// número en la lista blanca. Idempotente por group_key (wa_shadow_log). No toca datos de cliente.
// deno-lint-ignore no-explicit-any
async function handleGrupo(body: any) {
  const redirect = (await getSetting("wa_real_redirect_to")) || "";
  const rDate = (await getSetting("wa_real_redirect_date")) || "";
  const hoy = new Date().toISOString().slice(0, 10);
  if (!redirect) return json({ mode: "grupo", skipped: "sin_redirect" });
  if (rDate !== hoy) return json({ mode: "grupo", skipped: "fuera_de_fecha", rDate, hoy });
  const wl = await whitelist();
  if (!wl.includes(redirect)) return json({ mode: "grupo", skipped: "redirect_no_whitelist" });

  const gk = String(body.group_key ?? "");
  if (!gk) return json({ mode: "grupo", error: "group_key requerido" }, 400);
  const { data: prev } = await paginalk.from("wa_shadow_log").select("estado,n_facturas").eq("group_key", gk).maybeSingle();
  const totales = (body.totales ?? []).map((t: unknown) => Number(t) || 0);
  if (prev && prev.estado === "sent_whatsapp" && (prev.n_facturas ?? 0) >= totales.length) {
    return json({ mode: "grupo", group_key: gk, skipped: "ya_enviado" });
  }

  const empresa = String(body.empresa ?? "lk");
  const source = empresa === "chef" ? "ch" : "lk";
  const metodos = (body.metodos ?? []) as string[];
  const facturas = totales.map((t: number) => ({ total: t }));
  const metodoMixto = metodos.length > 1;
  const metodo = metodos[0] || "no_decidido";

  let estado = "delivered";
  // deno-lint-ignore no-explicit-any
  let mensaje: any = null;
  if (metodoMixto) estado = "held_metodo_mixto";
  else {
    mensaje = armarMensaje(metodo, facturas);
    const st = await tplStatus(mensaje.template);
    mensaje.tpl_status = st;
    if (st && st !== "APPROVED") estado = "held_tpl_no_aprobada";
    mensaje.real_group = { group_key: gk, cod_cliente: body.cod_cliente ?? null, comprobantes: body.comprobantes ?? [] };
  }

  const g = await gp();
  let pdf = null;
  if (mensaje && !metodoMixto) {
    pdf = await combinarPaths(g, source, (body.storage_paths ?? []) as string[], gk.replace(/[^0-9a-zA-Z]+/g, "_"));
    mensaje.pdf_combinado = pdf ? { path: pdf.path, n: pdf.n, ok: !!pdf.url } : null;
  }

  let envio = null;
  if (estado === "delivered") {
    envio = await enviarWhatsapp(redirect, mensaje, pdf?.url ?? null);
    estado = envio.ok ? "sent_whatsapp" : "error_envio";
    mensaje.envio = { to: redirect, ok: !!envio.ok, wamid: envio.wamid ?? null, error: envio.error ?? null };
    if (estado === "sent_whatsapp") {
      try { await g.from("wa_pipeline_log").insert({ event: "aviso_enviado", comprobante: (body.comprobantes ?? [])[0] ?? null, source, detalle: { group_key: gk, n_facturas: facturas.length, cod_cliente: body.cod_cliente ?? null, real: true, redirect: true } }); } catch (_e) { /* log best-effort */ }
    }
  }

  const total_sum = totales.reduce((s: number, t: number) => s + t, 0);
  await paginalk.from("wa_shadow_log").upsert({
    group_key: gk, empresa, cod_cliente: body.cod_cliente ?? null, dia: body.dia ?? null,
    n_facturas: facturas.length, estado, wamid: envio?.wamid ?? null, total_sum, redirect_to: redirect, mensaje,
  }, { onConflict: "group_key" });

  return json({ mode: "grupo", group_key: gk, estado, n_facturas: facturas.length, template: mensaje?.template ?? null, envio, redirect_to: redirect });
}

// ── Camino REAL event-driven: cada factura que impacta hoy → identifica factura↔NP y agrupa
// las facturas del día del cliente POR DIRECCIÓN (cliente+destino = una entrega). Envía una
// entrega por dirección al número de redirección (Thomy). Ancla = día. Off salvo config de
// HOY + lista blanca. Idempotente por (cuit, destino, día); reenvía sólo si crece la cantidad.
// deno-lint-ignore no-explicit-any
async function handleRealRedirect(g: any, cuit: string, fecha: string) {
  const redirect = (await getSetting("wa_real_redirect_to")) || "";
  const rDate = (await getSetting("wa_real_redirect_date")) || "";
  const hoy = new Date().toISOString().slice(0, 10);
  if (!redirect || rDate !== hoy) return json({ skipped: "dormant_real", cuit });
  if (fecha !== hoy) return json({ skipped: "no_es_hoy", cuit, fecha });
  const wl = await whitelist();
  if (!wl.includes(redirect)) return json({ skipped: "redirect_no_whitelist", cuit });

  // Grupos del día por DIRECCIÓN (factura→NP→dirección, vía vista_np_factura).
  const { data: grupos } = await g.rpc("wa_grupos_dia_cuit", { p_cuit: cuit, p_fecha: fecha });
  if (!grupos || !grupos.length) return json({ pendiente: true, cuit, note: "sin facturas matcheadas a NP/dirección hoy" });

  const out = [];
  for (const gr of grupos) {
    const destino = gr.destino || "(s/dir)";
    const source = gr.empresa === "chef" ? "ch" : "lk";
    const totales = (gr.totales ?? []) as number[];
    const metodos = (gr.metodos ?? []) as string[];
    // LK y CH nunca van juntas: el grupo ya viene separado por empresa (bucket distinto).
    const gk = `real|${cuit}|${gr.empresa}|${destino}|${fecha}`;

    const { data: prev } = await paginalk.from("wa_shadow_log").select("estado,n_facturas").eq("group_key", gk).maybeSingle();
    if (prev && prev.estado === "sent_whatsapp" && (prev.n_facturas ?? 0) >= totales.length) { out.push({ destino, skipped: "ya_enviado" }); continue; }

    const facturas = totales.map((t) => ({ total: t }));
    const metodoMixto = metodos.length > 1;
    const metodo = metodos[0] || "no_decidido";
    let estado = "delivered";
    // deno-lint-ignore no-explicit-any
    let mensaje: any = null;
    if (metodoMixto) estado = "held_metodo_mixto";
    else {
      mensaje = armarMensaje(metodo, facturas);
      const st = await tplStatus(mensaje.template);
      mensaje.tpl_status = st;
      if (st && st !== "APPROVED") estado = "held_tpl_no_aprobada";
      mensaje.real_group = { cuit, destino, cod_cliente: gr.cod_cliente ?? null, razon_social: gr.razon_social ?? null, comprobantes: gr.comprobantes ?? [] };
    }

    let pdf = null;
    if (mensaje && !metodoMixto) {
      pdf = await combinarPaths(g, source, (gr.storage_paths ?? []) as string[], gk.replace(/[^0-9a-zA-Z]+/g, "_"));
      mensaje.pdf_combinado = pdf ? { path: pdf.path, n: pdf.n, ok: !!pdf.url } : null;
    }

    let envio = null;
    if (estado === "delivered") {
      envio = await enviarWhatsapp(redirect, mensaje, pdf?.url ?? null);
      estado = envio.ok ? "sent_whatsapp" : "error_envio";
      mensaje.envio = { to: redirect, ok: !!envio.ok, wamid: envio.wamid ?? null, error: envio.error ?? null };
      if (estado === "sent_whatsapp") {
        try { await g.from("wa_pipeline_log").insert({ event: "aviso_enviado", cuit, source, detalle: { destino, n_facturas: facturas.length, real: true, redirect: true } }); } catch (_e) { /* best-effort */ }
      }
    }

    const total_sum = totales.reduce((s, t) => s + Number(t || 0), 0);
    await paginalk.from("wa_shadow_log").upsert({
      group_key: gk, empresa: gr.empresa ?? source, cod_cliente: gr.cod_cliente ?? null, dia: fecha,
      n_facturas: facturas.length, estado, wamid: envio?.wamid ?? null, total_sum, redirect_to: redirect, mensaje,
    }, { onConflict: "group_key" });

    out.push({ destino, estado, n_facturas: facturas.length, template: mensaje?.template ?? null });
  }

  return json({ ok: true, real: true, cuit, grupos: out });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return new Response("ok");
  try {
    const body = await req.json().catch(() => ({}));
    if (body.mode === "grupo") return await handleGrupo(body);
    const source = (body.source as string) || "lk";
    const cuit = String(body.cuit ?? "");
    const fecha = String(body.fecha ?? "");
    if (!cuit || !fecha) return json({ error: "cuit y fecha requeridos" }, 400);

    const isTest = cuit.startsWith("30999");
    const g = await gp();

    // Camino REAL (event-driven): factura de cliente real → agrupa el día y manda a Thomy.
    if (!isTest) return await handleRealRedirect(g, cuit, fecha);

    const modo = (await getSetting("wa_factura_envio_modo")) || "modulo";
    // Mapear cuit → grupo (cod|destino|dia). Para prueba, desde wa_sim_control (ISIS).
    let cod = "", direccion = "", metodoCtrl = "", destPhone = "";
    {
      const { data: ctrl } = await g.from("wa_sim_control").select("*").eq("cuit", cuit).eq("fecha", fecha).maybeSingle();
      if (!ctrl) return json({ skipped: "sin_control", cuit });
      cod = ctrl.cod_cliente; direccion = ctrl.direccion; metodoCtrl = ctrl.metodo; destPhone = ctrl.dest_phone || "";
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

    // ── Combinación REAL de los PDFs (se prueba de verdad aunque no se envíe) ──
    let pdfCombinado = null;
    if (mensaje && !multisource && !metodoMixto) {
      pdfCombinado = await combinarPdfs(g, srcUsado, cuit, fecha);
      mensaje.pdf_combinado = pdfCombinado ? { path: pdfCombinado.path, n: pdfCombinado.n, ok: !!pdfCombinado.url } : null;
    }

    // ── Envío REAL por WhatsApp — SÓLO a números de la lista blanca (imperativo de seguridad) ──
    // Gate: hay número destino + plantilla lista (estado 'delivered') + número autorizado.
    // Sin dest_phone (ej. Avisos automáticos) NUNCA se envía: queda en el módulo.
    let envio = null;
    if (estado === "delivered" && destPhone) {
      const wl = await whitelist();
      if (!wl.includes(destPhone)) {
        estado = "held_no_whitelist";
      } else {
        envio = await enviarWhatsapp(destPhone, mensaje, pdfCombinado?.url ?? null);
        estado = envio.ok ? "sent_whatsapp" : "error_envio";
        mensaje.envio = { to: destPhone, ok: !!envio.ok, wamid: envio.wamid ?? null, error: envio.error ?? null };
        if (estado === "sent_whatsapp") {
          try { await g.from("wa_pipeline_log").insert({ event: "aviso_enviado", cuit, source: srcUsado, detalle: { grupo_key: grupoKey, n_facturas: facturas.length, dest: destPhone } }); } catch (_e) { /* log best-effort */ }
        }
      }
    }

    // Registrar en el módulo (siempre, para trazabilidad — enviado o no).
    const { error: inbErr } = await paginalk.from("wa_sim_inbox").insert({
      source: srcUsado, grupo_key: grupoKey, cuit, cod_cliente: cod,
      business_name: grupo.razon_social ?? "CLIENTE SIMULACIÓN", fecha,
      n_facturas: facturas.length, total_sum, metodo, estado, mensaje,
    });
    if (inbErr) {
      // Si NO se envió por WhatsApp, liberamos el claim para reintentar. Si ya se envió, no.
      if (estado !== "sent_whatsapp") await g.from("wa_grupo_listo").update({ enviado: false, enviado_at: null }).eq("grupo_key", grupoKey);
      return json({ error: "entrega inbox: " + inbErr.message }, 500);
    }

    return json({ ok: true, delivered: true, destino: destPhone ? "whatsapp" : modo, estado, grupo_key: grupoKey, multisource, source: srcUsado, n_facturas: facturas.length, dest_phone: destPhone || null, envio, mensaje });
  } catch (err) {
    console.error("lk_factura-check error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
