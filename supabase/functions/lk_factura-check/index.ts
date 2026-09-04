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
// Ventana de envío real: activo si HOY cae dentro de las 48h desde `wa_real_redirect_date`
// (ese día Y el siguiente). Reemplaza el guard de "solo el día exacto" para que un envío
// habilitado un día siga activo también al día siguiente. Sigue siendo por fecha (no toggle):
// si la fecha quedó vieja (>1 día), se apaga solo.
function dentroVentana(rDate: string, hoy: string): boolean {
  if (!rDate) return false;
  const base = new Date(rDate + "T00:00:00Z").getTime();
  const h = new Date(hoy + "T00:00:00Z").getTime();
  if (isNaN(base) || isNaN(h)) return false;
  const dias = (h - base) / 86400000;
  return dias >= 0 && dias <= 1; // rDate o rDate+1 (48h)
}
function fmtARS(n: number): string {
  // Sin decimales: se redondea el importe a pesos enteros (regla de negocio).
  return "$" + Math.round(Number(n || 0)).toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

// ── Estado de aprobación de la plantilla en Meta (no enviar si no está APPROVED) ──
const META_API = "https://graph.facebook.com/v21.0";
async function metaToken(): Promise<string> {
  return Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? Deno.env.get("WA_TOKEN") ?? (await getSetting("wa_token")) ?? "";
}
async function metaWaba(): Promise<string> {
  return Deno.env.get("WA_BUSINESS_ACCOUNT_ID") ?? (await getSetting("wa_business_account_id")) ?? "";
}
// Chequeo automático de estado de plantillas contra Meta. Cache con TTL corto (30s):
// evita repegarle a Meta dentro del mismo envío/ráfaga, pero refleja aprobaciones/pausas
// casi en tiempo real sin depender de reciclar la instancia warm.
let _tplStatus: Record<string, string> | null = null;
let _tplParams: Record<string, number> | null = null; // name → cantidad de {{n}} en el BODY
let _tplAt = 0;
const TPL_TTL_MS = 30_000;
// Trae de Meta el estado Y la cantidad de variables ({{n}}) del cuerpo de cada plantilla.
async function refreshTpls(): Promise<void> {
  if (_tplStatus && (Date.now() - _tplAt) <= TPL_TTL_MS) return;
  const st: Record<string, string> = {}, pc: Record<string, number> = {};
  let ok = false;
  try {
    const token = await metaToken(), waba = await metaWaba();
    if (token && waba) {
      const res = await fetch(`${META_API}/${waba}/message_templates?limit=200&fields=name,status,components`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      // deno-lint-ignore no-explicit-any
      for (const t of (data.data ?? [])) {
        st[t.name] = t.status;
        let max = 0;
        // deno-lint-ignore no-explicit-any
        for (const c of (t.components ?? [])) {
          if (c.type === "BODY" && typeof c.text === "string") {
            const re = /\{\{(\d+)\}\}/g; let m: RegExpExecArray | null;
            while ((m = re.exec(c.text)) !== null) { const i = parseInt(m[1], 10); if (i > max) max = i; }
          }
        }
        pc[t.name] = max;
      }
      ok = true;
    }
  } catch { /* si no se puede verificar, no bloquea */ }
  if (ok) { _tplStatus = st; _tplParams = pc; _tplAt = Date.now(); }
  else { if (!_tplStatus) _tplStatus = {}; if (!_tplParams) _tplParams = {}; }
}
async function tplStatus(name: string): Promise<string | null> {
  await refreshTpls(); return _tplStatus![name] ?? null;
}
async function tplParamCount(name: string): Promise<number | null> {
  await refreshTpls(); const v = _tplParams![name]; return (v === undefined) ? null : v;
}
// Cantidad de {{n}} esperada por formato/grupo, para autodetectar contra Meta.
function countV1(grupo: string, esMultiple: boolean): number { return grupo === "contado" ? (esMultiple ? 4 : 2) : (esMultiple ? 8 : 6); }
function countV2(grupo: string, esMultiple: boolean): number { return grupo === "contado" ? (esMultiple ? 7 : 5) : (esMultiple ? 11 : 9); }

// ── Lista blanca de envío (wa_envio_contactos). El bot SÓLO envía a estos números. ──
async function whitelist(): Promise<string[]> {
  const { data } = await paginalk.from("wa_envio_contactos").select("phone");
  return (data ?? []).map((r: { phone: string }) => r.phone);
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
// Los % de descuento y los plazos (etiqueta de días) son EDITABLES desde el Panel de
// Control (app_settings.wa_descuentos_config). Acá quedan los defaults de respaldo.
const DTO_DEFAULT: Record<string, number> = {
  contado: 0.25, credito_15_30: 0.20, credito_31_45: 0.15, credito_46_60: 0.10, echeq_90: 0.05, echeq_120: 0.00, no_decidido: 0.25,
};
const LABEL_DEFAULT: Record<string, string> = {
  credito_15_30: "15 a 30", credito_31_45: "31 a 45", credito_46_60: "46 a 60", echeq_90: "90", echeq_120: "120",
};
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
const SALUDO = "¡Hola! Tu pedido está listo y estará con vos a la brevedad.";
// Pie de pago (alias/CBU): EDITABLE desde el Panel, se completa como variable en la plantilla.
const PAGO_ALIAS_DEFAULT = "loeke.srl";
const PAGO_CBU_DEFAULT = "1910027855002702387450";
function pagoFooter(alias: string, cbu: string): string {
  return ["", "Datos para el pago:", `Alias: ${alias}`, `CBU: ${cbu}`].join("\n");
}

// Config de descuentos editable (Panel de Control → app_settings.wa_descuentos_config).
// Devuelve el dto de contado, los días para el vencimiento del pago contado, y un mapa
// metodo→{dto,label} para crédito/e-cheq. Si no hay config, usa los defaults de arriba.
interface DtoCfg {
  contadoDto: number; diasLimite: number;
  map: Record<string, { dto: number; label: string }>;
  // Excepciones por cliente: si el CUIT (solo dígitos) o la razón social (mayúsc/trim) está
  // acá, el bot fuerza ese método para sus facturas, ignorando la condición de venta.
  excCuit: Record<string, string>; excRazon: Record<string, string>;
  // Datos de pago editables (alias/CBU), se completan como variables en el pie.
  alias: string; cbu: string;
  // Formato de plantilla: 'v1' = estructura vieja (sin %/alias/CBU variables, footer fijo);
  // 'v2' = nueva (% y alias/CBU como variables). Debe coincidir con lo cargado en Meta.
  formato: string;
}
const normRazon = (s: string) => String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
async function loadDtoCfg(): Promise<DtoCfg> {
  // deno-lint-ignore no-explicit-any
  let cfg: any = null;
  const raw = await getSetting("wa_descuentos_config");
  if (raw) { try { cfg = JSON.parse(raw); } catch { /* usa defaults */ } }
  const contadoDto = Number(cfg?.contado?.dto ?? DTO_DEFAULT.contado);
  const diasLimite = Number(cfg?.contado?.dias_limite ?? 14);
  const map: Record<string, { dto: number; label: string }> = {};
  for (const r of (cfg?.credito ?? [])) if (r?.key) map[r.key] = { dto: Number(r.dto), label: String(r.label ?? LABEL_DEFAULT[r.key] ?? "") };
  for (const r of (cfg?.echeq ?? [])) if (r?.key) map[r.key] = { dto: Number(r.dto), label: String(r.label ?? LABEL_DEFAULT[r.key] ?? "") };
  const excCuit: Record<string, string> = {}, excRazon: Record<string, string> = {};
  const exc = cfg?.excepciones ?? {};
  for (const bandKey of Object.keys(exc)) {
    for (const it of (exc[bandKey] ?? [])) {
      if (!it?.valor) continue;
      if (it.tipo === "razon") excRazon[normRazon(it.valor)] = bandKey;
      else { const d = String(it.valor).replace(/\D/g, ""); if (d) excCuit[d] = bandKey; }
    }
  }
  const alias = String(cfg?.pago?.alias ?? PAGO_ALIAS_DEFAULT).trim() || PAGO_ALIAS_DEFAULT;
  const cbu = String(cfg?.pago?.cbu ?? PAGO_CBU_DEFAULT).trim() || PAGO_CBU_DEFAULT;
  const formato = ((await getSetting("wa_plantilla_formato")) || "auto").trim();
  return { contadoDto: Number.isFinite(contadoDto) ? contadoDto : 0.25, diasLimite: Number.isFinite(diasLimite) ? diasLimite : 14, map, excCuit, excRazon, alias, cbu, formato };
}
function dtoDeMetodo(metodo: string, cfg: DtoCfg): { dto: number; label: string } {
  const e = cfg.map[metodo];
  if (e && Number.isFinite(e.dto)) return { dto: e.dto, label: e.label || LABEL_DEFAULT[metodo] || "" };
  return { dto: DTO_DEFAULT[metodo] ?? cfg.contadoDto, label: LABEL_DEFAULT[metodo] || "" };
}
// Devuelve el método forzado para un cliente (por CUIT o razón social), o null si no hay excepción.
function metodoExcepcion(cfg: DtoCfg, cuit: string | null | undefined, razon: string | null | undefined): string | null {
  const d = String(cuit || "").replace(/\D/g, "");
  if (d && cfg.excCuit[d]) return cfg.excCuit[d];
  const r = normRazon(razon || "");
  if (r && cfg.excRazon[r]) return cfg.excRazon[r];
  return null;
}
// Fecha (DD/MM/YYYY) hasta la que se puede abonar al contado: fecha de factura + diasLimite.
function fechaLimiteContado(fechaISO: string, dias: number): string {
  const base = new Date((fechaISO || new Date().toISOString().slice(0, 10)) + "T00:00:00Z");
  if (isNaN(base.getTime())) return "";
  base.setUTCDate(base.getUTCDate() + (Number.isFinite(dias) ? dias : 14));
  const dd = String(base.getUTCDate()).padStart(2, "0");
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${base.getUTCFullYear()}`;
}
// Reconstrucción legible del mensaje (preview/auditoría). Debe respetar el ORDEN de params
// según el formato: v2 intercala el %dto y agrega alias/CBU; v1 no.
function textoLegible(grupo: string, esMultiple: boolean, p: string[], alias: string, cbu: string, v2: boolean): string {
  const sav2 = (f: string, a: string, c: string) => ["", `*Pagando hasta el ${f} podes ahorrarte ${a}.*`, `*Total Contado: ${c}*`];
  const sav1 = (f: string, a: string, c: string) => ["", `*Pagando hasta el ${f} podes ahorrarte ${a}.`, `Total Contado: ${c}*`];
  let cuerpo: string[];
  if (!esMultiple) {
    if (grupo === "contado") {
      cuerpo = v2
        ? [SALUDO, "", `Total de tu factura (con IVA): ${p[0]}`, "", `*Total a pagar Contado (${p[1]}% Dto): ${p[2]}*`]
        : [SALUDO, "", `Total de tu factura (con IVA): ${p[0]}`, "", `*Total a pagar Contado (25% Dto): ${p[1]}*`];
    } else if (grupo === "credito") {
      cuerpo = v2
        ? [SALUDO, "", `Total de tu factura (con IVA): ${p[0]}`, "", `*Con tu pago a ${p[1]} días abonás: ${p[2]} (${p[3]}% Dto)*`, ...sav2(p[4], p[5], p[6])]
        : [SALUDO, "", `Total de tu factura (con IVA): ${p[0]}`, "", `Con tu pago a ${p[1]} días abonás: ${p[2]}`, ...sav1(p[3], p[4], p[5])];
    } else {
      cuerpo = v2
        ? [SALUDO, "", `Total de tu factura (con IVA): ${p[0]}`, "", `*Con tu pago por e-cheq a ${p[1]} días abonás: ${p[2]} (${p[3]}% Dto)*`, "Recordá enviar el e-cheq al momento de recibir el pedido.", ...sav2(p[4], p[5], p[6])]
        : [SALUDO, "", `Total de tu factura (con IVA): ${p[0]}`, "", `Con tu pago por e-cheq a ${p[1]} días abonás: ${p[2]}`, "Recordá enviar el e-cheq al momento de recibir el pedido.", ...sav1(p[3], p[4], p[5])];
    }
  } else {
    const base = [SALUDO, "", `Total de tus facturas (con IVA): ${p[0]}, en ${p[1]} facturas.`, "", `Detalle por factura: ${p[2]}`, ""];
    if (grupo === "contado") {
      cuerpo = v2 ? [...base, `*Total a pagar Contado (${p[3]}% Dto): ${p[4]}*`] : [...base, `*Total a pagar Contado (25% Dto): ${p[3]}*`];
    } else if (grupo === "credito") {
      cuerpo = v2
        ? [...base, `*Con tu pago a ${p[3]} días abonás: ${p[4]} (${p[5]}% Dto)*`, ...sav2(p[6], p[7], p[8])]
        : [...base, `Con tu pago a ${p[3]} días abonás: ${p[4]}`, ...sav1(p[5], p[6], p[7])];
    } else {
      cuerpo = v2
        ? [...base, `*Con tu pago por e-cheq a ${p[3]} días abonás: ${p[4]} (${p[5]}% Dto)*`, "Recordá enviar el e-cheq al momento de recibir el pedido.", ...sav2(p[6], p[7], p[8])]
        : [...base, `Con tu pago por e-cheq a ${p[3]} días abonás: ${p[4]}`, "Recordá enviar el e-cheq al momento de recibir el pedido.", ...sav1(p[5], p[6], p[7])];
    }
  }
  return cuerpo.join("\n") + "\n" + pagoFooter(alias, cbu);
}
// deno-lint-ignore no-explicit-any
async function armarMensaje(metodo: string, facturas: any[], fecha: string, cfg: DtoCfg) {
  const grupo = grupoDe(metodo);
  const { dto, label } = dtoDeMetodo(metodo, cfg);
  const totales = facturas.map((f) => Number(f.total || 0));
  const total_sum = totales.reduce((s, t) => s + t, 0);
  const montoContado = total_sum * (1 - cfg.contadoDto);
  const montoCliente = total_sum * (1 - dto);
  const ahorro = montoCliente - montoContado;
  const fechaLimite = fechaLimiteContado(fecha, cfg.diasLimite);
  const n = facturas.length;
  const esMultiple = n > 1;
  const lista = totales.map((t) => fmtARS(t)).join(" / ");
  const template = esMultiple ? TPL[grupo].multi : TPL[grupo].single;
  // Formato: 'v1'/'v2' fuerza; 'auto' (default) lo detecta contando los {{n}} vivos en Meta.
  let v2: boolean;
  if (cfg.formato === "v2") v2 = true;
  else if (cfg.formato === "v1") v2 = false;
  else {
    const lc = await tplParamCount(template);
    v2 = (lc === countV2(grupo, esMultiple)) ? true
       : (lc === countV1(grupo, esMultiple)) ? false
       : (lc != null && lc >= countV2(grupo, esMultiple)); // desconocido/no leído → v1 (seguro)
  }
  const contadoPct = String(Math.round(cfg.contadoDto * 100)); // % de contado (editable)
  const metodoPct = String(Math.round(dto * 100));             // % del método/plazo (de la tabla)
  // v2 → Contado: {total, %dtoContado, totalContado}; Crédito/e-cheq: {total, plazoDías,
  //   montoCliente, %dto, fechaLímite, ahorro, totalContado}; al final {alias, cbu}.
  // v1 (Meta actual) → sin %dto ni alias/CBU (footer fijo): Contado {total, totalContado};
  //   Crédito/e-cheq {total, plazoDías, montoCliente, fechaLímite, ahorro, totalContado}.
  // En múltiple se intercalan {cantidad, detalle} tras el total.
  let params: string[];
  if (!esMultiple) {
    if (grupo === "contado") params = v2 ? [fmtARS(total_sum), contadoPct, fmtARS(montoContado)] : [fmtARS(total_sum), fmtARS(montoContado)];
    else params = v2
      ? [fmtARS(total_sum), label, fmtARS(montoCliente), metodoPct, fechaLimite, fmtARS(ahorro), fmtARS(montoContado)]
      : [fmtARS(total_sum), label, fmtARS(montoCliente), fechaLimite, fmtARS(ahorro), fmtARS(montoContado)];
  } else {
    const base = [fmtARS(total_sum), String(n), lista];
    if (grupo === "contado") params = v2 ? [...base, contadoPct, fmtARS(montoContado)] : [...base, fmtARS(montoContado)];
    else params = v2
      ? [...base, label, fmtARS(montoCliente), metodoPct, fechaLimite, fmtARS(ahorro), fmtARS(montoContado)]
      : [...base, label, fmtARS(montoCliente), fechaLimite, fmtARS(ahorro), fmtARS(montoContado)];
  }
  if (v2) params = [...params, cfg.alias, cfg.cbu]; // pie de pago (variables) sólo en v2
  return {
    template, language: "es_AR", metodo, grupo, n_facturas: n, multiple: esMultiple, formato: v2 ? "v2" : "v1",
    params, lista_facturas: lista, texto_legible: textoLegible(grupo, esMultiple, params, cfg.alias, cfg.cbu, v2),
    total_sum, total_fmt: fmtARS(total_sum),
    desglose: {
      total_civa: fmtARS(total_sum), dto_cliente: `${Math.round(dto * 100)}%`, plazo_dias: label || null,
      fecha_limite_contado: fechaLimite,
      monto_cliente: fmtARS(montoCliente), monto_contado: fmtARS(montoContado), ahorro_vs_contado: fmtARS(ahorro),
    },
  };
}

// ── Método mixto: reglas acordadas (ver docs/plantillas_whatsapp.md) ──
// A) Si en el grupo hay UN solo método real (≠ "no_decidido"), las facturas "no_decidido"
//    adoptan ese método → un solo mensaje con ese método (ej.: crédito + "prefiero no decir"
//    → todo crédito). Si no hay ningún método real, queda "no_decidido" (se trata como contado).
// B) Si hay >1 método real distinto, las "no_decidido" se ABSORBEN en un método ya presente
//    (nunca se inventa un grupo que no existía) y el grupo se PARTE en un mensaje por método:
//      - si "contado" está entre los reales → las "no_decidido" van a contado;
//      - si NO hay contado → van al método real con MENOR descuento (desempate: más facturas,
//        luego orden contado<crédito<echeq, luego nombre).
//    Cada sub-grupo lleva sus propias facturas y su propio PDF.
interface FacMin { total: number; metodo: string; storage_path?: string | null; comprobante_id?: string | null }
function ordenMetodo(m: string): number { return m === "contado" ? 0 : m.startsWith("credito") ? 1 : 2; }
// Elige el método real (de `reales`) que absorbe las "no_decidido" cuando no hay contado:
// menor descuento primero; empate → método con más facturas; luego orden; luego nombre.
function metodoAbsorbeNoDecidido(reales: string[], facturas: FacMin[], cfg: DtoCfg): string {
  const count: Record<string, number> = {};
  for (const f of facturas) { const m = f.metodo || "no_decidido"; if (m !== "no_decidido") count[m] = (count[m] ?? 0) + 1; }
  return reales.slice().sort((a, b) => {
    const da = dtoDeMetodo(a, cfg).dto, db = dtoDeMetodo(b, cfg).dto;
    if (da !== db) return da - db;                                         // menor descuento
    if ((count[b] ?? 0) !== (count[a] ?? 0)) return (count[b] ?? 0) - (count[a] ?? 0); // grupo más grande
    const oa = ordenMetodo(a), ob = ordenMetodo(b);
    if (oa !== ob) return oa - ob;                                         // contado<credito<echeq
    return a < b ? -1 : a > b ? 1 : 0;                                     // nombre (determinismo)
  })[0];
}
// Devuelve los sub-grupos a enviar. Con excepción por cliente (metodoForzado) NO se parte:
// un único sub-grupo con ese método para todas las facturas.
function planMetodos(facturas: FacMin[], cfg: DtoCfg, metodoForzado?: string | null): { metodo: string; facturas: FacMin[] }[] {
  const norm = (m: string) => m || "no_decidido";
  if (metodoForzado) return [{ metodo: metodoForzado, facturas }];
  const reales = Array.from(new Set(facturas.map((f) => norm(f.metodo)).filter((m) => m !== "no_decidido")));
  if (reales.length <= 1) {
    // Regla A: un solo mensaje; "no_decidido" adopta el único método real (o queda no_decidido→contado).
    return [{ metodo: reales[0] || "no_decidido", facturas }];
  }
  // Regla B: método que absorbe las "no_decidido" (contado si está; si no, el de menor descuento).
  const target = reales.includes("contado") ? "contado" : metodoAbsorbeNoDecidido(reales, facturas, cfg);
  const byMetodo = new Map<string, FacMin[]>();
  for (const f of facturas) {
    const nm = norm(f.metodo);
    const m = nm === "no_decidido" ? target : nm;
    (byMetodo.get(m) ?? byMetodo.set(m, []).get(m)!).push(f);
  }
  return Array.from(byMetodo.entries())
    .sort((a, b) => ordenMetodo(a[0]) - ordenMetodo(b[0]))
    .map(([metodo, facturas]) => ({ metodo, facturas }));
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
  if (!dentroVentana(rDate, hoy)) return json({ mode: "grupo", skipped: "fuera_de_ventana", rDate, hoy });
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
  const storagePaths = (body.storage_paths ?? []) as string[];
  const comprobantes = (body.comprobantes ?? []) as string[];
  const metodosFac = (body.metodos_fac ?? []) as string[];   // método por factura (si el emisor lo manda)
  const metodosDistinct = (body.metodos ?? []) as string[];  // set distinto (fallback)
  const cfg = await loadDtoCfg();
  const g = await gp();
  const total_sum = totales.reduce((s: number, t: number) => s + t, 0);

  // Plan de métodos (Reglas A/B). Con método por-factura (metodos_fac) se puede PARTIR por método;
  // con sólo el set distinto se aplica Regla A y, si hay >1 método real, se retiene (no se puede
  // partir con seguridad sin saber qué factura es de cada método).
  let subgrupos: { metodo: string; facturas: FacMin[] }[];
  let heldMixtoSinSplit = false;
  if (metodosFac.length === totales.length && totales.length > 0) {
    const facMin: FacMin[] = totales.map((t: number, i: number) => ({ total: Number(t || 0), metodo: metodosFac[i] || "no_decidido", storage_path: storagePaths[i] ?? null, comprobante_id: comprobantes[i] ?? null }));
    subgrupos = planMetodos(facMin, cfg);
  } else {
    const facMin: FacMin[] = totales.map((t: number, i: number) => ({ total: Number(t || 0), metodo: "no_decidido", storage_path: storagePaths[i] ?? null, comprobante_id: comprobantes[i] ?? null }));
    const reales = Array.from(new Set(metodosDistinct.map((m) => m || "no_decidido").filter((m) => m !== "no_decidido")));
    if (reales.length <= 1) subgrupos = [{ metodo: reales[0] || "no_decidido", facturas: facMin }];
    else { subgrupos = []; heldMixtoSinSplit = true; }
  }

  // >1 método real sin poder partir → retener para revisión (no se envía).
  if (heldMixtoSinSplit) {
    await paginalk.from("wa_shadow_log").upsert({
      group_key: gk, empresa, cod_cliente: body.cod_cliente ?? null, dia: body.dia ?? null,
      n_facturas: totales.length, estado: "held_metodo_mixto", wamid: null, total_sum, redirect_to: redirect, mensaje: null,
    }, { onConflict: "group_key" });
    return json({ mode: "grupo", group_key: gk, estado: "held_metodo_mixto", n_facturas: totales.length, redirect_to: redirect });
  }

  const multiMetodo = subgrupos.length > 1;
  const entregas: unknown[] = [];
  for (const sub of subgrupos) {
    const sgKey = multiMetodo ? `${gk}|${sub.metodo}` : gk;
    const sub_total = sub.facturas.reduce((s, f) => s + Number(f.total || 0), 0);
    let estado = "delivered";
    // deno-lint-ignore no-explicit-any
    const mensaje: any = await armarMensaje(sub.metodo, sub.facturas, String(body.dia ?? hoy), cfg);
    const st = await tplStatus(mensaje.template);
    mensaje.tpl_status = st;
    if (st && st !== "APPROVED") estado = "held_tpl_no_aprobada";
    mensaje.real_group = { group_key: sgKey, cod_cliente: body.cod_cliente ?? null, comprobantes: sub.facturas.map((f) => f.comprobante_id).filter(Boolean) };
    if (multiMetodo) mensaje.split_metodo = { metodo: sub.metodo, n_sub: subgrupos.length };

    const pdf = await combinarPaths(g, source, sub.facturas.map((f) => f.storage_path).filter(Boolean) as string[], sgKey.replace(/[^0-9a-zA-Z]+/g, "_"));
    mensaje.pdf_combinado = pdf ? { path: pdf.path, n: pdf.n, ok: !!pdf.url } : null;

    let envio = null;
    if (estado === "delivered") {
      envio = await enviarWhatsapp(redirect, mensaje, pdf?.url ?? null);
      estado = envio.ok ? "sent_whatsapp" : "error_envio";
      mensaje.envio = { to: redirect, ok: !!envio.ok, wamid: envio.wamid ?? null, error: envio.error ?? null };
      if (estado === "sent_whatsapp") {
        try { await g.from("wa_pipeline_log").insert({ event: "aviso_enviado", comprobante: sub.facturas[0]?.comprobante_id ?? null, source, detalle: { group_key: sgKey, n_facturas: sub.facturas.length, cod_cliente: body.cod_cliente ?? null, metodo: sub.metodo, real: true, redirect: true } }); } catch (_e) { /* log best-effort */ }
      }
    }
    await paginalk.from("wa_shadow_log").upsert({
      group_key: sgKey, empresa, cod_cliente: body.cod_cliente ?? null, dia: body.dia ?? null,
      n_facturas: sub.facturas.length, estado, wamid: envio?.wamid ?? null, total_sum: sub_total, redirect_to: redirect, mensaje,
    }, { onConflict: "group_key" });
    entregas.push({ group_key: sgKey, metodo: sub.metodo, estado, n_facturas: sub.facturas.length, template: mensaje.template, envio });
  }

  return json({ mode: "grupo", group_key: gk, split_metodo: multiMetodo, entregas, redirect_to: redirect });
}

// ── Camino REAL event-driven: cada factura que impacta hoy → identifica factura↔NP y agrupa
// las facturas del día del cliente POR DIRECCIÓN (cliente+destino = una entrega). Envía una
// entrega por dirección al número de redirección (Thomy). Ancla = día. Off salvo config de
// HOY + lista blanca. Idempotente por (cuit, destino, día); reenvía sólo si crece la cantidad.
// deno-lint-ignore no-explicit-any
async function handleRealRedirect(g: any, cuit: string, fecha: string) {
  const raw = (await getSetting("wa_real_redirect_to")) || "";
  const rDate = (await getSetting("wa_real_redirect_date")) || "";
  const hoy = new Date().toISOString().slice(0, 10);
  if (!raw || !dentroVentana(rDate, hoy)) return json({ skipped: "dormant_real", cuit });
  if (fecha !== hoy) return json({ skipped: "no_es_hoy", cuit, fecha });
  // Puede haber varios destinos (coma-separados). Sólo los que estén en la lista blanca.
  const wl = await whitelist();
  const redirects = raw.split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean).filter((p) => wl.includes(p));
  if (!redirects.length) return json({ skipped: "redirect_no_whitelist", cuit });

  // Grupos del día por EMPRESA + DIRECCIÓN (LK y CH nunca juntas).
  const { data: grupos } = await g.rpc("wa_grupos_dia_cuit", { p_cuit: cuit, p_fecha: fecha });
  if (!grupos || !grupos.length) return json({ pendiente: true, cuit, note: "sin facturas matcheadas a NP/dirección hoy" });

  const cfg = await loadDtoCfg();
  const out = [];
  for (const gr of grupos) {
    const destino = gr.destino || "(s/dir)";
    const source = gr.empresa === "chef" ? "ch" : "lk";
    const totales = (gr.totales ?? []) as number[];
    const storagePaths = (gr.storage_paths ?? []) as string[];
    const comprobantes = (gr.comprobantes ?? []) as string[];
    // Método por factura (alineado con totales/paths/comprobantes por comprobante_id).
    const metodosFac = (gr.metodos_fac ?? gr.metodos ?? []) as string[];
    const facMin: FacMin[] = totales.map((t, i) => ({
      total: Number(t || 0), metodo: metodosFac[i] || metodosFac[0] || "no_decidido",
      storage_path: storagePaths[i] ?? null, comprobante_id: comprobantes[i] ?? null,
    }));
    // Excepción por cliente: fuerza el método (ignora la condición de venta / método mixto).
    const ov = metodoExcepcion(cfg, cuit, gr.razon_social);
    const subgrupos = planMetodos(facMin, cfg, ov);
    const multiMetodo = subgrupos.length > 1;

    // Cada sub-grupo (por método) se arma UNA vez y se entrega a cada destino.
    for (const sub of subgrupos) {
      const sub_total = sub.facturas.reduce((s, f) => s + Number(f.total || 0), 0);
      const sub_comprob = sub.facturas.map((f) => f.comprobante_id).filter(Boolean);
      let estado0 = "delivered";
      // deno-lint-ignore no-explicit-any
      const base: any = await armarMensaje(sub.metodo, sub.facturas, fecha, cfg);
      const st = await tplStatus(base.template);
      base.tpl_status = st;
      if (st && st !== "APPROVED") estado0 = "held_tpl_no_aprobada";
      base.real_group = { cuit, empresa: gr.empresa, destino, cod_cliente: gr.cod_cliente ?? null, razon_social: gr.razon_social ?? null, comprobantes: sub_comprob };
      if (multiMetodo) base.split_metodo = { metodo: sub.metodo, n_sub: subgrupos.length };
      // PDF combinado: SÓLO las facturas de este sub-grupo (un PDF por método).
      const pdf = await combinarPaths(g, source, sub.facturas.map((f) => f.storage_path).filter(Boolean) as string[], `${cuit}|${gr.empresa}|${destino}|${fecha}|${sub.metodo}`.replace(/[^0-9a-zA-Z]+/g, "_"));
      base.pdf_combinado = pdf ? { path: pdf.path, n: pdf.n, ok: !!pdf.url } : null;

      // Se entrega a cada destino (Thomy, Luis, …). Idempotente por (grupo, método, destino).
      for (const to of redirects) {
        const gk = multiMetodo
          ? `real|${cuit}|${gr.empresa}|${destino}|${fecha}|${to}|${sub.metodo}`
          : `real|${cuit}|${gr.empresa}|${destino}|${fecha}|${to}`;
        const { data: prev } = await paginalk.from("wa_shadow_log").select("estado,n_facturas").eq("group_key", gk).maybeSingle();
        if (prev && prev.estado === "sent_whatsapp" && (prev.n_facturas ?? 0) >= sub.facturas.length) { out.push({ empresa: gr.empresa, destino, to, metodo: sub.metodo, skipped: "ya_enviado" }); continue; }
        let estado = estado0;
        const mensaje = { ...base };
        let envio = null;
        if (estado === "delivered") {
          envio = await enviarWhatsapp(to, mensaje, pdf?.url ?? null);
          estado = envio.ok ? "sent_whatsapp" : "error_envio";
          mensaje.envio = { to, ok: !!envio.ok, wamid: envio.wamid ?? null, error: envio.error ?? null };
          if (estado === "sent_whatsapp") {
            try { await g.from("wa_pipeline_log").insert({ event: "aviso_enviado", cuit, source, detalle: { empresa: gr.empresa, destino, to, n_facturas: sub.facturas.length, metodo: sub.metodo, real: true, redirect: true } }); } catch (_e) { /* best-effort */ }
          }
        }
        await paginalk.from("wa_shadow_log").upsert({
          group_key: gk, empresa: gr.empresa ?? source, cod_cliente: gr.cod_cliente ?? null, dia: fecha,
          n_facturas: sub.facturas.length, estado, wamid: envio?.wamid ?? null, total_sum: sub_total, redirect_to: to, mensaje,
        }, { onConflict: "group_key" });
        out.push({ empresa: gr.empresa, destino, to, metodo: sub.metodo, estado, n_facturas: sub.facturas.length, template: base.template });
      }
    }
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
    let cod = "", direccion = "", destPhone = "";
    {
      const { data: ctrl } = await g.from("wa_sim_control").select("*").eq("cuit", cuit).eq("fecha", fecha).maybeSingle();
      if (!ctrl) return json({ skipped: "sin_control", cuit });
      cod = ctrl.cod_cliente; direccion = ctrl.direccion; destPhone = ctrl.dest_phone || "";
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

    const cfg = await loadDtoCfg();
    // Excepción por cliente: fuerza el método (ignora condición de venta / método mixto).
    const ov = metodoExcepcion(cfg, cuit, grupo.razon_social);
    const total_sum = facturas.reduce((s: number, f: Record<string, unknown>) => s + Number(f.total || 0), 0);

    // Multisource (lk+ch en el mismo grupo): no se envía, queda para revisión humana.
    if (multisource) {
      const { error: inbErr } = await paginalk.from("wa_sim_inbox").insert({
        source: srcUsado, grupo_key: grupoKey, cuit, cod_cliente: cod,
        business_name: grupo.razon_social ?? "CLIENTE SIMULACIÓN", fecha,
        n_facturas: facturas.length, total_sum, metodo: (facturas[0]?.metodo as string) || "no_decidido",
        estado: "held_multisource", mensaje: null,
      });
      if (inbErr) {
        await g.from("wa_grupo_listo").update({ enviado: false, enviado_at: null }).eq("grupo_key", grupoKey);
        return json({ error: "entrega inbox: " + inbErr.message }, 500);
      }
      return json({ ok: true, delivered: true, destino: modo, estado: "held_multisource", grupo_key: grupoKey, multisource, source: srcUsado, n_facturas: facturas.length });
    }

    // Plan de métodos (Reglas A/B): "no_decidido" adopta el método real presente, o se parte
    // en un mensaje por método cuando hay >1 método real distinto.
    const facMin: FacMin[] = facturas.map((f: Record<string, unknown>) => ({
      total: Number(f.total || 0), metodo: String(f.metodo || "no_decidido"),
      storage_path: (f.storage_path as string) ?? null, comprobante_id: (f.comprobante_id as string) ?? null,
    }));
    const subgrupos = planMetodos(facMin, cfg, ov);
    const multiMetodo = subgrupos.length > 1;

    let wl: string[] | null = null;
    let anySent = false;
    const entregas: unknown[] = [];
    for (const sub of subgrupos) {
      const sgKey = multiMetodo ? `${grupoKey}|${sub.metodo}` : grupoKey;
      const sub_total = sub.facturas.reduce((s, f) => s + Number(f.total || 0), 0);
      let estado = "delivered";
      // deno-lint-ignore no-explicit-any
      const mensaje: any = await armarMensaje(sub.metodo, sub.facturas, fecha, cfg);
      const st = await tplStatus(mensaje.template);
      mensaje.tpl_status = st;
      if (st && st !== "APPROVED") estado = "held_tpl_no_aprobada";
      if (multiMetodo) mensaje.split_metodo = { metodo: sub.metodo, de_grupo: grupoKey, n_sub: subgrupos.length };

      // PDF combinado: SÓLO las facturas de este sub-grupo (un PDF por método).
      const pdf = await combinarPaths(g, srcUsado, sub.facturas.map((f) => f.storage_path).filter(Boolean) as string[], `${grupoKey}|${sub.metodo}`.replace(/[^0-9a-zA-Z]+/g, "_"));
      mensaje.pdf_combinado = pdf ? { path: pdf.path, n: pdf.n, ok: !!pdf.url } : null;

      // ── Envío REAL por WhatsApp — SÓLO a números de la lista blanca (imperativo de seguridad) ──
      // Sin dest_phone (ej. Avisos automáticos) NUNCA se envía: queda en el módulo.
      let envio = null;
      if (estado === "delivered" && destPhone) {
        if (wl === null) wl = await whitelist();
        if (!wl.includes(destPhone)) estado = "held_no_whitelist";
        else {
          envio = await enviarWhatsapp(destPhone, mensaje, pdf?.url ?? null);
          estado = envio.ok ? "sent_whatsapp" : "error_envio";
          mensaje.envio = { to: destPhone, ok: !!envio.ok, wamid: envio.wamid ?? null, error: envio.error ?? null };
          if (estado === "sent_whatsapp") {
            anySent = true;
            try { await g.from("wa_pipeline_log").insert({ event: "aviso_enviado", cuit, source: srcUsado, detalle: { grupo_key: sgKey, n_facturas: sub.facturas.length, dest: destPhone, metodo: sub.metodo } }); } catch (_e) { /* log best-effort */ }
          }
        }
      }

      // Registrar en el módulo (siempre, para trazabilidad — enviado o no).
      const { error: inbErr } = await paginalk.from("wa_sim_inbox").insert({
        source: srcUsado, grupo_key: sgKey, cuit, cod_cliente: cod,
        business_name: grupo.razon_social ?? "CLIENTE SIMULACIÓN", fecha,
        n_facturas: sub.facturas.length, total_sum: sub_total, metodo: sub.metodo, estado, mensaje,
      });
      if (inbErr) {
        // Liberamos el claim para reintentar SÓLO si todavía no se envió nada del grupo.
        if (!anySent) await g.from("wa_grupo_listo").update({ enviado: false, enviado_at: null }).eq("grupo_key", grupoKey);
        return json({ error: "entrega inbox: " + inbErr.message }, 500);
      }
      entregas.push({ grupo_key: sgKey, metodo: sub.metodo, estado, n_facturas: sub.facturas.length, template: mensaje.template, envio });
    }

    return json({ ok: true, delivered: true, destino: destPhone ? "whatsapp" : modo, grupo_key: grupoKey, multisource, source: srcUsado, n_facturas: facturas.length, dest_phone: destPhone || null, split_metodo: multiMetodo, entregas });
  } catch (err) {
    console.error("lk_factura-check error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
