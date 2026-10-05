// Turnos de TOMA DE PEDIDO (cotizador, orden de compra, armar / confirmar / agregar a un pedido). Pablo Olejavetzky, 05/10:
// "podemos usar algún LLM fijo cuando se envían los cotizadores y para tomar pedidos, en este caso sería Sonnet: no podemos
// fallar ahí". Esos turnos NO van por la cadena de producción (hoy Gemini gratis #1, `wa_agente_modelos`): los contesta siempre
// Sonnet. Este módulo es PURO (sin red ni base): decide si un turno es de pedido y con qué modelo; lo usa `runConversation`
// (bot-conversation.ts) y se prueba en tests/pedido-turno.test.ts.

/** Modelo de los turnos de pedido. `app_settings.llm_modelo_pedidos` lo cambia sin deploy; "cadena" (u "off" / "0") lo apaga. */
export const MODELO_PEDIDOS = "claude-sonnet-4-6";

/** Herramientas que arman, confirman o modifican un pedido. Si el turno usó alguna, es de pedido aunque el texto no lo diga. */
export const HERRAMIENTAS_DE_PEDIDO = new Set(["opciones_de_pedido", "armar_pedido", "confirmar_pedido", "solicitar_agregado_pedido"]);

/** `app_settings.llm_modelo_pedidos`: vacío = el modelo de siempre; "cadena" / "off" / "0" = sin modelo fijo (vuelve la cadena). */
export function modeloFijoDePedidos(valor: string | null | undefined): string | null {
  const v = String(valor ?? "").trim();
  if (!v) return MODELO_PEDIDOS;
  return /^(cadena|off|0|no|false)$/i.test(v) ? null : v;
}

/** Lo último que dijo el bot es parte de la toma de un pedido (formas de pago, entrega, resumen, "Leímos esto"…): lo que conteste
 *  el cliente ("contado", "sí") sigue siendo del pedido. Es el mismo criterio que usa `pedidoEnCurso` (bot-conversation.ts). */
export const RE_BOT_EN_PEDIDO =
  /(le[ií]mos esto|recibimos tu cotizador|te tomo el pedido|qu[eé] art[ií]culos (necesit|quer)|algo m[aá]s\?|confirm[aá]s \d+ cajas|formas? de pago|resumen (de|del) (tu )?pedido|tu pedido:|confirm(á|as)\s+(el pedido|con un s[ií])|¿?con cu[aá]l (vas|pag)|direcci[oó]n de entrega|¿(a )?d[oó]nde (lo )?(enviamos|entregamos)|franja|d[ií]a de retiro)/i;

/** El cliente quiere pedir, mandó un cotizador o una orden de compra, o dice cantidades. Amplio a propósito: un falso positivo sólo
 *  cuesta una llamada a Sonnet; un falso negativo deja un pedido en manos del modelo gratis. Sin `\b` después de letras con tilde. */
export const RE_CLIENTE_PIDE = new RegExp([
  // "paso un pedido", "te envío el pedido", "quiero hacer un pedido", "cargá el pedido"
  String.raw`\b(?:hacer|hago|hacemos|pasar|paso|pasamos|armar|armo|cargar|cargo|tomar|tom[aá]me|mandar|mando|enviar|env[ií]o|enviamos|realizar|generar|levantar)\w*\s+(?:un\s+|el\s+|mi\s+|este\s+|otro\s+|nuevo\s+|nuestro\s+)*pedid(?:o|it[oa])`,
  String.raw`\b(?:quiero|queremos|necesito|necesitamos|me\s+gustar[ií]a|voy\s+a|vamos\s+a|quisiera)\s+(?:pedir|comprar|encargar)`,
  // archivos de pedido
  String.raw`\b(?:cotizador|cotizaci[oó]n|orden\s+de\s+compra|nota\s+de\s+pedido)`,
  // agregar o sumar a un pedido
  String.raw`\b(?:agreg|sum|anot|met|pon)[aáeéiíoó]\w*`,
  // cantidades: "6 cajas", "50 unidades", "cajas de pelapapas"
  String.raw`\b\d+\s*(?:cajas?|bultos?|unid\w*)`,
  String.raw`\b(?:cajas?|bultos?)\s+(?:de|del)\s`,
].join("|"), "i");

interface Fila { rol: string; contenido: string; creado_en: string }

/** `historial` viene del más nuevo al más viejo (como `bot_leer_historial`). Mira el último mensaje del bot de la última hora. */
export function ultimoDelBotEsDePedido(historial: Fila[], ahora = Date.now()): boolean {
  const ult = historial.find((h) => h.rol === "assistant");
  if (!ult) return false;
  const t = new Date(ult.creado_en).getTime();
  if (!Number.isFinite(t) || ahora - t > 60 * 60_000) return false;
  return RE_BOT_EN_PEDIDO.test(String(ult.contenido ?? ""));
}

/** ¿Este turno es de toma de pedido? Si el cliente pide o manda un cotizador, o contesta algo que sigue un pedido en curso. */
export function esTurnoDePedido(textoCliente: string, historial: Fila[], ahora = Date.now()): boolean {
  return RE_CLIENTE_PIDE.test(textoCliente) || ultimoDelBotEsDePedido(historial, ahora);
}

export interface ModeloFijo { id: number; provider: string; model: string; key: string; isFreeTier: boolean }

/** Candidatos de un turno de pedido: SOLO el modelo fijo, dos veces (la segunda es el reintento tras 1,5 s). Nunca otro proveedor:
 *  si Sonnet falla las dos veces, `runConversation` avisa a una persona (alerta `llm_error`) y el cliente no recibe una respuesta
 *  equivocada. id 0 y -2 no existen en `wa_agente_modelos`: nunca se marcan caídos ni sacan a Sonnet de la cadena. */
export function candidatosDePedido(modelo: string, apiKey: string): ModeloFijo[] {
  const base = { provider: "anthropic", model: modelo, key: apiKey, isFreeTier: false };
  return [{ id: 0, ...base }, { id: -2, ...base }];
}
