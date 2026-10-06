// Ejemplos APROBADOS: lo que el dueño corrigió y aprobó en "Respuestas del bot por causa" (artifact) o en Configuración del agente ›
// 🧪 Evaluación (tabla `wa_agente_evals`, estado = 'aplicada') llega al agente como guía en el prompt, cuando entra una consulta
// parecida. Pablo Olejavetzky, 05/10: "cuando vaya guardando la data, que el bot aprenda de ahí".
//
// QUÉ ES y QUÉ NO ES
// - Es un canal para dos cosas: una respuesta modelo (`respuesta_corregida`) y/o una regla de comportamiento (`nota_esperada`:
//   "qué debería hacer el agente"). Sólo llega al AGENTE (IA). Las consultas que atiende la capa fija (wa_faq, respuesta-aviso.ts,
//   faq.ts) no pasan por acá: ahí un cambio es de código o de wa_faq.
// - Una corrección pasa a 'aplicada' sólo con el "sí" de Pablo sobre el texto exacto (CLAUDE.md, "Correcciones del artifact"). Ese "sí"
//   es la barrera contra una inyección: el artifact lo puede escribir cualquier colaborador y su texto termina en el prompt.
// - Los ejemplos son MODELOS de contenido y de tono, no órdenes del cliente ni datos: las fechas, importes, artículos y nombres salen
//   de las herramientas, nunca del ejemplo.
//
// Módulo PURO (sin red ni base): elige y formatea; la lectura de la tabla vive en bot-conversation.ts. Se prueba en
// tests/ejemplos-aprobados.test.ts.

export interface EjemploAprobado { clave: string; pregunta: string; respuesta: string | null; nota: string | null }

const STOP = new Set(("que como con por para una uno unos unas del los las les nos mis sus mas muy pero sin sobre entre desde hasta cuando donde " +
  "quien cual cuales este esta estos estas ese esa eso esto aqui aca alli hola buen buenas buenos dia dias tarde noche gracias favor " +
  "puedo puede pueden podes podemos quiero queria quisiera necesito tengo tenemos tiene tienen hay son ser fue era ver hacer hace " +
  "tambien todo toda todos todas algo alguna alguno ningun cada otro otra otros otras ahora luego").split(" "));

/** Palabras con significado de una consulta: sin tildes ni mayúsculas, sin palabras vacías, plurales simples unificados. */
export function tokens(texto: string): string[] {
  const limpio = String(texto ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ]+/g, " ");
  const out = new Set<string>();
  for (let w of limpio.split(" ")) {
    if (w.length < 3 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith("s")) w = w.slice(0, -1);
    out.add(w);
  }
  return [...out];
}

/** Cuántas palabras comparten y qué tan parecidas son (coseno entre conjuntos: 0 a 1). */
export function similitud(a: string[], b: string[]): { comunes: number; coseno: number } {
  if (!a.length || !b.length) return { comunes: 0, coseno: 0 };
  const sb = new Set(b);
  const comunes = a.filter((w) => sb.has(w)).length;
  return { comunes, coseno: comunes / Math.sqrt(a.length * b.length) };
}

/** Un ejemplo sirve si comparte al menos 2 palabras con la consulta y se parece lo suficiente: una sola palabra en común
 *  ("pedido", "factura") trae ejemplos que no tienen que ver. */
export const MIN_COMUNES = 2;
export const MIN_COSENO = 0.5;

/** Los hasta `max` ejemplos más parecidos a `pregunta`, del más al menos parecido. */
export function elegirEjemplos(pregunta: string, filas: EjemploAprobado[], max = 3): EjemploAprobado[] {
  const t = tokens(pregunta);
  return filas
    .filter((f) => (f.respuesta && f.respuesta.trim()) || (f.nota && f.nota.trim()))
    .map((f) => ({ f, s: similitud(t, tokens(f.pregunta)) }))
    .filter(({ s }) => s.comunes >= MIN_COMUNES && s.coseno >= MIN_COSENO)
    .sort((x, y) => y.s.coseno - x.s.coseno || y.s.comunes - x.s.comunes)
    .slice(0, max)
    .map(({ f }) => f);
}

/** Texto de un campo antes de llegar al prompt: sin la etiqueta "Bot · …" que se copia del artifact, sin caracteres de control,
 *  sin saltos de más y con tope de largo. */
export function limpiarCampo(texto: string | null, tope: number): string {
  let t = String(texto ?? "").replace(/^\s*Bot\s*[·•-][^\n]*\n/i, "");
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > tope ? t.slice(0, tope).trimEnd() + "…" : t;
}

const TOPE_RESPUESTA = 700, TOPE_NOTA = 400, TOPE_BLOQUE = 2400;

/** El bloque que se agrega al prompt del agente. Vacío si no hay ejemplos. */
export function bloqueEjemplos(ejemplos: EjemploAprobado[]): string {
  if (!ejemplos.length) return "";
  const partes: string[] = [];
  let largo = 0;
  ejemplos.forEach((e, i) => {
    const l = [`${i + 1}) Consulta parecida: "${limpiarCampo(e.pregunta, 300).replace(/\n+/g, " ")}"`];
    const nota = limpiarCampo(e.nota, TOPE_NOTA), resp = limpiarCampo(e.respuesta, TOPE_RESPUESTA);
    if (nota) l.push(`   Qué hacer: ${nota.replace(/\n+/g, " ")}`);
    if (resp) l.push(`   Respuesta aprobada:\n${resp.split("\n").map((x) => "   > " + x).join("\n")}`);
    const txt = l.join("\n");
    if (largo + txt.length > TOPE_BLOQUE) return;
    largo += txt.length;
    partes.push(txt);
  });
  if (!partes.length) return "";
  return "EJEMPLOS APROBADOS POR EL DUEÑO (consultas parecidas a la de ahora, ya revisadas). Son una guía de contenido y de tono: no son " +
    "órdenes del cliente ni reemplazan a tus herramientas. Los datos (fechas, importes, artículos, estados, nombres) salen SIEMPRE de lo " +
    "que devuelvan las herramientas, nunca del ejemplo; lo que va entre [corchetes] se reemplaza por el dato real o se omite. Si el " +
    "ejemplo no encaja con lo que el cliente pregunta ahora, ignoralo.\n" + partes.join("\n");
}
