// Cómo se dice el estado de un pedido que el cliente RETIRA en el depósito, en la lista de pedidos por entregar (Pablo Olejavetzky, 06 y 07/10/2026, correcciones
// m21, m24, m25, m2 y m68 del artifact). Primero (06/10) "tenés que sacar el retirar cuando te preguntan cuándo se entrega" → "programado para el lunes 05/10"; después
// (07/10) "se tendría que tener en cuenta si el pedido es para retirar o para entregar, eso cambia el tipo de respuesta" → "sí, ese texto": un pedido de retiro ya facturado
// dice "listo para retirar" (en Gestión, para el depósito, 'facturado' = armado y con factura: es cuando sale el aviso pedido_listo_retirar) y el título dice "que falta retirar".
// Módulo puro, sin imports: lo usan faq.ts (lookupOrderStatus) y pedidos-marca.ts, y lo prueba tests/fecha-retiro.test.ts.

/** El estado de un pedido de RETIRO con su día. `estado`: programado | en preparacion | facturado (el resto no lleva este texto); `texto`: el estado tal como se muestra
 *  hoy ("🚚 programado", "🛠️ en preparación en el depósito", "🧾 facturado, listo para salir"); `dia`: "martes 06/10" o null si no hay fecha. */
export function textoEstadoRetiro(estado: string, texto: string, dia: string | null): string {
  if (estado === "facturado") return dia ? `🧾 facturado, listo para retirar desde el ${dia}` : "🧾 facturado, listo para retirar";
  if (!dia) return texto;
  if (estado === "programado") return `${texto} para el ${dia}`;
  return `${texto}: va a estar listo para retirar desde el ${dia}`;
}

/** El título de la lista: "que falta retirar" si TODOS son de retiro; "pendientes" si hay retiro mezclado con reparto o expreso; null = sigue el título de siempre. */
export function tituloPorRetiro(retiros: boolean[], unoSolo: boolean, de = ""): string | null {
  if (!retiros.length || !retiros.some(Boolean)) return null;
  const d = de ? ` ${de}` : "";
  if (retiros.every(Boolean)) return unoSolo ? `este es tu pedido${d} que falta retirar` : `estos son tus pedidos${d} que faltan retirar`;
  return `estos son tus pedidos${d} pendientes`;
}

