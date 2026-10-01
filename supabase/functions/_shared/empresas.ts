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
import { getGestionClient, getSetting } from "./supabase.ts";

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

/** CUIT en 11 dígitos, o "" si no sirve para cruzar: vacío, mal formado o "CUIT país" del exterior (50…/55…), que es
 *  genérico y lo comparten todos los clientes de ese país (01/10: Bequisa de Brasil 55000000050, Yangjiang de China
 *  55000003106). Sólo se cruzan los prefijos de un CUIT argentino. */
export function cuitNorm(c: unknown): string {
  const d = String(c ?? "").replace(/\D/g, "");
  return d.length === 11 && /^(20|23|24|27|30|33|34)/.test(d) ? d : "";
}

/** Texto con los datos para transferir a una empresa; si Chef no tiene alias/CBU cargados, no inventa ni usa los de LK. */
export function textoDatosPago(e: DatosEmpresa, conNombre: boolean): string | null {
  if (!e.alias && !e.cbu) return null;
  const cab = conNombre ? `Para las facturas de *${e.razon_social || e.nombre}*:\n` : "";
  return `${cab}*Alias:* ${e.alias || "—"}\n*CBU:* ${e.cbu || "—"}`;
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
