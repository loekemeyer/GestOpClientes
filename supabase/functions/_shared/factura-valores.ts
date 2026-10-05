// factura-valores — las cuentas del aviso de factura (funciones puras, sin red). Las usan lk_factura-check (el aviso real)
// y lk_bot-simular (la botonera del Simulador), así el Simulador muestra exactamente lo que mandaría el aviso.
// Movidas sin cambios desde lk_factura-check (Pablo Olejavetzky, 05/10): el Simulador mandaba las 6 plantillas de factura
// con los valores de ejemplo ("$352.874") aunque el cliente tuviera facturas reales.

// ── Lógica de descuento/plantilla (guía docs/plantillas_whatsapp.md) ──
// Los % de descuento y los plazos (etiqueta de días) son EDITABLES desde el Panel de
// Control (app_settings.wa_descuentos_config). Acá quedan los defaults de respaldo.
export const DTO_DEFAULT: Record<string, number> = {
  contado: 0.25, credito_15_30: 0.20, credito_31_45: 0.15, credito_46_60: 0.10, echeq_90: 0.05, echeq_120: 0.00, no_decidido: 0.25,
};
export const LABEL_DEFAULT: Record<string, string> = {
  credito_15_30: "15 a 30", credito_31_45: "31 a 45", credito_46_60: "46 a 60", echeq_90: "90", echeq_120: "120",
};
export const TPL: Record<string, { single: string; multi: string }> = {
  contado: { single: "pedido_contado_s", multi: "pedido_contado_p" },
  credito: { single: "pedido_credito_s", multi: "pedido_credito_p" },
  echeq:   { single: "pedido_echeq_s",   multi: "pedido_echeq_p" },
};
export function grupoDe(m: string): "contado" | "credito" | "echeq" {
  if ((m || "").startsWith("credito")) return "credito";
  if ((m || "").startsWith("echeq")) return "echeq";
  return "contado";
}
const PAGO_ALIAS_DEFAULT = "loeke.srl";
const PAGO_CBU_DEFAULT = "1910027855002702387450";