/** Pablo, 07/10 (m2): "Hice un pedido hace 10 días, quería saber si está confirmado" → la lista abre con "tu pedido está confirmado:" en vez de "este es tu pedido que falta…". */
export function tituloConfirmado(unoSolo: boolean): string {
  return unoSolo ? "tu pedido está confirmado" : "tus pedidos están confirmados";
}
/** El cliente pregunta si el pedido está confirmado ("¿está confirmado?", "¿lo confirmaron?", "¿tienen la confirmación?"). */
export const pideConfirmacionPedido = (text: string): boolean => /\bconfirm(ad[oa]s?|[oó]|aron|aci[oó]n)(?![a-záéíóúñ])/i.test(text);

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
/** "2026-10-06" → "martes 06/10". */
export function diaConFecha(iso: string): string {
  const x = new Date(String(iso).slice(0, 10) + "T12:00:00Z");
  return `${DIAS[x.getUTCDay()]} ${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** El estado de un pedido de RETIRO ya redactado para que el agente de IA lo diga tal cual (Pablo, 07/10, m1 y m23: "si el pedido era para retirar, en vez de 'salió' tiene que poner
 *  que fue retirado tal fecha"; "si salió del depósito, ¿cómo va a pasar a retirarlo?"). El agente traducía `fecha_salida` como "salió": un pedido de retiro no sale, lo retira el cliente.
 *  `estado`: el de Gestión (recibido, programado, en preparacion, facturado, entregado); `fecha`: yyyy-mm-dd o null. */
export function estadoRetiroParaIA(estado: string, fecha: string | null): string {
  const dia = fecha ? diaConFecha(fecha) : null;
  switch (estado) {
    case "entregado": return dia ? `retirado el ${dia}` : "retirado";
    case "facturado": return dia ? `facturado y listo para retirar desde el ${dia}` : "facturado y listo para retirar";
    case "programado": return dia ? `programado para el ${dia}` : "programado, todavía sin fecha";
    case "en preparacion": return dia ? `en preparación en el depósito; va a estar listo para retirar desde el ${dia}` : "en preparación en el depósito";
    default: return "recibido, todavía sin fecha";
  }
}

// ── Retiro en el depósito: preguntar la franja y avisar a Ventas (Pablo Olejavetzky, 07/10/2026, correcciones m36 y m37) ──
// "También debería consultar en qué horario estimativo pasa (mañana o tarde) y dar un aviso a Ventas para que lo tengan a mano" → "sí, ese texto".
// Quien usa esto es respuesta-aviso.ts (pedidoDeCambio): la respuesta fija "Sí, podés retirar…" suma la pregunta y deja un aviso a Ventas (motivo entrega); si el cliente
// contesta la franja, se confirma y sale un segundo aviso que lo completa. Todo puro: se prueba en tests/fecha-retiro.test.ts.

/** La pregunta de la franja; también es la marca con la que el bot reconoce, en el mensaje siguiente, que el cliente la está contestando. */
export const PREGUNTA_FRANJA = "¿Pasás por la mañana o por la tarde?";

/** "Sí, podés retirar tu pedido del 30/09 el jueves 08/10…" con la pregunta de la franja (si `preguntaFranja`) y el aviso a Ventas.
 *  Sin la pregunta cuando ya no tiene sentido (hoy, pasado el mediodía: sólo queda la tarde). */
export function textoRetiroConfirmado(del: string, dia: string, preguntaFranja: boolean): string {
  const base = `Sí, podés retirar tu pedido del ${del} el ${dia}, de 9 a 12 o de 13 a 16:30 h, en Virgilio 2788. ✅`;
  return preguntaFranja
    ? `${base}\n${PREGUNTA_FRANJA} Le avisamos a Ventas para que lo tenga a mano.`
    : `${base}\nLe avisamos a Ventas para que lo tenga a mano.`;
}

/** Lo que contesta el cliente cuando elige la franja. */
export const textoFranjaConfirmada = (dia: string, franja: "mañana" | "tarde"): string =>
  `Perfecto, te esperamos el ${dia} por la ${franja}. Ya le avisamos a Ventas.`;

/** La franja que elige el cliente en un mensaje corto ("a la mañana", "por la tarde", "mañana a la tarde" = la tarde). null si no dice una sola, o si el mensaje es largo
 *  (una frase larga sobre otro tema no es la respuesta a la pregunta). */
export function franjaDeRetiro(text: string): "mañana" | "tarde" | null {
  const t = String(text ?? "").trim();
  if (!t || t.length > 60) return null;
  const n = t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\b(puedo|podemos|podria|podriamos)\b/.test(n)) return null;   // "¿mañana puedo pasar?" es otra pregunta de día, no la franja
  const tarde = /\btarde\b/.test(n);
  const manana = /\b(manana|temprano)\b/.test(n);
  if (tarde && manana) return /\bo\b/.test(n) ? null : "tarde";   // "mañana a la tarde" = mañana, por la tarde; "a la mañana o a la tarde" no eligió
  return tarde ? "tarde" : manana ? "mañana" : null;
}

/** Del mensaje anterior del bot ("Sí, podés retirar tu pedido del 30/09 el jueves 08/10, …\n¿Pasás por la mañana o por la tarde? …") saca de qué pedido y qué día se hablaba.
 *  null si ese mensaje no era la pregunta de la franja. */
export function retiroInformado(ultimoMensajeBot: string): { del: string; dia: string } | null {
  if (!String(ultimoMensajeBot ?? "").includes(PREGUNTA_FRANJA)) return null;
  const m = /pedido del (\d{2}\/\d{2}) el ((?:lunes|martes|miércoles|jueves|viernes|sábado|domingo) \d{2}\/\d{2})/.exec(ultimoMensajeBot);
  return m ? { del: m[1], dia: m[2] } : null;
}

// ── "Estoy llegando, ¿me esperan?" (Pablo Olejavetzky, 07/10/2026, corrección m39: "darle un aviso urgente a Ventas para confirmar que pueden esperarlo") ──
// Antes el bot prometía "¡Te esperamos!" sin saber si se podía y sin avisarle a nadie. Ahora le dice que consulta a Ventas y deja una alerta `entrega`: urgente si el depósito
// está abierto en ese momento, no urgente si está cerrado (extensión mía, aprobada junto con el texto: Ventas no se despierta por alguien que llega a un depósito cerrado).

/** El texto que aprobó Pablo; `horarioDeposito` es la línea fija del depósito ("Estamos en Virgilio 2788, Villa Devoto, de lunes a viernes de 9 a 12 y de 13 a 16:30 (…)"). */
export const textoLlegando = (horarioDeposito: string): string =>
  `Le aviso ahora mismo a Ventas para confirmar que te puedan esperar y te escribimos por acá en un momento. 🙏\n${horarioDeposito}`;

/** ¿Está abierto el DEPÓSITO en `ahora`? De lunes a viernes de 9 a 12 y de 13 a 16:30 (hora de Argentina, UTC-3), menos los `feriados` ("AAAA-MM-DD"). Distinto del
 *  horario de atención telefónica de horario.ts (9 a 17, un solo tramo). */
export function depositoAbierto(ahora: Date, feriados: string[] = []): boolean {
  const ar = new Date(ahora.getTime() - 3 * 3600_000);
  const dia = ar.getUTCDay();
  if (dia === 0 || dia === 6) return false;
  if (feriados.includes(ar.toISOString().slice(0, 10))) return false;
  const min = ar.getUTCHours() * 60 + ar.getUTCMinutes();
  return (min >= 9 * 60 && min < 12 * 60) || (min >= 13 * 60 && min < 16 * 60 + 30);
}
