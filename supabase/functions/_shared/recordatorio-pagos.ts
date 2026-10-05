// recordatorio-pagos — ¿el cliente pagó después de la última carga de saldos? (funciones puras, sin red).
// Lo usa lk_recordatorio-descuento. Pablo Olejavetzky, 05/10: GV_Cobranza_Deuda_Viva (el saldo con el que se decide a quién
// avisar) se rearma sólo de noche y sólo cuando entra una carga nueva (Excel de deuda, conciliación del banco, facturas de
// ISIS). Un pago registrado en Gestión después de esa carga (depósito, e-cheque, cheque) no está en el saldo, y el cliente
// recibiría "pagá hasta el … con 25 %" por una factura que ya pagó. Los recibos (gv_cobranza_recibos) se actualizan antes.

export type ReciboMin = { cod_cliente: string; fecha_pago: string; pagado: number | null };

const sinCeros = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

/**
 * El recibo más reciente de ese cliente con fecha de pago entre `desde` y `hasta` (YYYY-MM-DD, los dos inclusive), o null.
 * `desde` es el día de la carga de saldos: un recibo de ese mismo día puede ser anterior o posterior a la carga y no hay forma
 * de saberlo, así que cuenta (equivocarse hacia no avisar sólo pierde un recordatorio; hacia avisar, molesta a quien ya pagó).
 * `hasta` es hoy: un recibo con fecha futura es un cheque diferido, no un pago hecho.
 */
export function pagoPosterior(recibos: ReciboMin[], cod: string, desde: string, hasta: string): ReciboMin | null {
  let mejor: ReciboMin | null = null;
  for (const r of recibos) {
    if (sinCeros(r.cod_cliente) !== sinCeros(cod)) continue;
    const f = String(r.fecha_pago ?? "").slice(0, 10);
    if (!f || f < desde || f > hasta) continue;
    if (!mejor || f > String(mejor.fecha_pago).slice(0, 10)) mejor = r;
  }
  return mejor;
}
