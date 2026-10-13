// Topes por ACCIÓN y por número (Pablo Olejavetzky, 13/10/2026 — riesgo 3 del anexo de la constitución).
//
// El tope de 20/h (tope-ia.ts) cuenta CONSULTAS al modelo. Esto es distinto: limita las ACCIONES que le dan
// trabajo a una persona o cargan algo, para que un cliente —o un loop del teléfono— no inunde al equipo con
// derivaciones, agregados, sucursales o pedidos. El contador vive en la base (RPC bot_accion_tope, sql/142):
// cuenta por número + acción en la última hora y, si está bajo el límite, registra y deja pasar.
//
// Acá viven sólo los números y los textos (parte pura, se prueba en tests/tope-accion.test.ts). El chequeo lo
// hace bot-conversation.ts en el loop de herramientas, antes de ejecutar la acción. El Simulador no topea.

/** Máximo por hora y por número de cada acción. Generoso: un cliente real no los alcanza; un loop sí. */
export const TOPES_ACCION: Record<string, number> = {
  derivar_a_persona: 8,
  solicitar_agregado_pedido: 6,
  solicitar_nueva_sucursal: 4,
  armar_pedido: 6,
  confirmar_pedido: 6,
};

/** Lo que se le dice al cliente cuando una acción se topeó (el modelo lo pasa tal cual). */
export const MSG_TOPE_ACCION =
  "Ya registramos varias solicitudes desde este número en la última hora. Una persona del equipo las está viendo y te responde por este medio.";

/** Contexto de la alerta interna (una por número y por hora) cuando se topea una acción. */
export function contextoTopeAccion(accion: string, limite: number): Record<string, unknown> {
  return {
    motivo: "tope_accion",
    detalle: `Se topeó la acción "${accion}" (máximo ${limite} por hora por número). Puede ser un error del cliente ` +
      "(mensajes repetidos, un loop del teléfono) o alguien abusando: mirá el chat.",
  };
}
