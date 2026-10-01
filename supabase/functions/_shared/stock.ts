// stock — disponibilidad real de un artículo para el bot (pedido de Pablo Olejavetzky, 28/09).
//
// disponible (cajas) = stock libre en Gestión − cajas de pedidos web que todavía no salieron del depósito.
//   Stock libre: bot_stock_por_empresa() de Gestión (proyecto Gestión/ISIS, sql/isis_bot_stock_por_empresa.sql, 01/10),
//     una fila por empresa desde vista_saldos_stock = terminado + excedente + racks + racks_ch + a_guardar + para_envasar.
//     Antes se leía vista_stock_vs_pedidos, que junta las dos empresas en cada código y guarda el código sin el cero
//     ("31"): los 17 artículos de la web con cero adelante ("031") daban siempre "sin stock".
//     NO suma separar_pedidos ni a_facturar: eso ya está separado para pedidos (el picking lo sacó del
//     terminado), así que no se resta dos veces.
//   Pedidos web: bot_stock_web_comprometido (sql/077) — sin programar o programados sin pickear.
//   Los pedidos que no entran por la web (cargados en Gestión) programados sin pickear hoy son ~45 cajas
//   en total; no se restan todavía.
// Al cliente NUNCA se le da el número: "hay", "stock limitado" o "sin stock".
// Ingreso estimado (Pablo, 29/09: "¿no tenés datos del PPP para responder eso?"): GV_Importados_Baches de Gestión
// (lotes de importados en curso con fecha_reingreso = fecha estimada de ingreso a depósito). Se da SIEMPRE como
// fecha estimada ("alrededor del dd/mm, puede cambiar"), sólo para artículos sin stock o con stock limitado.

import { getGestionClient, supabase } from "./supabase.ts";

export const MINIMO_HAY = 20; // cajas: desde acá es "hay stock"; debajo, "stock limitado"

export interface StockArticulo {
  cod: string;
  libre: number;        // cajas en depósito no separadas para pedidos
  comprometido: number; // cajas de pedidos web que todavía no salieron
  disponible: number;
  nivel: "hay" | "limitado" | "sin";
  /** Código de dos empresas con stock cargado como "Mixto" (no se sabe de cuál es): lo confirma una persona. */
  incierto?: boolean;
}

