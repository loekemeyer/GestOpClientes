// "¿Hay forma de pasarla a Excel?" (Pablo Olejavetzky, 07/10/2026, corrección m42: "consultar qué es lo que quiere pasar a Excel, y según su respuesta derivarlo a donde corresponda").
// Dos pasos, sin IA: (1) el bot pregunta qué quiere pasar a Excel; (2) según la respuesta se deriva: lista de precios y pedidos → Ventas, facturas → Cobranzas, otra cosa → Ventas.
// Módulo PURO, sin imports: lo usan faq.ts (el paso 1) y respuesta-aviso.ts (el paso 2) y lo prueba tests/pasar-excel.test.ts.

/** La pregunta; también es la marca con la que el bot reconoce, en el mensaje siguiente, que el cliente la está contestando. */
export const PREGUNTA_EXCEL = "¿Qué querés pasar a Excel: la lista de precios, tus pedidos, tus facturas u otra cosa?";

// Sin \b al final de las palabras con tilde (la "ó" no es \w en JS): se cierra con "no sigue una letra".
const FIN = "(?![a-záéíóúñ])";
const INI = "(?<![a-záéíóúñ])";
const RE_PIDE_EXCEL = new RegExp(`${INI}(pas[a-záéíóúñ]*|export[a-záéíóúñ]*|descarg[a-záéíóúñ]*|baj[a-záéíóúñ]*|tener|tienen|tiene|hay|mand[a-záéíóúñ]*|env[ií][a-záéíóúñ]*|pued[a-záéíóúñ]*|podr[a-záéíóúñ]*|forma|manera|posible|quer[a-záéíóúñ]*|quier[a-záéíóúñ]*|quisi[a-záéíóúñ]*|necesit[a-záéíóúñ]*)${FIN}[^.?!]{0,40}${INI}excel${FIN}`, "i");
// No es un pedido de Excel: manda uno ("te paso el Excel"), habla del cotizador (lo toma m41) o no puede abrirlo.
const RE_EXCEL_OTRA_COSA = new RegExp(`${INI}cotizador${FIN}|${INI}(te|les)\\s+(paso|pasamos|mando|mandamos|env[ií]o|enviamos)${FIN}|${INI}adjunt[a-záéíóúñ]*|${INI}no\\s+(me\\s+|nos\\s+)?(pued|pod|abre|abren|anda|funciona|carga|deja)[a-záéíóúñ]*|${INI}(error|falla|se\\s+(tilda|traba|cuelga))${FIN}`, "i");
export const pideExcel = (text: string): boolean => RE_PIDE_EXCEL.test(text) && !RE_EXCEL_OTRA_COSA.test(text);

export type ClaseExcel = "lista" | "pedidos" | "facturas" | "otra";
const RE_FACTURAS = new RegExp(`${INI}(facturas?|comprobantes?|cuenta\\s+corriente|saldo|deuda|pagos?)${FIN}`, "i");
const RE_PEDIDOS = new RegExp(`${INI}pedidos?${FIN}`, "i");
const RE_LISTA = new RegExp(`${INI}(lista|precios?|cat[aá]logo|productos?|art[ií]culos?)${FIN}`, "i");
/** Qué nombra el texto: facturas, pedidos o lista de precios (en ese orden si nombra varias); null si no nombra ninguna de las tres. */
export function claseNombrada(text: string): Exclude<ClaseExcel, "otra"> | null {
  const t = String(text ?? "");
  if (RE_FACTURAS.test(t)) return "facturas";
  if (RE_PEDIDOS.test(t)) return "pedidos";
  if (RE_LISTA.test(t)) return "lista";
  return null;
}

/** ¿El mensaje parece la respuesta a la pregunta? Corto, sin signo de pregunta y que no sea sólo un agradecimiento. */
export function esRespuestaAExcel(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t || t.length > 80 || /[?¿]/.test(t)) return false;
  return !/^(gracias|muchas\s+gracias|ok|okey|dale|listo|perfecto|buenas?|hola)[\s!.,😊🙏👍]*$/i.test(t);
}

export type DerivacionExcel = { reply: string; motivo: "nota_cliente" | "pago"; detalle: string };
/** A dónde va cada respuesta, con el texto que aprobó Pablo (07/10): lista de precios y pedidos → Ventas (`nota_cliente`), facturas → Cobranzas (`pago`), otra cosa → Ventas. */
export function derivacionExcel(clase: ClaseExcel, texto: string): DerivacionExcel {
  const t = String(texto ?? "").slice(0, 200);
  if (clase === "lista") return { reply: "Le paso tu pedido de la lista de precios en Excel a Ventas para que te escriban por acá a la brevedad. 🙏", motivo: "nota_cliente", detalle: `Pidió la lista de precios en Excel: ${t}` };
  if (clase === "pedidos") return { reply: "Le paso tu pedido de tus pedidos en Excel a Ventas para que te escriban por acá a la brevedad. 🙏", motivo: "nota_cliente", detalle: `Pidió sus pedidos en Excel: ${t}` };
  if (clase === "facturas") return { reply: "Le paso tu pedido de tus facturas en Excel a Cobranzas para que te escriban por acá a la brevedad. 🙏", motivo: "pago", detalle: `Pidió sus facturas en Excel: ${t}` };
  return { reply: "Le paso tu consulta a Ventas para que te escriban por acá a la brevedad. 🙏", motivo: "nota_cliente", detalle: `Pidió pasar algo a Excel (otra cosa): ${t}` };
}
