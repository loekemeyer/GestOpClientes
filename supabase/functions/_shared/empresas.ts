// Datos por empresa — Loekemeyer y Chef (Pablo, 01/10: ficha "Empresas" de Configuración › Pagos).
//
// Todo vive en app_settings.wa_descuentos_config (la misma config que edita el Panel):
//   · Loekemeyer: alias/CBU en `pago` (como siempre) y el resto en `empresas.lk`.
//   · Chef: todo en `empresas.chef` (alias, CBU, razón social, CUIT, web, Cobranzas y, si tiene, sus descuentos).
// Un dato de Chef vacío NUNCA cae al de Loekemeyer: los datos de pago de una empresa no se dan para la otra.
//
// ⚠ La empresa se define POR FACTURA, no por cliente, y el cruce con Chef es por CUIT, nunca por código:
// medido el 01/10, el mismo cod_cliente es otro cliente en cada empresa (el 2444 es Relca en LK y Cencosud en Chef),
// y 15 de los 28 deudores de Chef también son clientes de LK con otro código.
import { getGestionClient, getSetting, supabase } from "./supabase.ts";

export type Empresa = "lk" | "chef";
export type DatosEmpresa = {
  nombre: string; razon_social: string; cuit: string; alias: string; cbu: string; web: string; cobranzas: string;
};

const LK_ALIAS = "loeke.srl";
const LK_CBU = "1910027855002702387450";

// deno-lint-ignore no-explicit-any
const txt = (v: any) => String(v ?? "").trim();

export async function datosEmpresas(): Promise<Record<Empresa, DatosEmpresa>> {
  // deno-lint-ignore no-explicit-any
  let cfg: any = null;
  try { cfg = JSON.parse((await getSetting("wa_descuentos_config")) ?? "null"); } catch { cfg = null; }
  const lk = cfg?.empresas?.lk ?? {}, ch = cfg?.empresas?.chef ?? {};
  return {
    lk: {
      nombre: "Loekemeyer", razon_social: txt(lk.razon_social), cuit: txt(lk.cuit),
      alias: txt(cfg?.pago?.alias) || LK_ALIAS, cbu: txt(cfg?.pago?.cbu) || LK_CBU,
      web: txt(lk.web) || "loekemeyer.com", cobranzas: txt(lk.cobranzas),
    },
    chef: {
      nombre: "Chef", razon_social: txt(ch.razon_social), cuit: txt(ch.cuit),
      alias: txt(ch.alias), cbu: txt(ch.cbu), web: txt(ch.web) || "chefsrl.com", cobranzas: txt(ch.cobranzas),
    },
  };
}

/** CUIT en 11 dígitos, o "" si no sirve para cruzar (vacío, mal formado o genérico de exterior 55000000xxx). */
export function cuitNorm(c: unknown): string {
  const d = String(c ?? "").replace(/\D/g, "");
  return d.length === 11 && !d.startsWith("55000000") ? d : "";
}

/**
 * Texto con los datos para transferir a una empresa; si Chef no tiene alias/CBU cargados, no inventa ni usa los de LK.
 * Pablo, 01/10: Chef no tiene alias (Cobranzas de Chef pasa CBU, titular y CUIT): la línea que falta no se muestra, y con
 * la razón social y el CUIT cargados va el titular, que es lo que el cliente valida al transferir por CBU.
 */
export function textoDatosPago(e: DatosEmpresa, conNombre: boolean): string | null {
  if (!e.alias && !e.cbu) return null;
  const cab = conNombre ? `Para las facturas de *${e.razon_social || e.nombre}*:\n` : "";
  const lineas = [
    ...(e.alias ? [`*Alias:* ${e.alias}`] : []),
    ...(e.cbu ? [`*CBU:* ${e.cbu}`] : []),
    ...(e.razon_social && e.cuit ? [`*Titular:* ${e.razon_social} (CUIT ${e.cuit.replace(/^(\d{2})(\d{8})(\d)$/, "$1-$2-$3")})`] : []),
  ];
  return cab + lineas.join("\n");
}

/** Códigos de cliente de Chef de un CUIT (chef_padron vía bot_cuentas, sql/115): un CUIT puede tener más de una cuenta. */
export async function codigosChef(cuit: unknown): Promise<string[]> {
  const c = cuitNorm(cuit);
  if (!c) return [];
  const { data, error } = await supabase.from("bot_cuentas").select("cod_cliente").eq("empresa", "CH").eq("cuit", c);
  if (error) console.error("codigosChef:", error.message);
  return ((data ?? []) as Array<{ cod_cliente: string }>).map((r) => String(r.cod_cliente));
}

export type FacturaDoc = {
  empresa: "lk" | "chef"; numero: string; punto_venta: string; letra: string | null; fecha: string; total: number;
  storage_path: string | null;
};

/**
 * Facturas de Chef de un CUIT (isis_ch.documentos de Gestión, PDF en el bucket isis-ch), más nueva primero. Sólo las
 * emitidas a clientes (contraparte_tipo = 'cliente'): "FC Compra" son facturas de proveedores. null = no se pudo leer.
 */
export async function facturasChef(cuit: unknown, desde?: string): Promise<FacturaDoc[] | null> {
  const c = cuitNorm(cuit);
  if (!c) return [];
  try {
    const g = await getGestionClient("isis_ch");
    let q = g.from("documentos").select("numero, punto_venta, letra, fecha, total, storage_path")
      .in("contraparte_cuit", [c, `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`])
      .eq("contraparte_tipo", "cliente").like("tipo", "FC%");
    if (desde) q = q.gte("fecha", desde);
    const { data, error } = await q.order("fecha", { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<Omit<FacturaDoc, "empresa">>).map((d) => ({ ...d, empresa: "chef" as const }));
  } catch (e) {
    console.error("facturasChef:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Facturas impagas de Chef de un cliente, cruzadas por CUIT (GV_Cobranza_Deuda_Viva). null = no se pudo leer. */
export async function deudaChefPorCuit(cuit: unknown): Promise<Array<Record<string, unknown>> | null> {
  const c = cuitNorm(cuit);
  if (!c) return [];
  try {
    const g = await getGestionClient("public");
    const r = await Promise.race([
      // El CUIT se guarda en dígitos; por las dudas también se busca con guiones.
      g.from("GV_Cobranza_Deuda_Viva").select("comprobante, fecha, vence, condicion, dto_cond, lista, pendiente, cuit")
        .eq("empresa", "chef").gt("pendiente", 0).in("cuit", [c, `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`])
        .order("fecha", { ascending: true }).limit(60),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
    ]);
    if (r.error) throw new Error(r.error.message);
    return ((r.data ?? []) as Array<Record<string, unknown>>).filter((f) => cuitNorm(f.cuit) === c);
  } catch (e) {
    console.error("deudaChefPorCuit:", e instanceof Error ? e.message : e);
    return null;
  }
}
