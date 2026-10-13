// Texto de respaldo cuando el modelo termina el turno SIN texto (Pablo Olejavetzky, 07/10/2026).
//
// Con Haiku 4.5 en el Simulador, m7 y m74 llamaron a derivar_a_persona (la alerta quedó bien) y el cliente recibió «Contame un poco más tu consulta así te ayudo.», el
// respaldo de bot-conversation.ts para cuando `res.text` viene vacío: contradice la derivación. Si en el turno se derivó con éxito, el respaldo dice que una persona
// escribe por acá (texto aprobado por Pablo: "sí, hacelo con ese texto"). En cualquier otro turno sin texto queda el de siempre. Módulo puro, sin imports: lo prueba
// tests/respaldo-texto.test.ts.

/** Respaldo de siempre: el modelo no devolvió nada y no se derivó. */
export const RESPALDO_SIN_TEXTO = "¿Podrías darme más detalle de tu consulta para poder ayudarte?";
/** Respaldo cuando en el turno se derivó con derivar_a_persona y el modelo no escribió nada. */
export const RESPALDO_DERIVADO = "Gracias por avisarnos. Una persona del equipo te va a responder por este medio.";

/** Cuenta como derivación lograda un derivar_a_persona cuyo resultado trae `"ok":true` (un motivo que responde el bot devuelve `{ error }` y no deriva). */
export function textoDeRespaldo(usadas: ReadonlyArray<{ nombre: string; resultado: string }>): string {
  const derivo = usadas.some((u) => u.nombre === "derivar_a_persona" && /"ok"\s*:\s*true/.test(u.resultado));
  return derivo ? RESPALDO_DERIVADO : RESPALDO_SIN_TEXTO;
}

// Pablo, 08/10 ("qué le falta para ser un agente", punto 7): cuando el agente gasta las 5 vueltas de un turno pidiendo herramientas y no
// llega a contestar, el cliente recibía «Disculpá, no pude completar tu consulta. ¿Podés reformular tu pregunta?»: le pasaba el problema a él
// y nadie se enteraba. Pasa poco (Simulador, 05/10 a 08/10: 2 de 349 turnos llegaron a la 5ª vuelta, 0,6 %; webhook: 0 de 12, los registrados desde el 08/10), pero cuando
// pasa ahora se deriva a una persona, salvo que en ese mismo turno ya se haya derivado. Texto mío, sobre el patrón de los aprobados
// ("Una persona de Ventas revisa … y te escribe por acá").
// Pablo, 13/10: los dos respaldos que derivan pasan al tono formal del aviso de IA caída («Si, me gusta»): sin «por acá» y sin emoji.
export const RESPALDO_SIN_TERMINAR = "Una persona del equipo va a revisar tu consulta y te va a responder por este medio.";

// Pablo, 13/10 (plan de los 8 puntos, P6.2): cuando TODOS los modelos de la cadena fallan o vencen, el cliente no recibía nada (sólo la alerta
// llm_error / llm_timeout a una persona). Ahora recibe este texto, una vez cada 30 min por número (lk_whatsapp-webhook, avisarIaCaida), por la
// llave de envío como todo lo demás. Pablo, 13/10: «tiene que ser un poco más formal» → este texto, sin «se me complicó», sin «por acá» y sin emoji. Aprobado: «Si, me gusta».
export const RESPALDO_IA_CAIDA = "En este momento no puedo procesar tu consulta. Ya la derivé a una persona del equipo, que te va a responder por este medio.";

/** Qué hacer cuando se terminan las vueltas: el texto y si hay que dejar una alerta (no, si en el turno ya se derivó bien). */
export function cierreSinTerminar(usadas: ReadonlyArray<{ nombre: string; resultado: string }>): { texto: string; derivar: boolean } {
  const derivo = usadas.some((u) => u.nombre === "derivar_a_persona" && /"ok"\s*:\s*true/.test(u.resultado));
  return { texto: RESPALDO_SIN_TERMINAR, derivar: !derivo };
}
