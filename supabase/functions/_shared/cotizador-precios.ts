// Precios del cotizador que manda un cliente, comparados con los de la web (Pablo Olejavetzky, 06/10/2026, corrección m41: "cuando ya lo manda tendríamos que
// chequear los valores, si son iguales que los que tenemos": el cotizador trae los precios y la forma de pago; se compara con la página y se le pide al cliente
// que confirme artículo y valor, como en un pedido por WhatsApp).
//
// Módulo puro, sin imports: recibe las FILAS de la hoja "Cotizador Loekemeyer" (XLSX.utils.sheet_to_json con header: 1) y los precios de la web. Lo usan
// pedido-archivo.ts (lector) y lk_whatsapp-webhook (mensaje), y lo prueba tests/cotizador-precios.test.ts.
//
// Diseño de la hoja (visto en un cotizador real, 06/10): fila 1 = versión ("Septiembre 2025"); filas 3-6 = forma de pago (con una "x"); H8 = "Total a Abonar" y H9 = el total;
// fila 10 = encabezado: Descripcion · Cod · Pedido en Cajas · Uni x Caja · $ x Uni · $ x Caja · Total $ x Cod · Total Uni; desde la fila 11, un artículo por fila.
// Un artículo sin stock figura con "No Disponible" en lugar del precio. Total a Abonar = suma(cajas × uxb × $ x Uni) × (1 − descuento del plazo) × 0,98 (el 2 % web).

export interface FilaCotizador {
  cod: string; descripcion: string; cajas: number; uxb: number | null; pu: number | null; pc: number | null;
  /** La celda del precio dice "No Disponible". */
  noDisponible: boolean;
}
export interface CotizadorLeido {
  /** "Septiembre 2025", la leyenda de arriba del cotizador (informativa: no se mantiene al día, no se usa para decidir). */
  version: string | null;
  /** "Total a Abonar" tal como figura. */
  total: number | null;
  filas: FilaCotizador[];
}
export interface PrecioWeb { pu: number; uxb: number; activo: boolean }
export type TipoDiferencia = "precio" | "unidades_por_caja" | "no_esta_en_la_web" | "no_disponible_en_el_cotizador";
export interface Diferencia {
  cod: string; descripcion: string; tipo: TipoDiferencia;
  /** Lo que dice el cotizador y lo que dice la web (precio por UNIDAD, o unidades por caja, según el tipo). */
  cotizador: number | null; web: number | null; uxb: number | null; cajas: number;
}

const norm = (v: unknown): string => String(v ?? "").trim();
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = norm(v);
  if (!s || /[a-z]/i.test(s)) return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
const MESES = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";

/** Lee la hoja del cotizador. null si no tiene el diseño esperado (otro tipo de planilla: sigue el flujo de siempre, sin comparar). */
export function leerHojaCotizador(filas: unknown[][]): CotizadorLeido | null {
  let h = -1;
  const col = { cod: -1, desc: -1, cajas: -1, uxb: -1, pu: -1, pc: -1 };
  for (let i = 0; i < Math.min(filas.length, 40); i++) {
    const celdas = (filas[i] ?? []).map(norm);
    const cod = celdas.findIndex((c) => /^cod\.?$/i.test(c)), pu = celdas.findIndex((c) => /^\$\s*x\s*uni/i.test(c));
    if (cod < 0 || pu < 0) continue;
    h = i; col.cod = cod; col.pu = pu;
    col.desc = celdas.findIndex((c) => /^descripci/i.test(c));
    col.cajas = celdas.findIndex((c) => /pedido\s+en\s+cajas/i.test(c));
    col.uxb = celdas.findIndex((c) => /uni\s*x\s*caja/i.test(c));
    col.pc = celdas.findIndex((c) => /^\$\s*x\s*caja/i.test(c));
    break;
  }
  if (h < 0 || col.cajas < 0) return null;

  let version: string | null = null, total: number | null = null;
  for (let i = 0; i < h; i++) {
    const fila = filas[i] ?? [];
    for (let c = 0; c < fila.length; c++) {
      const t = norm(fila[c]);
      if (!version && new RegExp(`\\b(${MESES})\\s+(de\\s+)?\\d{4}\\b`, "i").test(t)) version = t;
      if (total === null && /total\s+a\s+abonar/i.test(t)) total = num((filas[i + 1] ?? [])[c]);
    }
  }

  const out: FilaCotizador[] = [];
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i] ?? [];
    const cod = norm(f[col.cod]).toUpperCase();
    if (!/^[0-9A-Z]{2,8}$/.test(cod)) continue;
    out.push({
      cod, descripcion: col.desc >= 0 ? norm(f[col.desc]) : "", cajas: num(f[col.cajas]) ?? 0, uxb: col.uxb >= 0 ? num(f[col.uxb]) : null,
      pu: num(f[col.pu]), pc: col.pc >= 0 ? num(f[col.pc]) : null, noDisponible: /no\s+disponible/i.test(norm(f[col.pu])),
    });
  }
  return { version, total, filas: out };
}

