// Pablo Olejavetzky, 14/10/2026 (P5 del plan de los 8 puntos, casos mp03 y mp06): «tendría que darle un listado de los
// pedidos que realizó, porque ponele que lo hizo hoy o antes de ayer». La regla SIN PEDIDO PENDIENTE (agente-fijos.ts) lo
// dice en el prompt, pero Gemini Flash Lite la ignoró 6 de 6 veces: derivaba la anulación o el cambio sobre el pedido
// retirado, o contestaba sin el listado. Por eso, cuando ningún pedido está pendiente, consultar_mis_pedidos devuelve la
// indicación junto con los datos, que es donde el modelo la lee justo antes de contestar. Puro: tests/pedidos-sin-pendiente.test.ts.

/** Estado de Gestión de un pedido que ya salió (para un retiro, que ya lo retiró). */
export const ESTADO_SALIDO = "entregado";

export const NOTA_SIN_PENDIENTE =
  "Ninguno de estos pedidos está pendiente: todos ya se entregaron o se retiraron. Si el cliente pide cambiar, sacar, agregar " +
  "o anular algo de un pedido, NO derives y NO le digas que no le figura: pasale este listado (cada pedido por su fecha y su " +
  "estado tal cual) y preguntale cuál es. Si en el mismo mensaje pidió un pedido nuevo, indicale cómo hacerlo en ese mismo " +
  "mensaje (regla PEDIDOS). Si contesta que no es ninguno de la lista, ahí sí derivá con motivo pedido_no_encontrado.";

/** Con algún pedido pendiente devuelve la lista tal cual; si todos salieron, la envuelve con la indicación. */
export function conAvisoSinPendiente<T extends { estado?: unknown }>(pedidos: T[]): T[] | { pedidos: T[]; ninguno_pendiente: true; indicacion: string } {
  if (!pedidos.length || pedidos.some((p) => String(p.estado ?? "") !== ESTADO_SALIDO)) return pedidos;
  return { pedidos, ninguno_pendiente: true, indicacion: NOTA_SIN_PENDIENTE };
}
