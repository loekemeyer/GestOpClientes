// stock — disponibilidad real de un artículo para el bot (pedido de Pablo Olejavetzky, 28/09).
//
// disponible (cajas) = stock libre en Gestión − cajas de pedidos web que todavía no salieron del depósito.
//   Stock libre: vista_stock_vs_pedidos de Gestión (proyecto Gestión/ISIS, schema public) =
//     terminado + excedente + racks + racks_ch + a_guardar + para_envasar.
//     NO suma separar_pedidos ni a_facturar: eso ya está separado para pedidos (el picking lo sacó del
//     terminado), así que no se resta dos veces.
//   Pedidos web: bot_stock_web_comprometido (sql/077) — sin programar o programados sin pickear.
//   Los pedidos que no entran por la web (cargados en Gestión) programados sin pickear hoy son ~45 cajas
//   en total; no se restan todavía.
// Al cliente NUNCA se le da el número: "hay", "stock limitado" o "sin stock".

import { getGestionClient, supabase } from "./supabase.ts";

export const MINIMO_HAY = 20; // cajas: desde acá es "hay stock"; debajo, "stock limitado"

export interface StockArticulo {
  cod: string;
  libre: number;        // cajas en depósito no separadas para pedidos
  comprometido: number; // cajas de pedidos web que todavía no salieron
  disponible: number;
  nivel: "hay" | "limitado" | "sin";
}

export async function stockArticulo(cod: string): Promise<StockArticulo | null> {
  const c = String(cod ?? "").trim().toUpperCase();
  if (!c) return null;
  const canon = /^\d+$/.test(c) ? c.replace(/^0+(?=.)/, "").padStart(3, "0") : c;
  const gestion = await getGestionClient("public");
  const { data: filas, error } = await gestion.from("vista_stock_vs_pedidos")
    .select("cod, terminado, excedente, racks, racks_ch, a_guardar, para_envasar")
    .in("cod", [...new Set([c, canon, `${canon} LK`])]);
  if (error) throw new Error(`stock Gestión: ${error.message}`);
  // Código dual (existe en LK y en Chef): se usa la parte de LK.
  const f = (filas ?? []).find((x: { cod: string }) => x.cod.endsWith(" LK")) ?? (filas ?? [])[0];
  const n = (v: unknown) => Number(v) || 0;
  const libre = f ? n(f.terminado) + n(f.excedente) + n(f.racks) + n(f.racks_ch) + n(f.a_guardar) + n(f.para_envasar) : 0;

  const { data: w, error: ew } = await supabase.rpc("bot_stock_web_comprometido", { p_cods: [String(cod).trim()] });
  if (ew) throw new Error(`stock web: ${ew.message}`);
  const comprometido = n(w?.[0]?.cajas);
  const disponible = Math.floor(libre - comprometido);
  return {
    cod: c, libre, comprometido, disponible,
    nivel: disponible >= MINIMO_HAY ? "hay" : disponible > 0 ? "limitado" : "sin",
  };
}

/** Texto para el cliente, sin números. */
export function textoStock(desc: string, cod: string, s: StockArticulo, cajasPedidas?: number | null): string {
  const art = `*${desc}* (cód. ${cod})`;
  if (cajasPedidas && cajasPedidas > 0 && s.disponible >= cajasPedidas) {
    return `Sí, ${art} tiene stock para las ${cajasPedidas} cajas. ✅`;
  }
  if (s.nivel === "hay" && !cajasPedidas) return `${art} tiene stock disponible. ✅`;
  if (s.nivel === "sin") {
    return `${art} no tiene stock disponible en este momento. Le paso tu consulta a un asesor para que te confirme cuándo entra.`;
  }
  return `${art} tiene stock limitado${cajasPedidas ? ` y puede no alcanzar para ${cajasPedidas} cajas` : ""}. ` +
    `Le paso tu consulta a un asesor para que te confirme la cantidad.`;
}

/** ¿Hay que derivar a una persona? (sin stock, o limitado / no alcanza). */
export function stockNecesitaHumano(s: StockArticulo, cajasPedidas?: number | null): boolean {
  if (cajasPedidas && cajasPedidas > 0) return s.disponible < cajasPedidas;
  return s.nivel !== "hay";
}
