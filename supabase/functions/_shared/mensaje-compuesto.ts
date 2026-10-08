// _shared/mensaje-compuesto.ts — ¿El mensaje pide más de una cosa? ¿La respuesta fija ya se mandó hace un rato? (Pablo Olejavetzky, 08/10/2026)
//
// Caso real (Chef 411, 08/10 09:32, tres audios): "Quería saber cuándo sale mi pedido y si podés tener 200 docenas de artículo 505 de entrega
// inmediata" lo contestó la regla de entrega rápida ("Una persona de Ventas revisa si se puede acelerar la entrega") y "¿Tenés hieleras? … pasame
// precio. Y del 505, quiero saber cuántas unidades hay por caja" la FAQ #11 (lista de precios en la web), el mismo texto que había salido 24 s antes.
// La capa fija (faq.ts) contesta con la PRIMERA regla que coincide y tira el resto del mensaje: no ve que hay varios pedidos ni lo que ya se dijo.
// Pablo: "Tiene que tener una respuesta más natural, tenés que entender mejor todo el contexto" → "Si hacelo" a: la capa fija sólo para mensajes
// simples, lo compuesto y lo repetido al agente (que lee el historial) con lo que la capa fija habría contestado como pista.
//
// Módulo puro, sin imports: lo usan faq.ts, el webhook, el Simulador y el chat de prueba, y lo prueba tests/mensaje-compuesto.test.ts.

/** Minúsculas y sin acentos, carácter por carácter: el resultado tiene el MISMO largo que el original, así los cortes sirven para los dos. */
function normalizar(t: string): string {
  let s = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    const b = c.normalize("NFD").charAt(0).toLowerCase();
    s += b.length === 1 ? b : c;
  }
  return s;
}

// Dónde empieza otro pedido dentro del mensaje:
//  - fin de oración (. ! ? ; salto de línea). El "¿" NO corta: "Te consulto, ¿me dirías el precio?" es un solo pedido (m72).
//  - "y" / "e" seguido de algo que abre otra consulta ("… mi pedido y si podés tener…", "… y del 505 quiero saber…").
//  - ", además" / ", también" / "y aparte" / "otra cosa": sólo con coma o "y" antes; "Quería también saber" es uno solo.
const RE_CORTE = new RegExp(
  "[.!?;\\n]+" +
    "|\\s+[ye]\\s+(?=(?:si|me|te|nos|del?|queria|queriamos|quiero|quisiera|pasame|pasas|mandame|decime|avisame|tenes|tienen|hay|podes|pueden|podrias|podrian|cuando|donde|cual|cuales)\\b|necesit|cuant)" +
    "|(?:,\\s*|\\s+y\\s+)(?:tambien|ademas|aparte|por otro lado|otra (?:cosa|consulta|pregunta))\\b",
  "g",
);

// Un pedido tiene un verbo de pedido o una palabra de pregunta. Sin eso, la oración es contexto o un agregado de la anterior: "Paso un pedidito.
// ¿Puede estar para el viernes?" (m62), "¿Mismos precios, mismo todo?" (m77) y "El total … ¿verdad?" (m70) no suman otro pedido. "qué" y "cómo"
// solos no cuentan: "¿Qué tal?", "¿Cómo andás?" son saludo.
const RE_SENAL = new RegExp(
  "\\b(?:quer(?:ia|iamos|emos)|quiero|quisiera(?:mos)?|necesit\\w*|pas(?:ame|anos|as|arias?|arian|an)|mand(?:ame|anos|as|arias?|arian|an)" +
    "|envi(?:ame|anos|as|an)|deci(?:me|nos|s)|dirias|avis(?:ame|anos|as|en)|confirm(?:ame|anos|as|en)|cotiz(?:ame|anos|as|ar)" +
    "|tenes|tienen|tendr(?:ias|ian|an)|hay|habria|pod(?:es|emos|rias?|rian|ra|ran)|pueden?|puedo|cuant[oa]s?|cuando|donde|cual(?:es)?" +
    "|por\\s*que|como\\s+(?:hago|hacemos|es|son|se|puedo|podemos|funciona|pago|pagamos)|saber|consult(?:o|ar|arte|arles)" +
    // "Te paso el comprobante, además quería saber…": mandar algo también es un pedido (lo contesta una respuesta fija, m11 y m28).
    "|(?:te|les)\\s+(?:paso|pasamos|mando|mandamos|envio|enviamos|adjunto)|adjunt(?:o|amos))\\b",
);

// Una parte que vuelve sobre lo anterior con un pronombre ("… y necesito que me LA manden por mail", "LO necesito para el viernes") sigue el mismo
// pedido: no suma otro. Sólo se mira desde la segunda parte.
const RE_SIGUE_LO_ANTERIOR = /\b(?:me|te|nos|se)\s+(?:lo|la|los|las)\b|^(?:y\s+)?(?:lo|la|los|las)\s/;

