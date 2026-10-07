// "Nos llegó al mail las facturas, ¿lo entregan hoy?" (Pablo Olejavetzky, 07/10/2026, corrección m68: "preguntarle a qué mail le llegan las facturas para chequear").
// Elegida la opción A: el bot pregunta a qué mail le llegaron las facturas y, con la respuesta, la compara con el mail de la ficha del cliente (customers.mail); si no
// coincide, una persona de Ventas lo revisa. Nunca le muestra el mail registrado. Módulo PURO, sin imports: lo usan faq.ts (la pregunta) y respuesta-aviso.ts (la respuesta),
// y lo prueba tests/mail-facturas.test.ts.

/** La pregunta que se suma a la lista de pedidos; también es la marca con la que el bot reconoce, en el mensaje siguiente, que el cliente la está contestando. */
export const PREGUNTA_MAIL_FACTURAS = "¿A qué mail te llegaron las facturas? Lo chequeo.";

export const TEXTO_MAIL_COINCIDE = "Perfecto, es el mismo que tenemos registrado.";
export const TEXTO_MAIL_NO_COINCIDE = "Ese mail no coincide con el que tenemos registrado. Una persona de Ventas lo revisa y te escribe por acá.";
/** La ficha no tiene mail (95 de 1.263 clientes al 07/10) o no se pudo leer: no hay con qué comparar, se lo pasa a Ventas. Texto de la opción B que vio Pablo. */
export const TEXTO_MAIL_SIN_REGISTRO = "Gracias, se lo paso a Ventas para que lo chequee.";

// Sin \b al final de las palabras con tilde: en JS la "ó" no es \w y "llegó " no tendría borde. Se cierra con "no sigue una letra".
const FIN = "(?![a-záéíóúñ])";
const RE_FACTURA = new RegExp(`\\bfacturas?${FIN}`, "i");
const RE_MAIL = new RegExp(`\\b(e-?mail|mail|correo)${FIN}`, "i");
const RE_LLEGO = new RegExp(`\\b(lleg[oó]|llegaron|recib[a-záéíóúñ]*|vino|vinieron|nos\\s+(mandaron|enviaron))${FIN}`, "i");
const RE_NO_LLEGO = new RegExp(`\\bno\\s+(me\\s+|nos\\s+|te\\s+)?(lleg[a-záéíóúñ]*|recib[a-záéíóúñ]*|vino|vinieron|mandaron|enviaron)${FIN}`, "i");
const RE_PREGUNTA_ENTREGA = new RegExp(`\\b(entreg[a-záéíóúñ]*|retir[a-záéíóúñ]*|cu[aá]ndo|hoy|ma[nñ]ana|pedido|mercader[ií]a)${FIN}`, "i");

/** El cliente dice que las facturas ya le llegaron por mail y pregunta por la entrega del pedido. No cuenta "no me llegó la factura" (eso lo toma el reenvío) ni un
 *  "ya nos llegó la factura, gracias" sin pregunta. */
export function avisaFacturaPorMail(text: string): boolean {
  const t = String(text ?? "");
  return RE_FACTURA.test(t) && RE_MAIL.test(t) && RE_LLEGO.test(t) && !RE_NO_LLEGO.test(t) && RE_PREGUNTA_ENTREGA.test(t);
}

const RE_DIRECCION = /[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,}/gi;
/** Los mails que escribe el cliente, en minúsculas y sin repetidos. */
export function mailsEscritos(text: string): string[] {
  return [...new Set((String(text ?? "").match(RE_DIRECCION) ?? []).map((m) => m.toLowerCase()))];
}

/** Los mails de la ficha (customers.mail puede traer varios, separados por coma, punto y coma o espacio; 156 de 1.263 clientes al 07/10): minúsculas, sin vacíos ni
 *  sin arroba (16 fichas no tienen). */
export function mailsRegistrados(campo: string | null | undefined): string[] {
  return [...new Set(String(campo ?? "").toLowerCase().split(/[\s,;]+/).map((m) => m.trim().replace(/[.,;:]+$/, "")).filter((m) => m.includes("@")))];
}

export type ResultadoMail = { tipo: "coincide" } | { tipo: "no_coincide"; distintos: string[] } | { tipo: "sin_registro" };
/** Coincide sólo si TODOS los mails que dice el cliente están en la ficha; si alguno no está, no coincide (y se lo pasa a Ventas con los que no están). */
export function compararMails(dichos: string[], registrados: string[]): ResultadoMail {
  if (!registrados.length) return { tipo: "sin_registro" };
  const distintos = dichos.filter((d) => !registrados.includes(d));
  return distintos.length ? { tipo: "no_coincide", distintos } : { tipo: "coincide" };
}
