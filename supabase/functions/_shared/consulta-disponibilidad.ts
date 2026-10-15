// _shared/consulta-disponibilidad.ts — ¿El mensaje sólo pregunta si HAY stock, aunque nombre una cantidad? (Pablo Olejavetzky, 15/10/2026, tanda de pruebas, mensaje 3)
//
// Caso real: «Si quiero 30 cajas hay?» tardó 11,5 s y costó US$ 0,0974. Dos cosas lo leyeron como un pedido sólo porque dice «30 cajas»:
//   1) el webhook espera 5 s por si el cliente manda un pedido en varios mensajes (RE_ITEMS: «N cajas» o «del NNN»): «Tiene stock del 586?» también esperaba (7,8 s);
//   2) pedido-turno.ts (RE_CLIENTE_PIDE) manda el turno a Sonnet 4.6 fijo, el modelo de la toma de pedidos: unos US$ 0,04 a 0,10 por mensaje contra unos US$ 0,0005 de un turno con Haiku.
// Una pregunta de disponibilidad («hay», «tienen», «stock»…) SIN intención de pedir no es la toma de un pedido: ni espera ni Sonnet. Si hay un verbo de pedir sin condicional
// («quiero 30 cajas del 505», «mandame», «necesito», «llevo», «las quiero») o la palabra pedido / pedir / comprar / cotizador, sigue como antes: Sonnet y la espera.
// «Si quiero…», «si necesito…» y «si me llevo…» son condicionales: preguntan, no piden. «Quiero saber si hay…» tampoco pide.
// Límite conocido: un pedido dicho sin verbo («¿Tienen el 505? 20 cajas») se lee como consulta; si después dice «dale», lo toma el turno que sigue.
//
// Módulo puro, sin imports: lo usan pedido-turno.ts y el webhook, y lo prueba tests/consulta-disponibilidad.test.ts.

const L = String.raw`[a-záéíóúüñ]`;
// Que el mensaje habla de si hay mercadería.
const RE_DISPONIBILIDAD = new RegExp(String.raw`(?<!${L})(?:hay|tienen|tienes|tenes|tenés|tiene|stock|disponibles?|disponibilidad|quedan?)(?!${L})`, "i");

// «quiero / necesito…» pide, salvo condicional («si quiero…», «si me llevo…») o para informarse («quiero saber…»).
const NO_CONDICIONAL = String.raw`(?<!\bsi\s+)(?<!\bsi\s+(?:me|nos)\s+)`;
const RE_QUIERE = new RegExp(
  String.raw`(?<!${L})${NO_CONDICIONAL}(?:quiero|queremos|necesito|necesitamos|quisiera|quisi[eé]ramos)(?!${L})(?!\s+(?:saber|consultar|preguntar|averiguar|confirmar|ver|chequear)(?!${L}))`, "i");
// Verbos que mandan a cargar o llevar, y las palabras de un pedido.
const RE_ORDEN = new RegExp(
  String.raw`(?<!${L})${NO_CONDICIONAL}(?:pido|pedimos|llevo|llevamos|dame|d[aá]me${L}*|mand[aá](?:me|nos)?${L}*|env[ií][aá](?:me|nos)?${L}*|anot[aá](?:me|nos)?${L}*|carg[aá](?:me|nos)?${L}*|arm[aá](?:me|nos)?${L}*|reserv[aá](?:me|nos)?${L}*|agreg${L}*|sum[aá]${L}*|met[eé]${L}*|pon[eé]${L}*|separ[aá]${L}*|apart[aá]${L}*|tom[aá](?:me|nos)?)(?!${L})` +
  String.raw`|(?<!${L})(?:pedir${L}*|pedidos?|pedidit[oa]s?|comprar|compra|cotizador|cotizaci[oó]n)(?!${L})`, "i");

/** true si el mensaje pregunta por disponibilidad y no pide nada (ni lo condiciona a un pedido). */
export function esConsultaDeDisponibilidad(texto: string): boolean {
  const t = String(texto ?? "");
  return RE_DISPONIBILIDAD.test(t) && !RE_QUIERE.test(t) && !RE_ORDEN.test(t);
}