/** Las partes del mensaje que piden algo, con el texto original, en orden. "Hola, buen día." y las oraciones de contexto no cuentan. */
export function pedidosDelMensaje(texto: string): string[] {
  const t = String(texto ?? "");
  const n = normalizar(t);
  const partes: string[] = [];
  let desde = 0;
  const agregar = (hasta: number) => {
    const seg = t.slice(desde, hasta).trim().replace(/^[,¿¡\s]+|[,\s]+$/g, "");
    const ns = normalizar(seg);
    if (seg && RE_SENAL.test(ns) && !(partes.length && RE_SIGUE_LO_ANTERIOR.test(ns))) partes.push(seg);
  };
  for (const m of n.matchAll(RE_CORTE)) {
    agregar(m.index!);
    desde = m.index! + m[0].length;
  }
  agregar(t.length);
  return partes;
}

/** true si el mensaje pide dos cosas o más: la capa fija no lo contesta, va al agente con las pistas. */
export function mensajeCompuesto(texto: string): boolean {
  return pedidosDelMensaje(texto).length >= 2;
}

const compactar = (t: string) => normalizar(String(t ?? "")).replace(/\s+/g, " ").trim();

/** ¿Esta respuesta fija ya salió en alguno de los mensajes recientes del bot? Lo guardado puede llevar delante el saludo ("¡Hola …! 👋")
 *  o la etiqueta de marca: se busca el texto adentro. Las respuestas cortas (menos de 30 letras) no cuentan: repetirlas no molesta. */
export function yaLoDijo(respuesta: string, recientes: string[]): boolean {
  const r = compactar(respuesta);
  if (r.length < 30) return false;
  return recientes.some((x) => compactar(x).includes(r));
}

/** Cuánto atrás se mira para no repetir una respuesta fija (minutos). */
export const MINUTOS_SIN_REPETIR = 30;

/** Los mensajes del bot de los últimos MINUTOS_SIN_REPETIR, del historial que devuelve loadHistory (webhook o Simulador). */
export function respuestasRecientes(historial: Array<{ rol: string; contenido: string; creado_en: string }>, ahora = Date.now()): string[] {
  const desde = ahora - MINUTOS_SIN_REPETIR * 60_000;
  return historial.filter((h) => h.rol === "assistant" && new Date(h.creado_en).getTime() >= desde).map((h) => String(h.contenido ?? ""));
}

/** "200 docenas", "6 cajas", "48 unidades": una cantidad con su unidad. "Entrega inmediata" + cantidad es una consulta de stock, no adelantar un pedido. */
export const RE_CANTIDAD_CON_UNIDAD = /\b\d+(?:[.,]\d+)?\s*(?:docenas?|cajas?|cj|unidades|u|bultos?)\b/i;

const recortar = (t: string, max: number) => (t.length > max ? t.slice(0, max - 1) + "…" : t);

/** Una pista: lo que la capa fija contestaría a una parte del mensaje. */
export function pistaDeParte(parte: string, respuesta: string, deriva: string | null): string {
  return `- Para «${recortar(parte, 200)}», la respuesta fija aprobada es: «${recortar(respuesta.trim(), 700)}»` +
    (deriva ? ` (además deriva a una persona: motivo ${deriva}).` : ".");
}

/** La pista cuando la respuesta fija ya se le mandó hace un rato. */
export function pistaRepetida(respuesta: string): string {
  return `- La respuesta fija para este mensaje sería «${recortar(respuesta.trim(), 700)}», pero ya se la mandaste en esta charla hace menos de ` +
    `${MINUTOS_SIN_REPETIR} minutos (está en el historial). No se la repitas igual.`;
}

/** Bloque que se suma al final del prompt del agente. Vacío si no hay pistas. */
export function bloquePistas(pistas: string[]): string {
  if (!pistas.length) return "";
  return "PISTAS DE LAS RESPUESTAS FIJAS PARA ESTE MENSAJE (salen de palabras clave, por eso este mensaje no se contestó con una respuesta fija):\n" +
    pistas.join("\n") + "\n" +
    "Cómo usarlas: contestá TODO lo que el cliente pide en este mensaje, en UN solo mensaje natural y en el orden en que lo pidió, " +
    "teniendo en cuenta lo que ya se habló. Cada parte lleva su respuesta, aunque sea que no hay dato: si pregunta por su pedido y no le figura " +
    "ninguno pendiente, decíselo con esas palabras (y seguí la regla del pedido que no figura); nunca saltees una parte ni la cambies por otra cosa. " +
    "Si una pista contesta una parte, usá su contenido sin cambiar datos, montos, fechas ni a quién se deriva; " +
    "podés unirla con el resto en vez de copiarla entera. Si una pista no corresponde a lo que el cliente quiso decir, ignorala. " +
    "Si una pista deriva y corresponde, llamá a derivar_a_persona con ese motivo. Lo que ninguna pista cubre, resolvelo con tus herramientas. " +
    "No repitas un texto que ya le mandaste en esta charla: si ya se lo dijiste, referite a eso en pocas palabras.";
}