export function fmtARS(n: number): string {
  // Sin decimales: se redondea el importe a pesos enteros (regla de negocio).
  return "$" + Math.round(Number(n || 0)).toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

// Config de descuentos editable (Panel de Control → app_settings.wa_descuentos_config).
// Devuelve el dto de contado, los días para el vencimiento del pago contado, y un mapa
// metodo→{dto,label} para crédito/e-cheq. Si no hay config, usa los defaults de arriba.
export interface DtoCfg {
  contadoDto: number; diasLimite: number;
  map: Record<string, { dto: number; label: string }>;
  // Excepciones por cliente: si el CUIT (solo dígitos) o la razón social (mayúsc/trim) está
  // acá, el bot fuerza ese método para sus facturas, ignorando la condición de venta.
  excCuit: Record<string, string>; excRazon: Record<string, string>;
  // Datos de pago editables (alias/CBU), se completan como variables en el pie.
  alias: string; cbu: string;
  // Pablo, 01/10: Chef sin CBU cargado en la ficha Empresas → el aviso se retiene (nunca el alias de Loekemeyer).
  sinDatosPago: boolean;
  // Factura de Chef: usa sus propias plantillas (pedido_*_chef, sin alias) y se retiene hasta que la suya esté APPROVED.
  esChef: boolean;
  // Formato de plantilla: 'v1' = estructura vieja (sin %/alias/CBU variables, footer fijo);
  // 'v2' = nueva (% y alias/CBU como variables). Debe coincidir con lo cargado en Meta.
  formato: string;
}
const normRazon = (s: string) => String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
/** DtoCfg a partir de wa_descuentos_config ya parseado (null = defaults) y de wa_plantilla_formato. */
// deno-lint-ignore no-explicit-any
export function armarDtoCfg(cfgRaw: any, empresa = "lk", formatoRaw: string | null = null): DtoCfg {
  let cfg = cfgRaw;
  // Pablo, 01/10 (ficha Empresas): las facturas de Chef usan los datos de pago de Chef y, si Chef tiene descuentos propios,
  // su tabla. Las excepciones por cliente siguen siendo las de la config general.
  const esChef = empresa === "chef" || empresa === "ch";
  const chef = cfg?.empresas?.chef ?? {};
  const dtoChef = esChef && chef.descuentos_propios === true && chef.descuentos ? chef.descuentos : null;
  if (dtoChef) cfg = { ...cfg, contado: dtoChef.contado ?? cfg?.contado, credito: dtoChef.credito ?? cfg?.credito, echeq: dtoChef.echeq ?? cfg?.echeq };
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
  // Pablo, 01/10: Chef no tiene alias (sólo CBU, Santander) y manda con sus propias plantillas (sin línea de alias).
  // Sin CBU de Chef cargado, el aviso se retiene.
  const alias = esChef ? String(chef.alias ?? "").trim() : (String(cfg?.pago?.alias ?? PAGO_ALIAS_DEFAULT).trim() || PAGO_ALIAS_DEFAULT);
  const cbu = esChef ? String(chef.cbu ?? "").trim() : (String(cfg?.pago?.cbu ?? PAGO_CBU_DEFAULT).trim() || PAGO_CBU_DEFAULT);
  const formato = (formatoRaw || "auto").trim();
  return { contadoDto: Number.isFinite(contadoDto) ? contadoDto : 0.25, diasLimite: Number.isFinite(diasLimite) ? diasLimite : 14, map, excCuit, excRazon, alias, cbu,
    sinDatosPago: esChef && !cbu, esChef, formato };
}
export function dtoDeMetodo(metodo: string, cfg: DtoCfg): { dto: number; label: string } {
  const e = cfg.map[metodo];
  if (e && Number.isFinite(e.dto)) return { dto: e.dto, label: e.label || LABEL_DEFAULT[metodo] || "" };
  return { dto: DTO_DEFAULT[metodo] ?? cfg.contadoDto, label: LABEL_DEFAULT[metodo] || "" };
}
// Devuelve el método forzado para un cliente (por CUIT o razón social), o null si no hay excepción.
export function metodoExcepcion(cfg: DtoCfg, cuit: string | null | undefined, razon: string | null | undefined): string | null {
  const d = String(cuit || "").replace(/\D/g, "");
  if (d && cfg.excCuit[d]) return cfg.excCuit[d];
  const r = normRazon(razon || "");
  if (r && cfg.excRazon[r]) return cfg.excRazon[r];
  return null;
}
// Fechas de los descuentos (Pablo, 30/09): días CORRIDOS desde la fecha de la factura y, si caen sábado, domingo o
// feriado, pasan al próximo día hábil (wa_proximo_habil: dias_habiles_cache con los feriados). Salen dd/mm, sin año.
export const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export function sumarDias(fechaISO: string, dias: number): string | null {
  const base = new Date((fechaISO || new Date().toISOString().slice(0, 10)) + "T00:00:00Z");
  if (!Number.isFinite(dias) || isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}
/** Días del plazo: el ÚLTIMO número de la etiqueta ("120" → 120; "31 a 45" → 45, hasta cuando vale ese descuento), o los
 *  dígitos de la clave (echeq_120). null si no hay número. */
export function diasDelPlazo(label: string, metodo: string): number | null {
  const nums = (String(label || "").match(/\d+/g) ?? String(metodo).match(/\d+/g) ?? []).map(Number);
  return nums.length ? Math.max(...nums) : null;
}

// Pablo, 29-30/09: el orden de las variables sigue al texto de la plantilla ACTIVA en Meta (formato nuevo: lo que paga
// arriba, el detalle antes del total). Cada {{n}} se reconoce por el texto que lo rodea, así una versión nueva con otro
// orden funciona sola el día que se promueve. Si alguna variable no se reconoce → null (orden fijo de siempre).
export interface ValoresFactura {
  total: string; n: string; lista: string; plazo: string; pct: string; montoCliente: string; montoContado: string;
  fecha: string; ahorro: string; alias: string; cbu: string;
  /** Fecha del plazo = fecha de la factura + último día del plazo (e-cheq: días del cheque; crédito "31 a 45" → 45). */
  fechaPlazo: string;
}
export function mapearPorTexto(body: string, v: ValoresFactura, grupo: string): string[] | null {
  const vars = [...body.matchAll(/\{\{(\d+)\}\}/g)];
  if (!vars.length) return null;
  const porNumero: Record<number, string> = {};
  for (const m of vars) {
    const i = m.index ?? 0;
    const linea = body.slice(body.lastIndexOf("\n", i - 1) + 1, i).replace(/[\s*]+$/, "");
    const despues = body.slice(i + m[0].length).replace(/^[\s*]+/, "");
    let val: string | null = null;
    if (/^%/.test(despues)) val = v.pct;
    else if (/^d[ií]as/i.test(despues)) val = v.plazo;
    else if (/^facturas/i.test(despues)) val = v.n;
    else if (/Alias:$/i.test(linea)) val = v.alias;
    else if (/CBU:$/i.test(linea)) val = v.cbu;
    else if (/\(con IVA\):$/i.test(linea)) val = v.total;
    else if (/Detalle por factura:$/i.test(linea)) val = v.lista;
    else if (/hasta el$/i.test(linea)) val = v.fecha;
    else if (/(pagar|Echeq) al$/i.test(linea)) val = v.fechaPlazo;
    else if (/ahorrarte$/i.test(linea)) val = v.ahorro;
    else if (/Total Contado:$/i.test(linea)) val = v.montoContado;
    else if (/abon[aá]s:?$/i.test(linea)) val = v.montoCliente;
    else if (grupo === "contado" && /Dto\)\*?:$/i.test(linea)) val = v.montoContado;
    if (val === null) return null;
    porNumero[Number(m[1])] = val;
  }
  const max = Math.max(...Object.keys(porNumero).map(Number));
  const out: string[] = [];
  for (let k = 1; k <= max; k++) { if (porNumero[k] === undefined) return null; out.push(porNumero[k]); }
  return out;
}

/** Las cuentas de un mensaje de factura: totales, montos con descuento, plantilla (una o varias facturas; Chef). */
export function cuentasFactura(metodo: string, totales: number[], cfg: DtoCfg) {
  const grupo = grupoDe(metodo);
  const { dto, label } = dtoDeMetodo(metodo, cfg);
  const total_sum = totales.reduce((s, t) => s + t, 0);
  const montoContado = total_sum * (1 - cfg.contadoDto);
  const montoCliente = total_sum * (1 - dto);
  const ahorro = montoCliente - montoContado;
  const n = totales.length;
  const esMultiple = n > 1;
  const lista = totales.map((t) => fmtARS(t)).join(" / ");
  // Chef: su propia plantilla (pedido_contado_s → pedido_contado_s_chef), sin alias.
  const template = (esMultiple ? TPL[grupo].multi : TPL[grupo].single) + (cfg.esChef ? "_chef" : "");
  const contadoPct = String(Math.round(cfg.contadoDto * 100)); // % de contado (editable)
  const metodoPct = String(Math.round(dto * 100));             // % del método/plazo (de la tabla)
  return { grupo, dto, label, total_sum, montoContado, montoCliente, ahorro, n, esMultiple, lista, template, contadoPct, metodoPct };
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
export interface FacMin { total: number; metodo: string; storage_path?: string | null; comprobante_id?: string | null }
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
export function planMetodos(facturas: FacMin[], cfg: DtoCfg, metodoForzado?: string | null): { metodo: string; facturas: FacMin[] }[] {
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
