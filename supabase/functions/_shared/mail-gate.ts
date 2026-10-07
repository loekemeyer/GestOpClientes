// Compuerta de `solicitar_cambio_mail`: el mail a cambiar tiene que estar ESCRITO por el cliente, no armado por el modelo
// (Pablo Olejavetzky, 06/10/2026, a partir del Simulador con Gemini 3.5 Flash-Lite, caso 9.4 / m76).
//
// Medido el 06/10: ante "noté que está cargada una dirección de correo que ya no tengo. Te envío la correcta para que puedan
// reemplazarla" (sin ninguna dirección en el mensaje), el modelo inventó el mail a partir de la razón social y llamó a la herramienta:
// `contacto@garbarinofranco.com.ar` en una corrida y `garbarinofrancotomas@gmail.com` en otra (2 de 2). Quedaba una tarea
// `cambio_datos` con un mail falso para que una persona lo aplicara, y al cliente se le decía "pedí que cambien tu mail a …".
//
// La regla de prompt ("confirmale el mail nuevo y, con su sí, usá solicitar_cambio_mail") no alcanza: la decide el modelo. Esto lo
// chequea el SERVIDOR: el mail que llega a la herramienta tiene que figurar, letra por letra (sin importar mayúsculas), en algún
// mensaje que escribió el cliente: el de ahora o uno de las últimas 12 horas (la misma ventana de "charla nueva" de la IA). Un mail que
// sólo aparece en lo que dijo el bot no sirve: lo que el cliente confirma con un "sí" es un mail que él mismo escribió antes.
//
// Módulo PURO (sin red ni base): se prueba en tests/mail-gate.test.ts. Falla cerrado: ante la duda NO se pide el cambio y el modelo
// le pide al cliente que escriba el mail completo. Límite conocido: si el cliente lo dicta como "juan arroba gmail punto com", no pasa
// (se le pide que lo escriba como nombre@dominio.com); y un mail dentro de un archivo o audio que el cliente mandó cuenta como escrito
// por él, igual que el resto de lo que llega como mensaje del cliente.

import type { FilaHistorial } from "./pedido-gate.ts";

/** Hasta cuándo vale un mail escrito por el cliente: igual que HORAS_CHARLA_NUEVA de bot-conversation.ts (12 h). */
export const VIGENCIA_MAIL_MS = 12 * 3600_000;

// Mail dentro de un texto: parte local, @, dominio con al menos un punto. Un punto final de la oración ("…@gmail.com.") queda afuera
// porque después de cada punto del dominio tiene que haber una letra o un número.
const RE_MAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Mail en la forma en que se compara: sin espacios ni "mailto:" y en minúsculas. */
export function normalizarMail(texto: string): string {
  return String(texto ?? "").trim().replace(/^mailto:/i, "").toLowerCase();
}

/** Todos los mails que aparecen en un texto, normalizados y sin repetir. */
export function mailsEscritos(texto: string): string[] {
  const hallados = String(texto ?? "").match(RE_MAIL) ?? [];
  return [...new Set(hallados.map(normalizarMail))];
}

export interface PedidoMail {
  /** El mail que el modelo le pasa a la herramienta. */
  mail: string;
  /** El mensaje del cliente de este turno (puede no estar guardado todavía en el historial). */
  textoCliente: string;
  /** Historial del más nuevo al más viejo, como `loadHistory`. */
  historial: FilaHistorial[];
  /** Hora de referencia en ms (para las pruebas); por defecto, ahora. */
  ahora?: number;
}

/** ¿Escribió el cliente ESTE mail, en este turno o en las últimas 12 horas? Sólo cuentan sus mensajes (`rol === "user"`). */
export function mailEscritoPorElCliente(p: PedidoMail): boolean {
  const buscado = normalizarMail(p.mail);
  if (!buscado) return false;
  if (mailsEscritos(p.textoCliente).includes(buscado)) return true;
  const ahora = p.ahora ?? Date.now();
  for (const h of p.historial) {
    if (h.rol !== "user") continue;
    const t = Date.parse(h.creado_en);
    // Sin fecha legible no se sabe si es de hoy: no cuenta (falla cerrado).
    if (!Number.isFinite(t) || ahora - t > VIGENCIA_MAIL_MS) continue;
    if (mailsEscritos(h.contenido).includes(buscado)) return true;
  }
  return false;
}

// ─── No repetir el pedido (Pablo Olejavetzky, 07/10/2026) ───────────────────────────────────────────────────────────────────────
// Medido el 06/10 en el Simulador (control positivo): el modelo llamó a `solicitar_cambio_mail` en el mensaje en que el cliente le dio
// el mail y otra vez cuando el cliente contestó "sí, confirmo": en producción son 2 tareas `cambio_datos` iguales para que las atienda
// una persona. La regla de prompt ("confirmale y, con su sí, llamala") no lo evitó; esto lo corta en código.

/** Cómo empieza el aviso que se le da al cliente cuando se pidió el cambio: de ahí se sabe, mirando la charla, qué mail ya se pidió. */
export const PREFIJO_PEDIDO_MAIL = "pedí que cambien tu mail a ";

/** Lo que se le dice al cliente cuando se registró el pedido (lo devuelve la herramienta y el modelo lo pasa tal cual). */
export const textoPedidoMail = (mail: string) => `Listo, ${PREFIJO_PEDIDO_MAIL}${mail}. Una persona lo revisa y te confirmamos por acá.`;

/** Lo que se le dice cuando ese mismo mail ya estaba pedido: no se crea otra tarea. */
export const textoYaPedidoMail = (mail: string) => `Ya lo pedí: una persona revisa el cambio de tu mail a ${mail} y te confirmamos por acá.`;

/** ¿El bot ya le dijo al cliente, en las últimas 12 horas de la charla, que pidió cambiar su mail A ESTE mail? Sólo cuentan los mensajes
 *  del bot (`rol === "assistant"`): que el cliente escriba la frase no frena nada. Es para el Simulador (donde no se guarda la alerta) y
 *  como primera defensa en producción; la segunda es buscar una alerta abierta con ese `mail_nuevo` (bot-conversation.ts). */
export function mailYaPedidoEnLaCharla(p: { mail: string; historial: FilaHistorial[]; ahora?: number }): boolean {
  const buscado = normalizarMail(p.mail);
  if (!buscado) return false;
  const ahora = p.ahora ?? Date.now();
  // Mismo patrón de mail que RE_MAIL, pero con el prefijo delante y sin la bandera "g" compartida.
  const re = new RegExp(`${PREFIJO_PEDIDO_MAIL}([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+)`, "gi");
  for (const h of p.historial) {
    if (h.rol !== "assistant") continue;
    const t = Date.parse(h.creado_en);
    if (!Number.isFinite(t) || ahora - t > VIGENCIA_MAIL_MS) continue;
    for (const m of String(h.contenido ?? "").matchAll(re)) if (normalizarMail(m[1]) === buscado) return true;
  }
  return false;
}

/** Lo que se le devuelve al modelo cuando la compuerta bloquea (mismo formato que la de `confirmar_pedido`). */
export const REGLA_MAIL_NO_ESCRITO =
  "No se pidió el cambio: ese mail no figura en lo que escribió el cliente. No lo armes ni lo deduzcas (ni de la razón social ni de " +
  "otra dirección). Pedile que escriba el mail nuevo completo (nombre@dominio.com), confirmáselo y, con su sí, llamá de nuevo con ESE mail, tal cual.";