/** Los artículos que el cliente PIDIÓ (cajas > 0) con la comparación contra la web. Sin diferencias = el cotizador coincide con la página.
 *  `ignorarPrecio` (Pablo, 07/10, m41): una cadena con lista de precios propia (precios_super) no paga la lista general de la web, así que su cotizador puede estar al día y
 *  aun así no coincidir: no se compara el PRECIO (daría una falsa alarma de "cotizador desactualizado"). Siguen valiendo las unidades por caja, "no está en la web" y "No Disponible". */
export function compararConWeb(cot: CotizadorLeido, web: Record<string, PrecioWeb | undefined>, opciones: { ignorarPrecio?: boolean } = {}): { pedidos: FilaCotizador[]; diferencias: Diferencia[] } {
  const pedidos = cot.filas.filter((f) => f.cajas > 0);
  const diferencias: Diferencia[] = [];
  for (const f of pedidos) {
    const w = web[f.cod];
    const base = { cod: f.cod, descripcion: f.descripcion, uxb: f.uxb, cajas: f.cajas };
    if (!w || !w.activo) { diferencias.push({ ...base, tipo: "no_esta_en_la_web", cotizador: f.pu, web: null }); continue; }
    if (f.noDisponible || f.pu === null) { diferencias.push({ ...base, tipo: "no_disponible_en_el_cotizador", cotizador: null, web: w.pu }); continue; }
    if (!opciones.ignorarPrecio && Math.abs(f.pu - w.pu) >= 1) { diferencias.push({ ...base, tipo: "precio", cotizador: f.pu, web: w.pu }); continue; }
    if (f.uxb !== null && f.uxb !== w.uxb) diferencias.push({ ...base, tipo: "unidades_por_caja", cotizador: f.uxb, web: w.uxb });
  }
  return { pedidos, diferencias };
}

const pesos = (n: number): string => "$" + Math.round(n).toLocaleString("es-AR");
const pesos2 = (n: number): string => "$" + n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** El bloque que se le agrega al mensaje al cliente: SÓLO lo que NO coincide con la web (y el total del cotizador). Si todo coincide devuelve "": el control lo hace
 *  el bot en silencio y no se le explica nada al cliente (Pablo, 06/10: "no hace falta explicarle que coincide, solamente tenés que chequearlo vos, si no coincide sí avisar").
 *  Tampoco se aclara cuáles artículos SÍ coinciden. */
export function textoComparacion(cot: CotizadorLeido, dif: Diferencia[]): string {
  if (!dif.length) return "";
  const nombre = (d: Diferencia) => `${d.descripcion || "Artículo"} (cód. ${d.cod})`;
  const lineas: string[] = [`💰 Ojo, tu cotizador puede estar desactualizado: estos valores no coinciden con los de la web.`];
  for (const d of dif.slice(0, 15)) {
    if (d.tipo === "precio") lineas.push(`• ${nombre(d)}: en tu cotizador ${pesos((d.cotizador ?? 0) * (d.uxb ?? 1))} por caja; en la web ${pesos((d.web ?? 0) * (d.uxb ?? 1))} por caja.`);
    else if (d.tipo === "unidades_por_caja") lineas.push(`• ${nombre(d)}: tu cotizador dice ${d.cotizador} unidades por caja; en la web son ${d.web}.`);
    else if (d.tipo === "no_esta_en_la_web") lineas.push(`• ${nombre(d)}: hoy no está disponible en la web.`);
    else lineas.push(`• ${nombre(d)}: tu cotizador lo marca "No Disponible", pero en la web figura con precio (${pesos((d.web ?? 0) * (d.uxb ?? 1))} por caja).`);
  }
  if (dif.length > 15) lineas.push(`… y ${dif.length - 15} diferencias más.`);
  if (cot.total !== null) lineas.push(`Total que figura en tu cotizador: ${pesos2(cot.total)} (con sus precios).`);
  return lineas.join("\n");
}
