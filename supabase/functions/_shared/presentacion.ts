// _shared/presentacion.ts — Cómo se presenta el bot cuando le preguntan qué es (Pablo Olejavetzky y Damián, 08/10/2026).
//
// Caso (Chef 411, 08/10 09:42): «Vos sos un bote, un agente o una persona» lo agarró la FAQ #33 (contacto_vendedor) por la palabra clave «una persona»:
// contestó «Le paso tu mensaje a un asesor…» y creó una alerta (859) que nadie pidió. Las preguntas que siguieron las contestó la IA a su manera («Soy un
// asistente automático (bot)», «Sí, soy un bot 😄»): nada le decía cómo presentarse. Damián: «Tendríamos que decir que sos un Agente especializado, que podés
// ayudarlo en conocer muchas cosas de nuestra relación comercial: compras que hice, productos que me encomendarías». Pablo aprobó el texto («Si hacelo»).
// Límite que no se mueve: el bot nunca dice ni insinúa que es una persona.
//
// Módulo puro, sin imports: lo usan faq.ts (respuesta fija) y agente-fijos.ts (regla del agente). Lo prueba tests/faq-presentacion.test.ts.

/** Texto aprobado por Pablo el 08/10. */
export const TEXTO_PRESENTACION =
  "Soy el agente de Loekemeyer, especializado en tu cuenta: te ayudo con tus pedidos, tus compras, tus facturas, el stock y los productos que te pueden servir. " +
  "Si algo necesita a una persona del equipo, le aviso y te escribe por acá.";

const QUE = "(?:bot|bote|boot|robot|agente|persona|humano|humana|m[aá]quina|ia|inteligencia artificial|programa|contestador(?:a)? autom[aá]tic[oa])";
// «¿sos un bot?», «vos sos un bote, un agente o una persona», «¿eres una IA?», «¿estoy hablando con una persona?», «lo que me respondió es un boot o un agente».
// En tercera persona («es un …») no cuenta «persona»: «¿es una persona la que me va a llamar?» es otra cosa.
const RE_QUE_ES = new RegExp(
  `\\b(?:sos|eres|son)\\s+(?:un[ao]?\\s+)?${QUE}\\b` +
    `|\\b(?:hablo|hablando|chateo|chateando|escribo|escribiendo)\\s+con\\s+(?:un[ao]?\\s+)?${QUE}\\b` +
    `|\\bes\\s+(?:un[ao]?\\s+)?(?:bot|bote|boot|robot|agente|m[aá]quina|ia|inteligencia artificial|programa)\\b`,
  "i",
);

/** ¿Pregunta qué es el que le contesta (bot, agente, persona)? Sólo con signo de pregunta o con «o» entre opciones, para no tomar «sos un genio». */
export function preguntaQueEs(texto: string): boolean {
  const t = String(texto ?? "");
  if (!RE_QUE_ES.test(t)) return false;
  return /[?¿]/.test(t) || /\b(?:o|u)\s+(?:un[ao]?\s+)?(?:bot|bote|boot|robot|agente|persona|humano|humana|m[aá]quina|ia)\b/i.test(t) ||
    /\b(?:pregunto|preguntaba|quiero saber|quer[ií]a saber|decime si)\b/i.test(t);
}
