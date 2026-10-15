// Importes de un pedido para el agente (Pablo Olejavetzky, 14/10/2026: «Sí, corregilo así»). Módulo puro, sin imports: lo usa bot-conversation.ts y lo prueba
// tests/importes-pedido.test.ts.
//
// El total de `orders` es SIN IVA y con los descuentos por pago y web ya aplicados (aviso-pedido.ts: "Total de orders: sin IVA, con los descuentos ya aplicados").
// El aviso automático de pedido recibido lo dice "$896.668 ($741.048 + IVA)": con IVA primero y el neto entre paréntesis. Las herramientas del agente
// (consultar_mis_pedidos, consultar_detalle_pedido) le pasaban el neto pelado, sin decir que era sin IVA, y la IA podía contradecir al aviso que el mismo cliente
// recibió. Acá el código calcula los dos importes y arma el texto: el modelo no hace cuentas.

export const IVA = 1.21;

/** "$13.144.191": pesos sin decimales con punto de miles (igual que `pesos` de aviso-pedido.ts). */
export const pesos = (n: number): string => "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export interface ImportesDelTotal { total_sin_iva: number; total_con_iva: number; total_para_el_cliente: string }

/** Total de un pedido (neto de IVA, con descuentos) → el neto, el total con IVA y el texto "$896.732 ($741.100 + IVA)". null si no hay un total válido. */
// Pablo, 14/10: el formato «$235.442 ($194.580 + IVA)» queda así, SIN agregar «con IVA» al primer número (se le propuso y dijo que no).
export function importesDelTotal(neto: unknown): ImportesDelTotal | null {
  const n = Number(neto);
  if (neto === null || neto === undefined || neto === "" || !Number.isFinite(n) || n <= 0) return null;
  return { total_sin_iva: Math.round(n), total_con_iva: Math.round(n * IVA), total_para_el_cliente: `${pesos(n * IVA)} (${pesos(n)} + IVA)` };
}

export interface FilaDetallePedido { cod: string; description: string; cajas: number; line_total: number | string | null; total_pedido: number | string | null; fecha: string; payment_method: string }

export const NOTA_IMPORTES_POR_LINEA =
  "El importe de una línea, si viene, es SIN IVA y ANTES de los descuentos por pago y web: no lo sumes ni lo compares con el total. Si una línea no lo trae, el importe no está cargado: no lo calcules.";

/** Detalle de un pedido para la IA. `cargada[i]` = la línea i tiene `line_total` cargado en order_items (la RPC bot_detalle_pedido lo reemplaza por el precio de LISTA × cajas cuando no lo tiene).
 *  Si `cargada` no tiene tantas posiciones como filas, no se puede saber cuáles son: no se muestra ningún importe por línea. */
export function detalleDePedido(filas: FilaDetallePedido[], cargada: boolean[]) {
  const alineado = cargada.length === filas.length;
  return {
    pedido: { fecha: filas[0]?.fecha, payment_method: filas[0]?.payment_method, ...(importesDelTotal(filas[0]?.total_pedido) ?? {}) },
    items: filas.map((f, i) => ({ cod: f.cod, description: f.description, cajas: f.cajas,
      ...(alineado && cargada[i] ? { importe_linea_sin_iva_antes_de_descuentos: Math.round(Number(f.line_total)) } : {}) })),
    nota: NOTA_IMPORTES_POR_LINEA,
  };
}