export async function stockArticulo(cod: string, empresa: "LK" | "CH" = "LK"): Promise<StockArticulo | null> {
  const c = String(cod ?? "").trim().toUpperCase();
  if (!c) return null;
  const gestion = await getGestionClient("public");
  // El código se normaliza en Gestión con gv_cod_stock (la misma regla que usa Gestión: "031" de la web = "31").
  const { data: filas, error } = await gestion.rpc("bot_stock_por_empresa", { p_cod: c });
  if (error) throw new Error(`stock Gestión: ${error.message}`);
  const rows = (filas ?? []) as Array<Record<string, unknown>>;
  const n = (v: unknown) => Number(v) || 0;
  const libreDe = (f: Record<string, unknown>) =>
    n(f.terminado) + n(f.excedente) + n(f.racks) + n(f.racks_ch) + n(f.a_guardar) + n(f.para_envasar);
  // Código de dos productos (026 = Colador N°8 en LK y Pinza de fideos en Chef, GV_Cod_Dos_Productos) o dual (437E lo
  // venden las dos y cada una tiene su stock, codigos_duales): cuenta sólo el de la empresa que pregunta. El resto de los
  // códigos suma todas las filas, igual que vista_stock_vs_pedidos. Lo cargado como "Mixto" no se sabe de quién es.
  const separa = rows.some((f) => f.dos_productos === true || f.dual === true);
  const propias = separa ? rows.filter((f) => f.empresa === empresa) : rows;
  const incierto = separa && rows.some((f) => f.empresa === "Mixto" && libreDe(f) > 0);
  const libre = propias.reduce((a, f) => a + libreDe(f), 0);

  // Los pedidos web de este proyecto son de Loekemeyer: a Chef no se le restan.
  let comprometido = 0;
  if (empresa === "LK") {
    const { data: w, error: ew } = await supabase.rpc("bot_stock_web_comprometido", { p_cods: [String(cod).trim()] });
    if (ew) throw new Error(`stock web: ${ew.message}`);
    comprometido = n(w?.[0]?.cajas);
  }
  const disponible = Math.floor(libre - comprometido);
  return {
    cod: c, libre, comprometido, disponible, ...(incierto ? { incierto } : {}),
    // Con stock "Mixto" lo propio es un piso: si no llega a "hay", lo confirma una persona en vez de decir "sin stock".
    nivel: disponible >= MINIMO_HAY ? "hay" : disponible > 0 || incierto ? "limitado" : "sin",
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

export interface IngresoEstimado {
  fecha: string;        // YYYY-MM-DD, fecha estimada de ingreso a depósito
  demorado: boolean;    // la fecha ya pasó y el lote no llegó
}

const hoyAR = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Próximo ingreso estimado de un artículo importado (lote en curso con unidades pendientes). null si no hay dato. */
export async function ingresoEstimado(cod: string): Promise<IngresoEstimado | null> {
  const c = String(cod ?? "").trim().toUpperCase();
  if (!c) return null;
  const g = await getGestionClient("public");
  const { data, error } = await g.from("GV_Importados_Baches")
    .select("cod_art, unidades, unidades_llegadas, fecha_reingreso, estado")
    .eq("estado", "en_curso").in("cod_art", [c]).not("fecha_reingreso", "is", null)
    .order("fecha_reingreso", { ascending: true }).limit(10);
  if (error) throw new Error(`ingreso Gestión: ${error.message}`);
  const f = (data ?? []).find((x: { unidades: number; unidades_llegadas: number | null }) => Number(x.unidades) > Number(x.unidades_llegadas ?? 0));
  if (!f) return null;
  const fecha = String(f.fecha_reingreso).slice(0, 10);
  return { fecha, demorado: fecha < hoyAR() };
}

/** Texto para sumar al de stock. Vacío si no hay dato (el asesor confirma). */
export function textoIngreso(ing: IngresoEstimado | null): string {
  if (!ing) return "";
  if (ing.demorado) return " Está en camino, pero la fecha de ingreso se demoró: un asesor te confirma la nueva fecha.";
  return ` Estimamos que ingresa alrededor del ${ddmm(ing.fecha)} (es una fecha estimada y puede cambiar).`;
}

/** Artículos de la web (con código en products) que ingresan en los próximos `dias` días, del más cercano al más lejano. */
export async function proximosIngresos(dias = 45, max = 8): Promise<Array<{ cod: string; descripcion: string; ingreso_estimado: string }>> {
  const g = await getGestionClient("public");
  const hoy = hoyAR();
  const tope = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(Date.now() + dias * 86400000));
  const { data, error } = await g.from("GV_Importados_Baches")
    .select("cod_art, unidades, unidades_llegadas, fecha_reingreso")
    .eq("estado", "en_curso").gte("fecha_reingreso", hoy).lte("fecha_reingreso", tope)
    .order("fecha_reingreso", { ascending: true }).limit(200);
  if (error) throw new Error(`ingresos Gestión: ${error.message}`);
  const pend = (data ?? []).filter((x: { unidades: number; unidades_llegadas: number | null }) => Number(x.unidades) > Number(x.unidades_llegadas ?? 0));
  if (!pend.length) return [];
  const { data: prods } = await supabase.from("products").select("cod, description, active").in("cod", pend.map((x: { cod_art: string }) => x.cod_art));
  const desc = new Map((prods ?? []).filter((p: { active: boolean }) => p.active).map((p: { cod: string; description: string }) => [p.cod, p.description]));
  const vistos = new Set<string>(), out: Array<{ cod: string; descripcion: string; ingreso_estimado: string }> = [];
  for (const x of pend as Array<{ cod_art: string; fecha_reingreso: string }>) {
    if (!desc.has(x.cod_art) || vistos.has(x.cod_art)) continue;
    vistos.add(x.cod_art);
    out.push({ cod: x.cod_art, descripcion: String(desc.get(x.cod_art)).trim(), ingreso_estimado: ddmm(String(x.fecha_reingreso)) });
    if (out.length >= max) break;
  }
  return out;
}
