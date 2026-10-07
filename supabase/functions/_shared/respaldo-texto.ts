// Texto de respaldo cuando el modelo termina el turno SIN texto (Pablo Olejavetzky, 07/10/2026).
//
// Con Haiku 4.5 en el Simulador, m7 y m74 llamaron a derivar_a_persona (la alerta quedó bien) y el cliente recibió «Contame un poco más tu consulta así te ayudo.», el
// respaldo de bot-conversation.ts para cuando `res.text` viene vacío: contradice la derivación. Si en el turno se derivó con éxito, el respaldo dice que una persona
// escribe por acá (texto aprobado por Pablo: "sí, hacelo con ese texto"). En cualquier otro turno sin texto queda el de siempre. Módulo puro, sin imports: lo prueba
// tests/respaldo-texto.test.ts.

/** Respaldo de siempre: el modelo no devolvió nada y no se derivó. */
export const RESPALDO_SIN_TEXTO = "Contame un poco más tu consulta así te ayudo.";
/** Respaldo cuando en el turno se derivó con derivar_a_persona y el modelo no escribió nada. */
export const RESPALDO_DERIVADO = "Gracias por avisarnos. Una persona del equipo te escribe por acá. 🙏";

/** Cuenta como derivación lograda un derivar_a_persona cuyo resultado trae `"ok":true` (un motivo que responde el bot devuelve `{ error }` y no deriva). */
export function textoDeRespaldo(usadas: ReadonlyArray<{ nombre: string; resultado: string }>): string {
  const derivo = usadas.some((u) => u.nombre === "derivar_a_persona" && /"ok"\s*:\s*true/.test(u.resultado));
  return derivo ? RESPALDO_DERIVADO : RESPALDO_SIN_TEXTO;
}
