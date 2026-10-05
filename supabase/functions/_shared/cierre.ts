// Pablo Olejavetzky, 05/10: el bot no cierra una respuesta con un "¿necesitás algo más?". Si el cliente tiene otra consulta
// la hace; si no, la charla termina ahí, y un cierre de cortesía queda sin sentido (o parece que el bot corta la charla).
// Dos capas: la regla CIERRE en el prompt (agente-fijos.ts) y este filtro sobre el texto final de la IA. El filtro existe
// porque el prompt no alcanza con todos los modelos (Gemini 3.5 Flash-Lite cerró con "¿Te podemos ayudar con algo más?"
// el 05/10 con la regla de formato a la vista).
//
// CONSERVADOR a propósito: sólo saca la ÚLTIMA oración cuando es un cierre genérico puro. NO toca las preguntas que piden un
// dato o una confirmación ("¿Agregamos 2 cajas?", "¿Querés agregar algo más al pedido?", "¿Te interesa alguno en particular?")
// ni los saludos de apertura ("¿En qué te puedo ayudar?", sin "más"). Si el texto entero fuera un cierre, se deja como está.

// Oraciones que son un cierre genérico. Se las busca ANCLADAS AL FINAL del texto (con emojis o espacios después).
const CIERRES: string[] = [
  // "¿Necesitás algo más?", "¿Necesitan algo más por hoy?", "¿Precisás algo más?"
  String.raw`¿\s*(?:necesit|precis)\p{L}*\s+algo\s+m[aá]s(?:\s+(?:por\s+(?:hoy|ahora)|hoy|de\s+(?:mi|nuestra)\s+parte|de\s+nosotros))?\s*\?`,
  // "¿Te podemos ayudar con algo más?", "¿Puedo ayudarte en algo más?", "¿Puedo ayudarte con algo más hoy?"
  String.raw`¿\s*(?:te\s+|le\s+|les\s+|nos\s+)?(?:podemos|puedo|podr[ií]amos|podr[ií]a)\s+ayud\p{L}*\s+(?:con|en)\s+algo\s+m[aá]s(?:\s+(?:por\s+(?:hoy|ahora)|hoy))?\s*\?`,
  // "¿En qué más te puedo ayudar?", "¿En qué más puedo ayudarte?"
  String.raw`¿\s*en\s+qu[eé]\s+m[aá]s\s+(?:(?:te|le|les)\s+)?(?:puedo|podemos)\s+ayud\p{L}*\s*\?`,
  // "¿Hay algo más en lo que te pueda ayudar?", "¿Hay algo más con lo que pueda ayudarte?"
  String.raw`¿\s*(?:hay|queda)\s+algo\s+m[aá]s\s+(?:en|con)\s+(?:lo\s+)?que\s+(?:te\s+|le\s+|les\s+)?(?:pueda|podamos)\s+ayud\p{L}*\s*\?`,
  // "¿Hay algo más?", "¿Algo más?", "¿Alguna otra consulta?", "¿Alguna duda más?"
  String.raw`¿\s*(?:(?:hay|queda)\s+)?algo\s+m[aá]s\s*\?`,
  String.raw`¿\s*(?:hay\s+)?alguna\s+(?:otra\s+)?(?:consulta|duda|cosa)(?:\s+m[aá]s)?\s*\?`,
  // Sin signos de pregunta: "Cualquier otra consulta, avisame", "Ante cualquier duda, escribinos", "Cualquier cosa me avisás"
  String.raw`(?:ante\s+|por\s+)?cualquier\s+(?:otra\s+)?(?:consulta|duda|cosa)\p{L}*[^.!?\n]{0,50}(?:avis\p{L}*|escrib\p{L}*|consult\p{L}*|dec\p{L}*|cont\p{L}*|pregunt\p{L}*|comunic\p{L}*)[^.!?\n]{0,25}[.!]?`,
  String.raw`(?:si\s+)?(?:necesit[aá]s|necesitan|precis[aá]s)\s+algo\s+m[aá]s[^.!?\n]{0,25}(?:avis\p{L}*|escrib\p{L}*|consult\p{L}*|dec\p{L}*|cont\p{L}*)[^.!?\n]{0,25}[.!]?`,
  // "Quedo a disposición", "Estamos a tu disposición para lo que necesites"
  String.raw`(?:quedo|quedamos|estamos|estoy)\s+(?:a\s+(?:(?:tu|su|vuestra)\s+)?disposici[oó]n|atent\p{L}*)[^.!?\n]{0,40}[.!]?`,
];

// Después del cierre puede quedar un emoji, un espacio o un signo suelto ("¿Necesitás algo más? 😊").
const COLA = String.raw`[\s\p{Extended_Pictographic}‍️.!]*`;
const RES_FINALES = CIERRES.map((c) => new RegExp(`(?:^|[\\s])(?:${c})${COLA}$`, "iu"));

/** Saca del final de `texto` los cierres genéricos ("¿Necesitás algo más?"). Devuelve el texto tal cual si no hay o si
 *  sacarlos lo dejaría vacío. */
export function sinCierreGenerico(texto: string): string {
  let t = texto;
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    let cambio = false;
    for (const re of RES_FINALES) {
      const sin = t.replace(re, "");
      if (sin !== t) { t = sin; cambio = true; }
    }
    if (!cambio) break;
  }
  t = t.replace(/\s+$/u, "");
  return t.trim() ? t : texto;
}
