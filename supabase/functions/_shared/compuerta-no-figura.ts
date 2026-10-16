// compuerta-no-figura — si el agente le dice al cliente que el pedido que dice haber hecho «no figura» y en el turno NO llamó a derivar_a_persona,
// la derivación la hace el CÓDIGO (motivo pedido_no_encontrado, urgente).
// Pablo Olejavetzky, 16/10/2026 (corrida 17 de eval, auditoría 865): a «Te aviso que metí un pedido el 17/9 por la página» el agente contestó «No te figura
// ningún pedido del 17/9» y preguntó «¿es alguno de estos?», sin derivar. La regla (agente-fijos.ts, NO INVENTES TIEMPOS…) pide derivar en ESE mismo
// turno desde el 07/10, y el modelo la cumple a veces. Misma lección que las compuertas de stock y de foto: una regla de prompt no alcanza.
//
// Como la de foto, CONSERVA el borrador del modelo (los pedidos que sí figuran están bien): sólo suma la derivación y, si el texto no lo dice, el aviso
// de que una persona de Ventas lo revisa. Dispara sólo si el CLIENTE dice que hizo o mandó un pedido y la RESPUESTA dice que no figura: «¿cuándo llega
// mi pedido NP-123?» o «en el pedido no figura la paleta» no la disparan.
//
// Módulo puro, sin imports de red: lo prueba tests/compuerta-no-figura.test.ts.

/** El texto aprobado por Pablo (07/10) para avisar la derivación; se suma al borrador si no la menciona. */
export const AVISO_VENTAS_NO_FIGURA = "Le aviso a una persona de Ventas para que lo revise y te escriba por este medio.";

const L = String.raw`[a-záéíóúüñ]`;
// El cliente dice que hizo, pasó, metió, cargó, mandó o envió un pedido («pasé un pedido», «tenemos un pedido realizado el 18 de marzo», «el pedido que cargué»).
const VERBO_HIZO = String.raw`(?:hic(?:e|imos|ieron)|pas[eé]|pasamos|met[ií]|metimos|cargu[eé]|cargamos|mand[eé]|mandamos|envi[eé]|enviamos|realic[eé]|realizamos)`;
const RE_HIZO_PEDIDO = new RegExp(
  String.raw`(?<!${L})${VERBO_HIZO}(?!${L})[^.?!\n]{0,40}(?<!${L})pedid[oa]s?(?!${L})` +
  String.raw`|(?<!${L})pedid[oa]s?(?!${L})[^.?!\n]{0,40}(?<!${L})(?:realizad[oa]|hech[oa]|cargad[oa]|enviad[oa]|mandad[oa]|${VERBO_HIZO})(?!${L})`, "i");
// La respuesta dice que ese pedido no figura: «No me figura ese pedido», «No te figura ningún pedido del 17/9», «no veo ningún pedido del 18 de marzo».
const RE_NO_FIGURA = new RegExp(
  String.raw`no\s+(?:me|te|nos|le)?\s*(?:figura|aparece|veo|encuentro|encontr[eé])\s+(?:ese|ning[uú]n|el|un|tu)\s+pedido`, "i");
// La respuesta ya avisa que una persona lo revisa (con o sin la herramienta): no se suma otra vez.
const RE_YA_AVISA = /\b(?:persona|asesor|ventas|equipo)\b[^.?!\n]{0,80}\b(?:revis|escrib|contact|confirm)/i;

/** ¿El cliente dice que hizo o mandó un pedido? */
export function diceQueHizoPedido(userText: string): boolean {
  return RE_HIZO_PEDIDO.test(String(userText ?? ""));
}

/** ¿La respuesta dice que el pedido no figura? */
export function respuestaNoFigura(texto: string): boolean {
  return RE_NO_FIGURA.test(String(texto ?? ""));
}

/** ¿Hay que derivar por código? El cliente dice que hizo un pedido, la respuesta dice que no figura, en el turno no se derivó y no es un turno de pedido. */
export function debeDerivarNoFigura(userText: string, texto: string, herramientasUsadas: string[], enPedido: boolean): boolean {
  if (enPedido || herramientasUsadas.includes("derivar_a_persona")) return false;
  return diceQueHizoPedido(userText) && respuestaNoFigura(texto);
}

/** El borrador con el aviso de la derivación al final, si todavía no lo dice. Saca la pregunta «¿es alguno de estos…?» que deja la decisión
 *  en el cliente: con la derivación ya hecha, lo revisa Ventas. */
export function conAvisoDeVentas(texto: string): string {
  const parrafos = String(texto ?? "").trim().split(/\n{2,}/);
  const ultimo = parrafos[parrafos.length - 1] ?? "";
  // «¿El pedido del 17/9 es alguno de estos, o es uno que no aparece? Si no figura, le paso el aviso…»: la derivación ya está hecha, la pregunta sobra.
  if (parrafos.length > 1 && ultimo.includes("?") && /(?:alguno|cu[aá]l)/i.test(ultimo)) parrafos.pop();
  const t = parrafos.join("\n\n").trim();
  return RE_YA_AVISA.test(t) ? t : `${t}\n\n${AVISO_VENTAS_NO_FIGURA}`;
}
