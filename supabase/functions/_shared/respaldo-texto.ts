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

// Pablo, 08/10 ("qué le falta para ser un agente", punto 7): cuando el agente gasta las 5 vueltas de un turno pidiendo herramientas y no
// llega a contestar, el cliente recibía «Disculpá, no pude completar tu consulta. ¿Podés reformular tu pregunta?»: le pasaba el problema a él
// y nadie se enteraba. Pasa poco (Simulador, 05/10 a 08/10: 2 de 349 turnos llegaron a la 5ª vuelta, 0,6 %; webhook: 0 de 12), pero cuando
// pasa ahora se deriva a una persona, salvo que en ese mismo turno ya se haya derivado. Texto mío, sobre el patrón de los aprobados
// ("Una persona de Ventas revisa … y te escribe por acá"): pendiente de que Pablo lo apruebe o lo cambie.
export const RESPALDO_SIN_TERMINAR = "Una persona del equipo revisa tu consulta y te escribe por acá. 🙏";

/** Qué hacer cuando se terminan las vueltas: el texto y si hay que dejar una alerta (no, si en el turno ya se derivó bien). */
export function cierreSinTerminar(usadas: ReadonlyArray<{ nombre: string; resultado: string }>): { texto: string; derivar: boolean } {
  const derivo = usadas.some((u) => u.nombre === "derivar_a_persona" && /"ok"\s*:\s*true/.test(u.resultado));
  return { texto: RESPALDO_SIN_TERMINAR, derivar: !derivo };
}
