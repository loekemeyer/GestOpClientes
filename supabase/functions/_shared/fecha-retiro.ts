// Cómo se dice la fecha de un pedido que el cliente RETIRA en el depósito, en la lista de pedidos por entregar (Pablo Olejavetzky, 06/10/2026,
// correcciones m21 y m25 del artifact: "tenés que sacar el retirar cuando te preguntan cuándo se entrega" → "sí, ese texto": "programado para el lunes 05/10").
// Antes decía "🚚 programado: lo podés retirar desde el lunes 05/10". El aviso de que YA está listo para retirar sale aparte (plantilla pedido_listo_retirar).
// Módulo puro, sin imports: lo usan faq.ts (lookupOrderStatus) y pedidos-marca.ts, y lo prueba tests/fecha-retiro.test.ts.

/** Lo que va después del estado del pedido: "🚚 programado" + " para el lunes 05/10"; en otro estado (en preparación, facturado): ": programado para el lunes 05/10". */
export function textoFechaRetiro(estado: string, dia: string): string {
  return estado === "programado" ? ` para el ${dia}` : `: programado para el ${dia}`;
}
