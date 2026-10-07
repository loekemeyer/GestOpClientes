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
