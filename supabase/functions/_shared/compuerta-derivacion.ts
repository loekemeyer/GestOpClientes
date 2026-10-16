// compuerta-derivacion — si la respuesta del agente dice que YA pasó el pedido a una persona y en el turno NO se derivó, la derivación la hace el CÓDIGO.
// Pablo Olejavetzky, 16/10/2026 (auditoría 882, puntaje 93): «cambiá el 505 por el 501 en mi último pedido» → «Ya le pasé a una persona del equipo el cambio… te van a
// escribir por este medio» sin llamar a derivar_a_persona: en wa_alertas_humano no había ninguna alerta y el cliente quedaba esperando a alguien que nadie avisó.
// Misma lección que las compuertas de stock, de foto y de «no figura»: una regla de prompt no alcanza para una promesa que el cliente toma al pie de la letra.
//
// CONSERVA el borrador del modelo (el texto ya dice lo que corresponde): sólo suma la derivación que faltaba. El motivo se infiere del mensaje del cliente: cambio de
// artículos → cambio_pedido, anular o cancelar → anulacion_pedido (urgente), y si no se sabe, escalation (el motivo «sin otro motivo»).
//
// Módulo puro, sin imports de red: lo prueba tests/compuerta-derivacion.test.ts.

const L = String.raw`[a-záéíóúüñ]`;
// «Ya le pasé a una persona del equipo…», «le aviso a Ventas…», «te derivo con un vendedor…».
const RE_DICE_QUE_DERIVA = new RegExp(
  String.raw`(?<!${L})(?:le|te|nos)\s+(?:pas[eé]|paso|aviso|avis[eé]|deriv[eé]|derivo|transmit[ií]|transmito|mand[eé]|mando)(?!${L})[^.?!\n]{0,90}(?<!${L})(?:persona|equipo|vendedor|ventas|asesor)(?!${L})`, "i");
// Ofrecimientos y condicionales no afirman nada: «si querés, le paso tu consulta», «puedo pasarle…».
const RE_CONDICIONAL = /(?:\bsi\s+(?:quer[eé]s|quieres|prefer[eé]s|necesit[aá]s)|\bpuedo\b|\bpodr[ií]a\b|\bquer[eé]s que\b|\bte parece\b|¿)/i;
// Herramientas que ya derivan solas: si el turno usó una, la derivación está hecha.
export const HERRAMIENTAS_QUE_DERIVAN = ["derivar_a_persona", "solicitar_agregado_pedido", "solicitar_nueva_sucursal", "solicitar_cambio_mail"];

/** true si algún renglón del texto afirma que ya se pasó o avisó a una persona (las preguntas y los ofrecimientos no cuentan). */
export function dicePasoAPersona(texto: string): boolean {
  for (const frag of String(texto ?? "").split(/(?<=[.!?\n])/)) {
    const f = frag.trim();
    if (!f || f.endsWith("?") || RE_CONDICIONAL.test(f)) continue;
    if (RE_DICE_QUE_DERIVA.test(f)) return true;
  }
  return false;
}

/** ¿Hay que derivar por código? La respuesta dice que ya se pasó a una persona, en el turno ninguna herramienta derivó y no es un turno de pedido. */
export function debeDerivarAfirmada(texto: string, herramientasUsadas: string[], enPedido: boolean): boolean {
  if (enPedido || herramientasUsadas.some((h) => HERRAMIENTAS_QUE_DERIVAN.includes(h))) return false;
  return dicePasoAPersona(texto);
}

const RE_CAMBIO = new RegExp(String.raw`(?<!${L})(?:cambi[aá]|cambiar|cambio|cambiame|reemplaz${L}*|sac[aá]|sacar|sacame|quit[aá]|quitar)(?!${L})|\bpor\s+el\s+\d{3}`, "i");
const RE_ANULAR = new RegExp(String.raw`(?<!${L})(?:anul${L}*|cancel${L}*)(?!${L})`, "i");

/** El motivo y la urgencia de la derivación, según lo que pidió el cliente. Sin pista clara: escalation. */
export function motivoDeLaDerivacion(userText: string): { motivo: string; urgente: boolean } {
  const t = String(userText ?? "");
  if (RE_ANULAR.test(t)) return { motivo: "anulacion_pedido", urgente: true };
  if (RE_CAMBIO.test(t)) return { motivo: "cambio_pedido", urgente: false };
  return { motivo: "escalation", urgente: false };
}
