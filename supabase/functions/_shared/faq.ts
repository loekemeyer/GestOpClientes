// Flujo cara-al-cliente 2026-09-04: no-cliente prioriza institucional; lookup payment_data
//   (alias/CBU desde wa_descuentos_config). Deploy vía CI al pushear a main.
// _shared/faq.ts — Pre-check de FAQs (respuestas AUTO/SEMIAUTO/HUMANO)
// que corre antes de tocar el LLM. Consume la tabla `wa_faq` vía la RPC
// `wa_faq_match` y elige entre `bot_response` (cliente identificado) e
// `institutional_response` (sin cliente, tono institucional).
//
// El agente conversacional (`runConversation`) queda como último recurso:
// solo se invoca si acá no hay match útil.

import { getGestionClient, getIsisClient, getSetting, supabase } from "./supabase.ts";
import { notificarHumano } from "./alertas.ts";
import { stockArticulo, stockNecesitaHumano, textoStock } from "./stock.ts";
import { estadoPedidos, sinAnulados } from "./pedidos-anulados.ts";
import { codigosChef, datosCobranzas, datosEmpresas, deudaChefPorCuit, type FacturaDoc, facturasChef, textoDatosPago } from "./empresas.ts";
import { fmtMinimo, minimoCliente } from "./minimo.ts";

// deno-lint-ignore no-explicit-any
export type Customer = { id: string; cod_cliente: number; business_name: string; dto_vol?: number } | null | undefined;

export interface FaqResult {
  reply: string;
  intent: string;
  automation_level: "full_auto" | "semi_auto" | "needs_human" | "inteligencia" | string;
  faq_id?: number;
  /** Tema de la FAQ (subcategory). Lo usa el call-site para el aviso al vendedor. */
  topic?: string;
  /** true cuando la respuesta YA saluda (la FAQ del saludo inicial): el call-site
   *  no debe volver a anteponerle "¡Hola X! 👋". */
  yaSaluda?: boolean;
  /** Pablo, 29/09: respuesta que además deja una tarea para una persona (pedido duplicado, acceso a la web).
   *  La crea el call-site (webhook), igual que el aviso de needs_human. */
  alerta?: { motivo: string; urgente?: boolean; pedidos?: number[]; detalle?: string };
  /** Pablo, 30/09: PDFs a mandar después del texto (reenvío de factura). URL firmada, 1 h. */
  documentos?: Array<{ url: string; filename: string }>;
}

// Pablo, 28/09: al cliente NUNCA se le muestra el número de pedido (se nombra por la fecha) y cada pedido
// dice su estado; si tiene fecha de salida, la fecha. "recibido" = Gestión todavía no lo programó (sin fecha).
const STATUS_MAP: Record<string, string> = {
  pendiente: "📝 recibido, todavía sin fecha de salida",
  recibido:  "📝 recibido, todavía sin fecha de salida",
  programado:"🚚 programado",
  "en preparacion": "🛠️ en preparación en el depósito",
  facturado: "🧾 facturado, listo para salir",
  entregado: "✅ entregado",
};

/**
 * Reemplaza tokens {{token}} de una plantilla de wa_faq con datos reales.
 * Estándar: {{snake_case}} (ver sql/051_wa_faq_editable_templates.sql y la
 * tabla wa_faq_lookup_tokens). Un token sin valor se reemplaza por "".
 * El front edita el texto alrededor de los tokens; el backend completa los datos.
 */
export function renderTemplate(
  tpl: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return String(tpl).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * Saca las líneas que tienen un token {{...}} sin valor: nunca mandar "Tu pedido está programado
 * para: " con la fecha vacía (simulación 28/09, FAQ Retiro / dirección).
 */
export function sinLineasSinDato(
  tpl: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return String(tpl).split("\n").filter((linea) => {
    const tokens = [...linea.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]);
    return tokens.every((k) => vars[k] !== undefined && vars[k] !== null && String(vars[k]) !== "");
  }).join("\n").replace(/\n{3,}/g, "\n\n");
}

// Sólo palabras de saludo o cortesía ("hola", "buenas tardes", "hola qué tal"). Antes contaba ≤ 3 palabras y
// "Hola, cuánto debo?" pasaba por saludo (29/09).
const PALABRAS_SALUDO = new Set(["hola", "holis", "ola", "buenas", "buenos", "buen", "buena", "dia", "dias", "tardes",
  "noches", "hey", "que", "tal", "como", "estas", "andas", "va", "todo", "bien", "gracias", "saludos", "hi"]);
export function esSoloSaludo(text: string): boolean {
  const palabras = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return !/\d/.test(text) && palabras.length > 0 && palabras.length <= 6 && palabras.every((p) => PALABRAS_SALUDO.has(p));
}

/**
 * ¿La respuesta ya arranca saludando? El call-site le antepone "¡Hola {cliente}! 👋"
 * cuando es primer contacto, y la FAQ del saludo inicial ya saluda: sin este chequeo
 * el cliente recibe el saludo dos veces seguidas.
 */
function yaSaluda(reply: string): boolean {
  return /^\s*[¡!]?\s*(hola|buen[ao]s?\s+(d[ií]as|tardes|noches))\b/i.test(reply);
}

/**
 * Corre el pre-check de FAQ. Devuelve null si:
 *   - no hay match (score bajo o vacío)
 *   - la FAQ requiere cliente identificado y no hay uno → deja pasar al
 *     flujo de identificación / al agente
 *   - la respuesta compuesta queda vacía
 */
export async function handleFaq(text: string, customer: Customer): Promise<FaqResult | null> {
  // Pablo, 29/09: "¿cuál es mi dirección de entrega?" / "¿a dónde me lo mandan?" / "¿a qué sucursal va?" pide A DÓNDE va SU
  // pedido (sucursal de entrega y expreso), no la dirección de nuestro depósito (FAQ #4, que es lo que contestaba).
  // Pablo, 29/09: "cambié de dirección" / "me mudé" / "quiero agregar una sucursal" lo resuelve la IA (solicitar_nueva_sucursal);
  // antes lo atrapaba la FAQ #4 (dirección del depósito).
  if (customer && RE_NUEVA_DIRECCION.test(text)) return null;
  // Pablo, 30/09: agregar a un pedido, mandar un pedido, preguntar si llegó un pago, razón social equivocada o factura
  // duplicada van a la IA (ver las regex): antes una respuesta fija los atrapaba por una palabra suelta.
  // Pablo, 30/09 (4.4): "Me facturaron el mismo pedido dos veces" → se chequea en las facturas antes de derivar.
  // Pablo, 01/10 (fase 3, D008): las cuatro respuestas de pagos miran también Chef, por CUIT (ctxPagosDeCliente).
  if (customer && RE_FACTURA_DUPLICADA.test(text)) return await facturaDuplicada(await ctxPagosDeCliente(customer), text);
  // Pablo, 30/09 (4.5): "No me llegó la factura, ¿me la mandás por acá?" → el bot la reenvía (lookupFacturaReenvio).
  if (customer && RE_PIDE_FACTURA.test(text)) {
    const r = await lookupFacturaReenvio(await ctxPagosDeCliente(customer), text);
    if (r) return r;
  }
  // Pablo, 30/09 (6.3): "¿Recibieron el pago?" → se mira si está registrado (recibos de Gestión); si no, aviso a Cobranzas.
  if (customer && RE_PAGO_RECIBIDO.test(text) && !/comprobante/i.test(text)) {
    return await pagoRegistrado(await ctxPagosDeCliente(customer), text);
  }
  // Pablo, 06/10 (m64): "¿Se podrá efectuar el pago el próximo viernes?" / "¿les puedo pagar la semana que viene?" → lo ve Cobranzas.
  if (customer && pidePagarDespues(text)) {
    return { reply: "Gracias por avisarnos. Le paso tu consulta a Cobranzas para que te confirme por acá si se puede pagar en esa fecha. 🙏",
      intent: "pago_otra_fecha", automation_level: "needs_human", topic: "Quiere pagar en otra fecha",
      alerta: { motivo: "pago", urgente: false, detalle: `Pide pagar en otra fecha: ${text.slice(0, 200)}` } };
  }
  if (customer && vaALaIA(text)) return null;
  // Pablo, 06/10 (m59): "¿hay posibilidades de entrega rápida?" / "¿pueden adelantar la entrega?" → lo ve Logística (motivo entrega).
  if (customer && pideEntregaRapida(text)) {
    return { reply: "Una persona de Logística revisa si se puede acelerar la entrega y te escribe por acá en un momento.",
      intent: "entrega_rapida", automation_level: "needs_human", topic: "Pide entrega rápida o adelantar la entrega",
      alerta: { motivo: "entrega", urgente: false, detalle: `Pide entrega rápida o adelantar la entrega: ${text.slice(0, 200)}` } };
  }
  // Pablo, 30/09 (3.3 y 3.4): horario del depósito, con el corte del almuerzo. "¿Cierran para almorzar?" contestaba "no tengo
  // ese dato"; "Estoy llegando, ¿me esperan?" preguntaba qué necesitaba.
  if (RE_ALMUERZO.test(text)) {
    return { reply: `El depósito cierra para almorzar de 12 a 13. ${HORARIO_DEPOSITO}`, intent: "faq", automation_level: "full_auto" };
  }
  if (RE_LLEGANDO.test(text)) {
    return { reply: `¡Te esperamos! ${HORARIO_DEPOSITO}`, intent: "faq", automation_level: "full_auto" };
  }
  // Pablo, 30/09 (4.1): "Llegaron 59 aceiteras de 60, pido la NC". Disculpas y se le piden los datos de la factura (la tiene:
  // le llegó con el pedido). El reclamo queda registrado ya, para que no se pierda si no contesta.
  if (customer && RE_FALTANTE.test(text)) {
    const fac = text.match(RE_NRO_FACTURA)?.[0];
    return {
      reply: fac
        ? `Disculpá el inconveniente. Quedó registrado el faltante de la factura ${fac}: una persona del equipo te gestiona la nota de crédito y te escribe por acá. 🙏`
        : "Disculpá el inconveniente. ¿Me pasás el número de la factura en la que vino el pedido? Figura arriba a la derecha (por ejemplo, FCA 0004-00036011). Con eso una persona del equipo te gestiona la nota de crédito y te escribe por acá. 🙏",
      intent: "faltante", automation_level: "needs_human", topic: "Faltante: pide nota de crédito",
      alerta: { motivo: "reclamo", detalle: `Faltante${fac ? ` (factura ${fac})` : ""}: ${text.slice(0, 200)}` },
    };
  }
  // Pablo, 30/09 (11.1): "Los coladores vinieron todos rotos" → se le pide la foto. La foto que manda después la guarda el
  // webhook (bucket wa-comprobantes) y la suma como reclamo, porque en los 30 min anteriores habló de rotura (RE_ADJ_RECLAMO).
  if (customer && RE_ROTURA.test(text)) {
    return { reply: "Disculpá el inconveniente. ¿Nos mandás por acá una foto de la mercadería rota? La guardamos con el reclamo y una persona del equipo te escribe para resolverlo. 🙏",
      intent: "mercaderia_rota", automation_level: "needs_human", topic: "Mercadería rota o fallada",
      alerta: { motivo: "reclamo", urgente: true, detalle: `Mercadería rota (se le pidió foto): ${text.slice(0, 200)}` } };
  }
  // Thommy, 30/09 (11.3): "Los pelapapas vinieron con el mismo código de barras" repreguntaba. Es un reclamo: alerta
  // (va a Planify) y se le pide la foto de la etiqueta (el webhook la suma al reclamo: RE_ADJ_RECLAMO mira "código de barras").
  if (customer && RE_ETIQUETA.test(text)) {
    return { reply: "Disculpá el inconveniente. Le paso a una persona del equipo para que revise el etiquetado y te escriba por acá. Si podés, mandanos una foto de la etiqueta. 🙏",
      intent: "error_etiqueta", automation_level: "needs_human", topic: "Error de etiqueta o código de barras",
      alerta: { motivo: "reclamo", detalle: `Error de etiqueta / código de barras: ${text.slice(0, 200)}` } };
  }
  // Pablo, 06/10 (m66): "Vamos a devolver unas cucharas que no pedimos…" → por ahora lo maneja Ventas (motivo devolucion, editable en
  // Derivaciones). Un faltante o una rotura con "devolver" en el medio siguen en sus respuestas de arriba.
  if (customer && quiereDevolver(text)) {
    return { reply: "Gracias por avisarnos. Una persona de Ventas revisa tu devolución y te escribe por acá para coordinarla. 🙏",
      intent: "devolucion", automation_level: "needs_human", topic: "Devolución de mercadería",
      alerta: { motivo: "devolucion", detalle: `Devolución de mercadería: ${text.slice(0, 200)}` } };
  }
  // Pablo, 30/09 (1.9): "Figura programado para el 30/09 pero en el detalle dice 13/10, ¿cuál es?". La IA le contestaba
  // "¿puede ser que el 13/10 lo hayas visto en otro lado?": nunca se asume que el cliente se equivocó. Lo revisa una persona.
  if (customer && RE_FECHAS_NO_COINCIDEN.test(text)) {
    return { reply: "Gracias por avisarnos. Le pido a una persona del equipo que revise las fechas de tu pedido y te confirme por acá cuál es la correcta. 🙏",
      intent: "fechas_no_coinciden", automation_level: "needs_human", topic: "Fechas del pedido que no coinciden",
      alerta: { motivo: "entrega", detalle: `Fechas que no coinciden: ${text.slice(0, 200)}` } };
  }
  // Pablo, 30/09: "Hace 10 días hice un pedido, quería saber el estado" caía en la IA, que convertía "hace 10 días" en
  // una fecha equivocada ("el del 20/09 (14 de septiembre)"). Sin fecha explícita, va a la respuesta fija con los
  // pedidos que faltan entregar; con fecha ("el pedido del 17/9") sigue la IA, que lo busca.
  if (customer && RE_ESTADO_PEDIDO.test(text) && !RE_FECHA_EXPLICITA.test(text)) {
    return { reply: (await lookupOrderStatus(customer)) ?? "", intent: "faq", automation_level: "semi_auto", faq_id: 1 };
  }
  // Pablo, 30/09 (1.8): "¿qué plazo de entrega están manejando?" → sus pedidos por entregar con estado y entrega estimada.
  // Sin pedidos por entregar sigue el flujo normal (plazo general). "No me llegó" es reclamo: lo ve la IA.
  if (customer && RE_PLAZO_ENTREGA.test(text) && !/\bno\s+(me\s+|nos\s+)?(lleg|entreg)/i.test(text)) {
    const r = await lookupOrderStatus(customer, { plazo: true });
    if (r) return { reply: r, intent: "faq", automation_level: "semi_auto", faq_id: 1 };
  }
  if (customer && RE_DIRECCION_ENTREGA.test(text)) {
    const r = await destinoPedidos(customer);
    if (r) return { reply: r, intent: "destino_entrega", automation_level: "semi_auto" };
  }
  // Pablo, 29/09: "apreté confirmar varias veces" / "se me duplicó el pedido". El bot busca pedidos del cliente con el
  // mismo importe y pocos minutos de diferencia; si los hay lo dice y deja una tarea urgente. No anula nada.
  if (customer && RE_DUPLICADO.test(text)) {
    const d = await pedidosDuplicados(customer);
    if (d) {
      return { reply: `Veo ${d.cantidad} pedidos del ${d.del} por ${d.importe}, cargados con ${d.minutos} de diferencia.\n` +
        `No anulamos nada por nuestra cuenta: una persona revisa cuál queda y te confirma por acá.`,
        intent: "pedido_duplicado", automation_level: "semi_auto",
        alerta: { motivo: "cambio_pedido", urgente: true, pedidos: d.ids, detalle: "Posible pedido duplicado" } };
    }
    if (pedidoPorMailRepetido(text)) {
      return { reply: "Revisé tus pedidos de los últimos 7 días y no veo ninguno repetido.\nUna persona revisa el mail y te escribe por acá. 🙏",
        intent: "pedido_mail", automation_level: "needs_human", topic: "Pedido enviado por mail que no se cargó",
        alerta: { motivo: "pedido_mail", urgente: false, detalle: `Pedido enviado por mail que no aparece (sin duplicados en la web): ${text.slice(0, 200)}` } };
    }
    return { reply: "Revisé tus pedidos de los últimos 7 días y no veo ninguno repetido (mismo importe cargado dos veces).\n" +
      "Si ves uno de más en la web, decinos de qué fecha es y lo revisamos.", intent: "pedido_duplicado", automation_level: "semi_auto" };
  }
  // Pablo, 29/09: "me olvidé la clave" / "no puedo entrar a la web". Con el cliente identificado por su teléfono, una persona
  // aprueba desde Tareas y el botón le genera una clave temporal que sale por WhatsApp (el login es <cuit>@cuit.loekemeyer,
  // un mail que no existe: el "olvidé mi contraseña" por mail no le puede llegar).
  if (customer && RE_CLAVE.test(text)) {
    return { reply: "Tu usuario de la web es tu CUIT. Una persona del equipo te genera una clave nueva y te la mandamos por acá.",
      intent: "reseteo_clave", automation_level: "needs_human", topic: "Reseteo de clave de la web",
      alerta: { motivo: "reseteo_clave", detalle: "Pide clave nueva para la web" } };
  }
  // Pablo, 29/09: "no me deja elegir la sucursal" es un problema de acceso a la web: lo revisa una persona.
  if (RE_SUCURSAL_WEB.test(text)) {
    return { reply: "Una persona revisa tu acceso a la web y las sucursales de entrega cargadas, y te escribe por acá.",
      intent: "acceso_web", automation_level: "needs_human", topic: "Acceso a la web: no puede elegir sucursal",
      alerta: { motivo: "acceso_web", detalle: "No puede elegir sucursal en la web" } };
  }
  const { data: matches, error } = await supabase.rpc("wa_faq_match", { p_text: text });
  if (error || !matches?.length) return null;

  const top = matches[0];
  // match_score (RPC wa_faq_match, sql/054): peso de keywords que matchean por
  // inicio-de-palabra sobre texto normalizado (sin acentos), + rescate difuso
  // (pg_trgm) para typos. Un match real vale >= 1; sin match queda ~0 (sólo el
  // micro-desempate por similitud). Umbral 1 = "necesita al menos un keyword
  // sólido o un typo cercano"; si no, lo maneja la IA / el registro.
  if (Number(top.match_score) < 1) return null;

  // El saludo de respaldo (category greeting_fallback, keywords "necesito", "puedo", "?"…) atrapaba
  // mensajes con contenido real: "necesito 2000 cajas del 506" recibía "Hola! ¿En qué te puedo ayudar?"
  // (simulación 28/09). Con cliente identificado sólo responde si el mensaje es casi sólo un saludo;
  // si no, pasa al agente.
  // Lo mismo con el saludo (#41, category saludo): "Hola, cuánto debo?" recibía "¿En qué te puedo ayudar?" (29/09).
  if (customer && (top.category === "greeting_fallback" || top.category === "saludo") && !esSoloSaludo(text)) return null;
  // Pablo, 30/09: #21 (mínimo de compra / por unidad) contestaba "Cargué todo por unidad y después lo edité por caja".
  if (customer && top.category === "minimo_compra" && RE_ERROR_CARGA.test(text)) return null;
  // Pablo, 01/10: pedir una excepción al mínimo ("¿me pueden hacer una excepción?", "¿puedo pedir menos del mínimo?") no se
  // contesta con el mínimo: lo decide un vendedor. Va a la IA, que deriva (motivo excepcion_minimo).
  if (customer && (top.category === "minimo_compra" || top.category === "logistica") && RE_EXCEPCION_MINIMO.test(text)) return null;

  // Escalación humana: preestablecida en la FAQ (categoría HUMANO)
  if (top.automation_level === "needs_human") {
    const topic = top.subcategory || "tu consulta";
    // Plantilla editable desde el front (wa_faq.bot_response). Si está vacía,
    // se usa el mensaje genérico de escalación.
    const tpl = String(top.bot_response ?? "").trim();
    const reply = tpl
      ? renderTemplate(tpl, { nombre_cliente: customer?.business_name, tema: topic, topic })
      : `📋 *${topic}* necesita atención de un vendedor. Te van a contactar a la brevedad.\n\nTambién podés escribirnos a ventas@loekemeyer.com`;
    // El aviso al vendedor lo dispara el CALL-SITE (el webhook), no esto: acá no
    // tenemos el teléfono, y además `lk_chat-test` llama a la misma función — si el
    // insert viviera acá, cada prueba desde el Panel encolaría una alerta falsa.
    // Se devuelve `topic` para que el call-site tenga el contexto.
    return {
      reply,
      intent: "escalation",
      automation_level: "needs_human",
      faq_id: top.faq_id,
      topic,
      yaSaluda: yaSaluda(reply),
    };
  }

  // "inteligencia": la FAQ es SOLO la etiqueta del intent (ej. "nuevo_pedido"), no una
  // respuesta enlatada. La respuesta real la arma el agente IA (cliente) o cae al registro
  // (no-cliente). Devolvemos null para NO servir el texto estático.
  if (top.automation_level === "inteligencia") return null;

  // Pablo, 29/09 (incidencia "entrega"): "no me llegó", "tenía que llegar ayer", "todavía nada" es un reclamo, no
  // una consulta de estado: la respuesta fija (#9, lista de pedidos) no lo resuelve. Va a la IA, que deriva
  // (derivar_a_persona, motivo "entrega").
  if (customer && RE_NO_LLEGO.test(text)) return null;
  // Igual con "ya pagué / ya transferí y me sigue figurando": es un pago a verificar, no un pedido de alias/CBU
  // (#42 lo enganchaba por "transferí"). La IA deriva a Cobranzas (motivo "pago").
  if (customer && RE_YA_PAGUE.test(text)) return null;
  // Pablo, 29/09: un reclamo ("llegó una caja rota", "me cobraron de más", "no me aplicaron el descuento") no se contesta con
  // una respuesta informativa (#10 facturación, #8 descuentos, #12 precio…): va a la IA, que lo deriva como reclamo.
  if (customer && RE_RECLAMO.test(text)) return null;
  // Pablo, 29/09: "¿cuándo ingresan los artículos nuevos?" / "¿cuándo entra el 404E?" no es "pasame el catálogo" (#19):
  // la IA lo contesta con consultar_proximos_ingresos / consultar_stock (fecha estimada de ingreso de importados).
  if (customer && RE_INGRESO.test(text)) return null;
  // Pablo, 29/09: "¿qué incluye mi pedido del 25/09?" pide el CONTENIDO (ítems, cajas, precios), no el estado: la FAQ #1
  // contestaba la lista de estados. La IA lo resuelve con consultar_detalle_pedido.
  if (customer && RE_DETALLE_PEDIDO.test(text)) return null;

  // Pablo, 28/09: si el pedido abierto del cliente va por EXPRESO, no se le ofrece retiro (las distancias son
  // grandes): ante "¿puedo pasar a buscarlo?" se le dice por qué expreso va y que el viaje lo maneja el expreso.
  if (customer && RE_RETIRO.test(text)) {
    const exp = await pedidoExpresoAbierto(customer);
    if (exp) {
      const reply = `Tu pedido del ${exp.del} va por el expreso *${exp.expreso}*` +
        (exp.sale ? `: el ${exp.sale} lo entregamos ahí.` : ".") +
        `\nDesde el expreso te lo llevan con sus tiempos de viaje; para saber cuándo te llega, consultalo directamente con ellos.`;
      return { reply, intent: "retiro_expreso", automation_level: "semi_auto", faq_id: top.faq_id, yaSaluda: false };
    }
  }

  // SEMIAUTO con lookup a Supabase (0 tokens).
  if (top.requires_db_lookup) {
    // payment_data (alias/CBU) NO requiere cliente: los datos para transferir
    // se sirven igual a clientes y no-clientes, tomados de una config editable
    // (app_settings.wa_descuentos_config → pago.alias / pago.cbu). Nunca hard-coded.
    if (top.db_lookup_type === "payment_data") {
      const r = await lookupPaymentData(top, customer);
      if (r) return { reply: r, intent: "payment_data", automation_level: "semi_auto", faq_id: top.faq_id, yaSaluda: yaSaluda(r) };
    } else if (top.db_lookup_type === "minimo_compra") {
      // Mínimo del cliente (su excepción o el general, sql/120); a un no-cliente, el general.
      const r = await lookupMinimo(top, customer);
      if (r) return { reply: r, intent: "minimo_compra", automation_level: "semi_auto", faq_id: top.faq_id, yaSaluda: yaSaluda(r) };
    } else if (customer && top.db_lookup_type === "factura_reenvio") {
      // Pablo, 05/10: sólo si la pide (RE_QUIERE_FACTURA; RE_PIDE_FACTURA ya reenvió arriba). Lo demás, a la IA.
      if (!RE_QUIERE_FACTURA.test(text)) return null;
      const r = await lookupFacturaReenvio(await ctxPagosDeCliente(customer), text);
      if (r) return { ...r, faq_id: top.faq_id, yaSaluda: yaSaluda(r.reply) };
    } else if (customer) {
      const lookupReply = await handleFaqLookup(top.db_lookup_type, customer, text, top);
      if (lookupReply) {
        return {
          reply: lookupReply,
          intent: top.db_lookup_type || "faq_lookup",
          automation_level: "semi_auto",
          faq_id: top.faq_id,
          yaSaluda: yaSaluda(lookupReply),
        };
      }
      // Si el lookup no aplica, caemos a respuesta estática de más abajo
    }
  }

  // ── Elección cliente / no-cliente ──────────────────────────────────────
  // Cliente identificado → prioriza bot_response (personalizado).
  // Sin cliente          → prioriza institutional_response.
  // Fallback al otro campo si el preferido está vacío. (No sacamos el fallback:
  // hay ~23 FAQs activas sin institucional que son institucionales de hecho y
  // quedarían mudas para no-clientes.) Para que un mensaje NO deba responderle a
  // un no-cliente (ej.: el saludo, que sino saludaría con nombre vacío), se le
  // carga un institutional_response propio — así el no-cliente recibe ese texto
  // (ej.: pedir CUIT) en vez del bot_response.
  const isCliente = !!customer;
  const primary = isCliente
    ? (top.bot_response ?? top.institutional_response)
    : (top.institutional_response ?? top.bot_response);
  if (!primary || !String(primary).trim()) return null;

  // web_first_response se antepone solo si el cliente está identificado
  // (para no-clientes carece de sentido — no pueden entrar a la web logueados).
  let reply = "";
  if (isCliente && top.web_first_response) reply += top.web_first_response + "\n\n";
  reply += primary;

  // Resolver cualquier token {{...}} de la plantilla en la rama estática.
  // Acá no hay lookup: los tokens sin dato disponible se quitan (→ "") para no
  // filtrar {{fecha}} literal a un cliente. {{nombre_cliente}} sí se completa.
  reply = renderTemplate(sinLineasSinDato(reply, { nombre_cliente: customer?.business_name }),
    { nombre_cliente: customer?.business_name });

  const final = reply.trim();
  return {
    reply: final,
    intent: "faq",
    automation_level: top.automation_level,
    faq_id: top.faq_id,
    topic: top.subcategory || undefined,
    yaSaluda: yaSaluda(final),
  };
}

// ── SEMIAUTO handlers (0 tokens, con datos reales de Supabase) ──────────
async function handleFaqLookup(
  lookupType: string,
  customer: NonNullable<Customer>,
  message: string,
  // deno-lint-ignore no-explicit-any
  faq?: any,
): Promise<string | null> {
  switch (lookupType) {
    case "order_status":       return lookupOrderStatus(customer);
    case "customer_discount":  return lookupCustomerDiscount(customer, faq, message);
    case "product_price":      return lookupProductPrice(customer, message);
    case "product_stock":      return lookupProductStock(customer, message);
    case "order_modify":       return lookupOrderModify(customer);
    default:                   return null;
  }
}

// Pedido mínimo (FAQ #21 y #31, sql/120): {{minimo_envio}} / {{minimo_retiro}} del cliente y, si el de retiro es menor,
// {{si_no_llega_al_minimo}} le ofrece prepararlo para retirar. Sirve a cliente y no-cliente.
// deno-lint-ignore no-explicit-any
async function lookupMinimo(faq: any, customer: Customer): Promise<string | null> {
  const tpl = customer ? (faq.bot_response ?? faq.institutional_response) : (faq.institutional_response ?? faq.bot_response);
  if (!tpl || !String(tpl).trim()) return null;
  const m = await minimoCliente(customer ? { id: customer.id, cod: customer.cod_cliente } : null);
  const vars = {
    nombre_cliente: customer?.business_name,
    minimo_envio: fmtMinimo(m.envio),
    minimo_retiro: fmtMinimo(m.retiro),
    si_no_llega_al_minimo: m.envio > 0 && m.retiro < m.envio
      ? "Si tu pedido no llega al mínimo de envío, lo podemos preparar para que lo retires: confirmanos si querés."
      : "",
  };
  return renderTemplate(sinLineasSinDato(String(tpl), vars), vars).trim();
}

// Datos para transferir (alias / CBU). SEMIAUTO editable: el texto se edita en
// wa_faq (tokens {{alias}} {{cbu}}); los valores salen de app_settings.wa_descuentos_config
// (pago.alias / pago.cbu), editables desde el Panel de Control. Sirve a cliente y no-cliente.
const PAGO_ALIAS_FALLBACK = "loeke.srl";
const PAGO_CBU_FALLBACK = "1910027855002702387450";
// deno-lint-ignore no-explicit-any
async function lookupPaymentData(faq: any, customer: Customer): Promise<string | null> {
  let alias = PAGO_ALIAS_FALLBACK, cbu = PAGO_CBU_FALLBACK;
  try {
    const cfg = JSON.parse((await getSetting("wa_descuentos_config")) ?? "{}");
    if (cfg?.pago?.alias) alias = String(cfg.pago.alias).trim() || alias;
    if (cfg?.pago?.cbu) cbu = String(cfg.pago.cbu).trim() || cbu;
  } catch { /* usa fallbacks */ }
  const isCliente = !!customer;
  // Datos de pago son institucionales (no traen dato personal): para no-cliente
  // se prioriza institutional_response, con fallback a bot_response.
  const tpl = isCliente
    ? (faq.bot_response ?? faq.institutional_response)
    : (faq.institutional_response ?? faq.bot_response);
  if (!tpl || !String(tpl).trim()) return null;
  const base = renderTemplate(String(tpl), { nombre_cliente: customer?.business_name, alias, cbu }).trim();
  // Pablo, 01/10: si además tiene facturas de Chef (cruce por CUIT), van también los datos de Chef; si Chef no tiene alias
  // cargado en la ficha Empresas, se lo pasa Cobranzas (nunca el de Loekemeyer para facturas de Chef).
  if (!customer) return base;
  const { data: cu } = await supabase.from("customers").select("cuit").eq("id", customer.id).maybeSingle();
  const chef = await deudaChefPorCuit(cu?.cuit);
  if (!chef?.length) return base;
  const emp = await datosEmpresas();
  return `${base.replace(/\n*\*?Alias:/, "\n\nPara las facturas de Loekemeyer:\n*Alias:")}\n\n` +
    (textoDatosPago(emp.chef, true) ?? "Para las facturas de Chef, Cobranzas te pasa los datos de pago por acá.");
}

export const RE_NO_LLEGO = /\b(no (me )?(lleg[oó]|vino|entregaron|trajeron)|nunca lleg|todav[ií]a no (lleg|vino|me)|ten[ií]a que (llegar|venir|haber llegado)|deb[ií]a (llegar|venir)|sigo esperando|no lleg[oó] nada)/i;
const RE_DETALLE_PEDIDO = /(qu[eé]\s+(incluye|tiene|trae|lleva|contiene|ped[ií]|hab[ií]a|va)\b[^?]{0,40}pedido|pedido[^?]{0,30}\b(incluye|contiene|trae|tiene)\b|detalle\s+(de(l)?\s+)?(mi\s+|el\s+)?pedido|(art[ií]culos|productos|[ií]tems|cosas)\s+(de(l)?|en)\s+(mi\s+|el\s+)?pedido)/i;
export const RE_INGRESO = /\bcu[aá]ndo\s+(ingres|entra|vuelve|repon|hay\b|habr|llega(n)?\s+(el|la|los|las|un|una)\s+(art|prod|import|nuev|novedad))/i;
const RE_RECLAMO = /(\brot[oa]s?\b|\bromp|fallad|defectuos|mal estado|da[ñn]ad|cobr\S*\s+(de\s+m[aá]s|mal|distinto|otro)|precio\s+(viejo|distinto|equivocado|mal)|no\s+(me\s+)?(aplic|respet|hicieron\s+el\s+descuento)|est[aá]\s+mal\b|vino\s+mal|lleg\w*\s+(mal|\d+\s+de\s+\d+)|llegaron\s+\d+|\bme\s+falt|\bfalt(a|an|aron)\s+\d|incorrect|equivocad|reclam)/i;
const RE_YA_PAGUE = /\b(ya (les |te )?(pagu[eé]|transfer[ií]|deposit[eé]|abon[eé]|cancel[eé])|(les |te )?(transfer[ií]|pagu[eé]|deposit[eé]) (ayer|hoy|el)|sigue figurando|me sigue (apareciendo|saliendo)|no (se )?(me )?(acredit|impact|figura (el|mi) pago))/i;
const RE_RETIRO = /\b(retir(o|ar|arlo|arla|amos|a)|pas(ar|o|amos) a buscar|buscarlo|ir a buscar|lo busco|voy a buscar)\b/i;

/** Pedido abierto más reciente del cliente que va por expreso (no anulado, no entregado). null si no hay. */
const RE_NUEVA_DIRECCION = /(cambi\S*\s+(de\s+|la\s+|mi\s+)?(direcci[oó]n|domicilio|local|sucursal)|me\s+mud|nos\s+mudamos|nueva\s+(direcci[oó]n|sucursal)|(agregar|sumar|cargar)\s+(una\s+)?(direcci[oó]n|sucursal)|otra\s+(direcci[oó]n|sucursal))/i;
const RE_DIRECCION_ENTREGA = /(mi|la)\s+direcci[oó]n\s+de\s+(entrega|env[ií]o)|a\s+d[oó]nde\s+(me\s+)?(lo|la|los|las)?\s*(mand|env[ií]|entreg|despach|llev)|a\s+qu[eé]\s+(sucursal|direcci[oó]n|expreso|transporte)|d[oó]nde\s+(me\s+)?(lo\s+)?entregan|por\s+qu[eé]\s+(expreso|transporte)|qu[eé]\s+(expreso|transporte)\s+(me\s+)?(lo\s+)?(lleva|mand|us)/i;

// A dónde va cada pedido abierto del cliente: sucursal de entrega cargada en la web y, si sale por expreso, cuál.
// Pablo, 06/10 (corrección m63): "Pasé por mail un pedido para un cliente pero me vino dos veces rechazado. ¿Te llegó a vos?" cae acá por
// "dos veces", pero habla de un pedido por MAIL, que el bot no puede ver: además del chequeo de duplicados deja una alerta para Ventas.
const RE_POR_MAIL = /\b(e-?mails?|mails?|correos?|gmail|hotmail|outlook)(?![a-záéíóúñ])/i;
const RE_DUPLICADO = /((pedido|confirm|carg|compra)[^.?!]{0,40}(duplic|repetid|dos veces|\b2 veces|varias veces|m[aá]s de una vez|tres veces)|(duplic|repetid|dos veces|\b2 veces|varias veces|m[aá]s de una vez)[^.?!]{0,40}(pedido|confirm|carg))/i;
const RE_CLAVE = /((olvid|recuper|resete|blanque|cambi|perd|nueva|bloque|no\s+(me\s+)?(acuerdo|recuerdo))[^.?!]{0,40}(contrase|\bclave|password|usuario)|(contrase|\bclave|password|usuario)[^.?!]{0,40}(olvid|no\s+(me\s+)?(anda|funciona|toma|deja|acuerdo|recuerdo|entra)|incorrect|inv[aá]lid|bloque)|no\s+(puedo|logro|me\s+deja)\s+(entrar|ingresar|loguear)[^.?!]{0,30}(web|p[aá]gina|sistema|cuenta)?|(necesito|pasame|pas[aá]s|mandame|dame|no\s+tengo)\s+(mi\s+|el\s+|un\s+|la\s+)?(usuario|\bclave|contrase)|\b(saber|cu[aá]l\s+es|record[aá]me|decime)\s+(cu[aá]l\s+es\s+)?(mi\s+|la\s+)?(usuario|\bclave|contrase))/i;
const RE_SUCURSAL_WEB = /(no\s+(me\s+)?(deja|puedo|aparece|figura|sale)[^.?!]{0,30}sucursal|sucursal[^.?!]{0,30}no\s+(me\s+)?(deja|aparece|figura|sale|puedo))/i;
// Pablo, 30/09 (simulación con 57 mensajes reales): respuestas fijas que se disparaban por una palabra suelta. Todos estos
// van a la IA, que tiene las herramientas para resolverlos o derivarlos.
// "Quería agregar 60 unidades del 067 al pedido de ayer" → #21 (mínimo de compra) por "unidad". Agregar lo resuelve la IA
// (solicitar_agregado_pedido, botón Aplicar).
const RE_AGREGA_A_PEDIDO = /\b(agreg|sum[aá]|sumar|a[ñn]ad)\w*[^.?!]{0,60}\bpedido\b/i;
// "Te paso el cotizador con el pedido" → #11 (lista de precios) por "cotizador": el cliente MANDA un pedido, no pide la lista.
const RE_ENVIA_PEDIDO = /\b(te\s+|les\s+)?(paso|pasamos|env[ií]o|enviamos|mando|mandamos|adjunt\w*)(?![a-zñáéíóú])[^.?!]{0,40}\b(cotizador|pedido|orden\s+de\s+compra|planilla|excel)/i;
// "¿Recibieron el pago?" → #15 (medios de pago) por "pago": pregunta si LLEGÓ un pago (lo ve Cobranzas).
export const RE_PAGO_RECIBIDO = /(recib\w*|lleg[oó]|acredit\w*|impact\w*|vieron|entr[oó])[^.?!]{0,30}\b(el\s+|mi\s+|la\s+)?(pago|transferencia|dep[oó]sito|e-?cheq|cheque)|\b(pago|transferencia|dep[oó]sito)[^.?!]{0,30}\b(recib|lleg[oó]|acredit|impact)/i;
// "El pedido me salió a nombre de mi otra razón social" → #1 (estado de pedidos). Hay que refacturar: lo deriva la IA.
const RE_RAZON_SOCIAL_MAL = /(otra\s+raz[oó]n\s+social|raz[oó]n\s+social\s+(equivocad|incorrect|distint|mal)|a\s+nombre\s+de\s+(mi\s+)?(otra|otro)\b|otro\s+cuit)/i;
// "Me facturaron el mismo pedido dos veces" → control de pedidos repetidos. Es una FACTURA duplicada: reclamo, lo deriva la IA.
export const RE_FACTURA_DUPLICADA = /(factur\w*[^.?!]{0,40}(dos veces|\b2 veces|duplicad|repetid|de m[aá]s)|(duplicad|repetid)\w*[^.?!]{0,20}factura)/i;
// "Cargué todo por unidad y después lo edité por caja" → #21 por "unidad": cuenta un error de carga, no pregunta si venden por unidad.
// "¿Me pueden hacer una excepción?" / "¿puedo pedir menos del mínimo?" / "¿me bajan el mínimo?" (sql/120: lo decide un vendedor).
export const RE_EXCEPCION_MINIMO = /\bexcepci[oó]n|\b(por\s+debajo|menos)\s+(del|que\s+el)\s+m[ií]nimo\b|\b(sin|bajar(me)?|bajan|rebaj\w*|saltear|obviar)\s+(el\s+)?m[ií]nimo\b|\bm[ií]nimo\s+m[aá]s\s+bajo\b|\bno\s+llego\s+al\s+m[ií]nimo\b[^.?!]{0,40}\b(igual|aceptan|toman|pueden)\b/i;
const RE_ERROR_CARGA = /\b(cargu[eé]|cargamos|cargaron|edit[eé]|editamos|me\s+equivoqu[eé]|nos\s+equivocamos|puse|pusimos)(?![a-zñáéíóú])[^.?!]{0,60}\b(unidad|caja|pedido)/i;
// "Hace 10 días hice un pedido, quería saber el estado" / "¿está confirmado mi pedido?" / "¿novedades del pedido?".
// No "me llegó el pedido en mal estado" (reclamo: lo ve la IA).
export const RE_ESTADO_PEDIDO = /\bpedido\b[^.?!]{0,60}\b((?<!mal\s)(?<!buen\s)estado|confirmad[oa]|novedad(es)?)\b|\b(estado|confirmad[oa]|novedad(es)?)\b[^.?!]{0,40}\bpedido\b/i;
// "Qué período de tiempo están contemplando para entregas" / "¿cuánto tarda la entrega?" / "¿qué plazo de entrega tienen?".
export const RE_PLAZO_ENTREGA = /\b(per[ií]odo|plazo|tiempo)s?\b[^.?!]{0,50}\b(entrega|entregas|entregar|env[ií]os?)\b|\bcu[aá]nt[oa]s?\s+(d[ií]as\s+)?(tarda|tardan|demora|demoran)\b[^.?!]{0,30}\b(entrega|entregar|env[ií]o|llegar|pedido)/i;
const HORARIO_DEPOSITO = "Estamos en Virgilio 2788, Villa Devoto, de lunes a viernes de 9 a 12 y de 13 a 16:30 (de 12 a 13 cerramos para almorzar).";
const RE_ALMUERZO = /\b(almuerz\w*|almorz\w*|almuerc\w*|mediod[ií]a)/i;
const RE_LLEGANDO = /\b(estoy|estamos)\s+(llegando|yendo|en\s+camino|a\s+\d+\s+(cuadras|minutos))\b|\bme\s+esperan\b|\bya\s+(voy|salgo)\s+para\s+(all[aá]|el\s+dep[oó]sito)/i;
export const RE_PIDE_FACTURA = /\b(mand[aá]me|pas[aá]me|envi[aá]me|reenvi[aá]\w*|me\s+(la\s+|las\s+)?(mand|pas|envi|reenvi)\w*)\b[^.?!]{0,30}\bfacturas?\b|\bfacturas?\b[^.?!]{0,40}\b(me\s+(la\s+|las\s+)?(mand|pas|envi|reenvi)\w*|mand[aá]me|pas[aá]me|reenvi\w*)|\bno\s+(me\s+)?lleg[oó]\s+(la\s+|las\s+)?factura/i;
// Pablo, 05/10: la #10 (reenvío) se disparaba con cualquier mensaje que dijera "factura" (la palabra sola le da puntaje 1):
// "¿Eso son las 3 facturas?" le volvía a mandar las facturas que acababa de recibir. Por palabra clave sólo reenvía si la
// pide: RE_PIDE_FACTURA, "necesito / quiero / no recibí / no encuentro la factura", "¿dónde está la factura?" o "la
// factura?" sola. Cualquier otra pregunta sobre facturas va a la IA, que ve la charla y consulta sus facturas.
export const RE_QUIERE_FACTURA = /\b(necesit[a-záéíóú]*|quier[a-záéíóú]*|precis[a-záéíóú]*|me\s+falta[a-záéíóú]*|no\s+(tengo|encuentro|recib[a-záéíóú]*))\s+(una\s+copia\s+de\s+)?(la\s+|las\s+|mi\s+|mis\s+|una\s+)?facturas?\b|\bd[oó]nde\s+est[aá]n?\s+(la\s+|las\s+|mi\s+|mis\s+)facturas?\b|^\s*[¿?]?\s*(y\s+)?(la\s+|las\s+|mi\s+|mis\s+)?facturas?\s*[?!.]*\s*(por\s+favor|porfa|xfa)?\s*[?!.]*\s*$/i;
// "Llegaron 59 aceiteras de 60, pido la NC" / "tengo un faltante en el remito" / "me faltó una caja".
const RE_FALTANTE = /\bfalt(ante|aron|[oó]|an?)(?![a-záéíóúñ])[^?]{0,60}\b(cajas?|unidad\w*|art[ií]culos?|c[oó]d\w*|\d+)\b|\bfaltante\b|\blleg(aron|[oó])\s+\d+\s+de\s+\d+\b|\b(pido|necesito|quiero|hacen?|me\s+hacen)\s+(la\s+|una\s+)?(nc|nota\s+de\s+cr[eé]dito)\b/i;
const RE_ETIQUETA = /(c[oó]digos?\s+de\s+barras?|\betiquet\w*|\bean\b)[^?]{0,60}\b(mism[oa]s?|mal|equivocad\w*|incorrect\w*|distint\w*|cambiad\w*|no\s+(los\s+|las\s+|lo\s+|la\s+)?(lee|leen|pasa|pasan|escanea\w*|coincide\w*))|\b(mism[oa]s?|mal|equivocad\w*|incorrect\w*|distint\w*)\b[^?]{0,40}(c[oó]digos?\s+de\s+barras?|\betiquet\w*)/i;
// Pablo, 06/10 (corrección m66): "Vamos a devolver unas cucharas que no pedimos, es el código 208 y son 48 unidades" salía con la
// respuesta fija #21 (mínimo de compra), por "unidades". Quiere devolver mercadería: el bot toma el aviso y lo deriva (motivo devolucion).
// Sólo cuando el CLIENTE devuelve ("devolver", "devolvemos", "devuelvo", "devolución"); no "devolveme la llamada" ni "me devolvieron".
const RE_DEVOLUCION = /\bdevoluci[oó]n(es)?\b|\bdevolv(er|emos|eremos|erle|erles|erlo|erla|erlos|erlas)(?![a-záéíóúñ])|\bdevuelvo\b|\b(les|le|te)\s+devuelvo\b/i;
const RE_DEVOLVER_OTRA_COSA = /\bdevolv\w*[^.?!]{0,25}\b(llamad\w*|llamar|mensaje|mail|correo|visita)\b|\b(llamad\w*|mensaje|mail)[^.?!]{0,25}\bdevolv/i;
// Pablo, 06/10 (corrección m64): "Hola, ¿se podrá efectuar el pago el próximo viernes?" salía con la respuesta fija #15 (medios de pago y CBU)
// y no contestaba lo que preguntó. Pide pagar en otra fecha: lo decide Cobranzas (motivo pago). Sólo mira hacia adelante: "ya pagué el
// viernes", "el viernes pasado" o "¿recibieron el pago?" (pagoRegistrado) siguen su camino; "hoy" no cuenta (es el descuento por pagar hoy).
const RE_PAGAR = /\b(pagar(les|te|lo|la|los|las)?|pagamos|pagaremos|pagar[eé]|abonar(les|te)?|abonamos|abonaremos|abonar[eé]|(les|te)\s+pago|(efectuar|hacer|realizar|hacemos|hago|haremos)\s+(el|este|un)\s+pago|transferir(les|te)?|transferimos|depositar(les|te)?|depositamos)(?![a-záéíóúñ])/i;
const RE_OTRA_FECHA = /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|ma[nñ]ana|pasado\s+ma[nñ]ana|(la\s+)?semana\s+(que\s+viene|pr[oó]xima|entrante)|pr[oó]xim[oa]\s+(semana|mes|lunes|martes|mi[eé]rcoles|jueves|viernes)|m[aá]s\s+adelante|fin\s+de\s+mes|(la\s+)?quincena|el\s+\d{1,2}(?:\s*\/\s*\d{1,2}|\s+de\s+[a-záéíóú]+)?)(?![a-záéíóúñ])/i;
const RE_FECHA_PASADA = /\b(ayer|anteayer|pasad[oa]|anterior|ya\s+(pagu|transfer|deposit|abon))/i;
export const pedidoPorMailRepetido = (text: string): boolean => RE_DUPLICADO.test(text) && RE_POR_MAIL.test(text);
// Pablo, 06/10 (corrección m59): "En el caso que se confirme, ¿hay posibilidades de entrega rápida?" salía con la lista de pedidos pendientes (#1)
// y no contestaba si se puede acelerar. Pedir entrega rápida o adelantar la entrega lo ve Logística (motivo entrega). Hace falta una palabra de
// entrega JUNTO a una de apuro: "¿cuándo llega mi pedido?" y "¿puede estar para el viernes?" siguen su camino.
const RE_ENTREGA_RAPIDA = /\b(entrega|env[ií]o|despacho)s?\s+(r[aá]pid[ao]s?|urgentes?|express|inmediat[ao]s?|prioritari[ao]s?)(?![a-záéíóúñ])|\b(posibilidad(es)?|chance|manera|forma)\s+de\s+(entrega|env[ií]o|que\s+(llegue|salga|lo\s+entreguen))[^.?!]{0,25}\b(r[aá]pid\w*|urgente|antes)\b|\badelant(ar|en|an|ame|arme|arlo|arla|alo|ala)(?![a-záéíóúñ])[^.?!]{0,30}\b(entrega|pedido|env[ií]o|salida|fecha)\b|\b(entreg(ar|arlo|arla|arme|arnos|uen)|llegar|llegue|salir|salga|mandar(lo|la|me)?)(?![a-záéíóúñ])[^.?!]{0,25}\b(antes|m[aá]s\s+(r[aá]pido|temprano)|lo\s+antes\s+posible|cuanto\s+antes)\b/i;
export const pideEntregaRapida = (text: string): boolean => RE_ENTREGA_RAPIDA.test(text) && !RE_NO_LLEGO.test(text);
export const pidePagarDespues = (text: string): boolean => RE_PAGAR.test(text) && RE_OTRA_FECHA.test(text) && !RE_FECHA_PASADA.test(text);
export const quiereDevolver = (text: string): boolean => RE_DEVOLUCION.test(text) && !RE_DEVOLVER_OTRA_COSA.test(text);
const RE_ROTURA = /\b(rot[oa]s?|fallad[oa]s?|defectuos\w*|da[ñn]ad[oa]s?|golpead\w*|abollad\w*|partid[oa]s|quebrad\w*)\b|\bse\s+(nos\s+|me\s+)?rompieron\b|\ben\s+mal\s+estado\b/i;
const RE_NRO_FACTURA = /\b(FC?A?\s*)?\d{4}\s*-\s*\d{6,8}\b/i;
// "Figura programado para el 30/09 pero en el detalle dice 13/10" / "no coinciden las fechas": dos fechas contrapuestas o
// "no coincide" + fecha.
const RE_FECHAS_NO_COINCIDEN = /\b\d{1,2}\s*\/\s*\d{1,2}\b[^?!]{0,80}\b(pero|y|mientras|en\s+cambio)\b[^?!]{0,40}\b(dice|figura|aparece|pone|sale|muestra)\b[^?!]{0,30}\b\d{1,2}\s*\/\s*\d{1,2}\b|\bfechas?\b[^.?!]{0,30}\bno\s+(coincide|coinciden|es\s+la\s+misma|son\s+las\s+mismas)\b|\bno\s+coincide[n]?\b[^.?!]{0,30}\bfechas?\b/i;
// "el pedido del 17/9", "del 31/08", "del 18 de marzo".
const RE_FECHA_EXPLICITA = /\b\d{1,2}\s*[/-]\s*\d{1,2}\b|\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/i;
// Pablo, 01/10 (Simulador, cliente 4210): "¿Me podés pasar la foto del art 437?" salía con la respuesta fija #11 (lista de precios), por
// parecerse a "me podes pasar la lista". La foto de un producto la manda la IA (enviar_fotos_producto). No cuenta la foto de otra cosa:
// rotura, comprobante, factura, remito, etiqueta (esas siguen en sus respuestas fijas y reclamos).
const RE_PIDE_FOTO = /\b(fotos?|fotito|fotitos|im[aá]gen(es)?)\b/i;
const RE_FOTO_DE_OTRA_COSA = /\b(comprobantes?|transferencias?|factur\w*|pagos?|reclamos?|remitos?|etiquet\w*|c[oó]digos?\s+de\s+barras?)\b/i;
export function pideFotoProducto(text: string): boolean {
  return RE_PIDE_FOTO.test(text) && !RE_FOTO_DE_OTRA_COSA.test(text) && !RE_ROTURA.test(text);
}
function vaALaIA(text: string): boolean {
  return RE_AGREGA_A_PEDIDO.test(text) || RE_PAGO_RECIBIDO.test(text) || RE_RAZON_SOCIAL_MAL.test(text) ||
    RE_FACTURA_DUPLICADA.test(text) || pideFotoProducto(text) ||
    // "Te paso el comprobante del pedido" sigue en la respuesta fija del comprobante (#20).
    (RE_ENVIA_PEDIDO.test(text) && !/comprobante|\bpag[oó]|transfer/i.test(text));
}

async function pedidosDuplicados(customer: NonNullable<Customer>): Promise<{ cantidad: number; del: string; importe: string; minutos: string; ids: number[] } | null> {
  const { data: crudos } = await supabase.from("orders").select("id, created_at, total").eq("customer_id", customer.id)
    .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString()).order("created_at", { ascending: true }).limit(50);
  const ords = await sinAnulados(crudos ?? []);
  const f = (iso: string) => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(iso)); return `${p.slice(8, 10)}/${p.slice(5, 7)}`; };
  for (let i = 0; i < ords.length; i++) {
    const grupo = [ords[i]];
    for (let j = i + 1; j < ords.length; j++) {
      const mismo = Math.round(Number(ords[j].total || 0)) === Math.round(Number(ords[i].total || 0)) && Number(ords[i].total) > 0;
      const cerca = new Date(ords[j].created_at).getTime() - new Date(grupo[grupo.length - 1].created_at).getTime() <= 30 * 60_000;
      if (mismo && cerca) grupo.push(ords[j]);
    }
    if (grupo.length > 1) {
      const min = Math.max(1, Math.round((new Date(grupo[grupo.length - 1].created_at).getTime() - new Date(grupo[0].created_at).getTime()) / 60_000));
      return { cantidad: grupo.length, del: f(grupo[0].created_at), importe: "$" + Math.round(Number(grupo[0].total)).toLocaleString("es-AR"),
        minutos: min === 1 ? "1 minuto" : `${min} minutos`, ids: grupo.map((o) => Number(o.id)) };
    }
  }
  return null;
}

async function destinoPedidos(customer: NonNullable<Customer>): Promise<string | null> {
  const { data: crudos } = await supabase.from("orders").select("id, created_at, total").eq("customer_id", customer.id)
    .gte("created_at", new Date(Date.now() - 60 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(10);
  const ords = await sinAnulados(crudos ?? []);
  if (!ords.length) return null;
  const ids = ords.map((o) => o.id);
  const [{ data: est }, { data: modos }] = await Promise.all([
    estadoPedidos(ids),
    supabase.from("v_pedidos_web").select("order_id, sucursal_entrega, zona_expreso, nombre_expreso, direccion_expreso").in("order_id", ids).eq("linea_rn", 1),
  ]);
  const f = (iso: string) => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(iso)); return `${p.slice(8, 10)}/${p.slice(5, 7)}`; };
  const pesos = (n: unknown) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");
  const lineas: string[] = [];
  for (const o of ords) {
    // deno-lint-ignore no-explicit-any
    const e: any = (est ?? []).find((x: any) => Number(x.order_id) === Number(o.id));
    // deno-lint-ignore no-explicit-any
    const m: any = (modos ?? []).find((x: any) => Number(x.order_id) === Number(o.id));
    if (!m || e?.status === "entregado") continue;
    const zona = String(m.zona_expreso ?? "");
    const expreso = String(m.nombre_expreso ?? "").trim();
    const suc = String(m.sucursal_entrega ?? "").trim();
    let destino: string;
    if (/^retira/i.test(zona)) destino = "lo retirás en nuestro depósito (Virgilio 2788)";
    else if (expreso) destino = `lo despachamos por el expreso ${expreso}${m.direccion_expreso ? ` (${String(m.direccion_expreso).trim()})` : ""}${suc ? `, con destino ${suc}` : ""}`;
    else destino = suc ? `se entrega en ${suc}` : "todavía no tiene dirección de entrega cargada";
    lineas.push(`• Pedido del ${f(o.created_at)} por ${pesos(o.total)}: ${destino}.`);
    if (lineas.length >= 8) break;
  }
  if (!lineas.length) return null;
  return `${lineas.length > 1 ? "Así van tus pedidos" : "Así va tu pedido"}:\n\n${lineas.join("\n")}\n\nSi alguna dirección no es la correcta, avisanos por acá y lo corregimos.`;
}

async function pedidoExpresoAbierto(customer: NonNullable<Customer>): Promise<{ del: string; expreso: string; sale: string | null } | null> {
  const { data: crudos } = await supabase.from("orders").select("id, created_at").eq("customer_id", customer.id)
    .gte("created_at", new Date(Date.now() - 60 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(10);
  const ords = await sinAnulados(crudos ?? []);
  if (!ords.length) return null;
  const ids = ords.map((o) => o.id);
  const [{ data: est }, { data: modos }] = await Promise.all([
    estadoPedidos(ids),
    supabase.from("v_pedidos_web").select("order_id, zona_expreso, nombre_expreso").in("order_id", ids).eq("linea_rn", 1),
  ]);
  for (const o of ords) {
    // deno-lint-ignore no-explicit-any
    const e: any = (est ?? []).find((x: any) => Number(x.order_id) === Number(o.id));
    // deno-lint-ignore no-explicit-any
    const m: any = (modos ?? []).find((x: any) => Number(x.order_id) === Number(o.id));
    const expreso = String(m?.nombre_expreso ?? "").trim();
    if (!expreso || /^retira/i.test(String(m?.zona_expreso ?? "")) || e?.status === "entregado") continue;
    const f = (iso: string) => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(iso)); return `${p.slice(8, 10)}/${p.slice(5, 7)}`; };
    let sale: string | null = null;
    if (e?.fecha_entrega) {
      const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
      const x = new Date(String(e.fecha_entrega).slice(0, 10) + "T12:00:00");
      sale = `${DIAS[x.getDay()]} ${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}`;
    }
    return { del: f(o.created_at), expreso, sale };
  }
  return null;
}

// plazo (Pablo, 30/09, fila 1.8 "¿qué plazo de entrega manejan?"): a los pedidos sin fecha de salida les suma la entrega
// estimada que calculó la confirmación del pedido (wa_fecha_estimada, sql/082) y, si no hay pedidos por entregar, devuelve
// null para que conteste el plazo general (IA). No se le pregunta si recibió la confirmación: con la llave en "prueba"
// hoy no le llega a ningún cliente.
export async function lookupOrderStatus(customer: NonNullable<Customer>, opts: { plazo?: boolean } = {}): Promise<string | null> {
  const { data: crudos } = await supabase
    .from("orders")
    .select("id, created_at, total, status")
    .eq("customer_id", customer.id)
    .or("sheets_sent.is.null,sheets_sent.eq.true")   // un pedido que nunca se envió no tiene estado
    .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(15);
  // Anulados o borrados en Gestión: para el bot no existen (pedidos-anulados.ts).
  const orders = await sinAnulados(crudos ?? []);
  if (!orders?.length) {
    if (opts.plazo) return null;
    // Pedidos por WhatsApp apagados (28/09): se lo manda a la web, no "decime".
    return `${customer.business_name}, no tenés pedidos recientes (últimos 90 días). Si querés hacer uno, entrá a loekemeyer.com → "Pedidos Mayorista".`;
  }
  // Estado real del pedido en Gestión Virgilio (RPC bot_estado_pedidos_gv, sql/066). Para
  // los pedidos anteriores a Gestión cae sola a order_tracking. Antes se leía order_tracking
  // directo, que llenaba la planilla de Producción y dejó de traer programados/entregados.
  // Si Gestión no responde, estadoPedidos cae a order_tracking (pedidos-anulados.ts).
  const { data: estados } = await estadoPedidos(orders.map((o) => o.id));
  // deno-lint-ignore no-explicit-any
  const estadoMap = new Map((estados ?? []).map((e: any) => [String(e.order_id), e]));
  const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const conDia = (d: string) => {
    const x = new Date(String(d).slice(0, 10) + "T12:00:00");
    return `${DIAS[x.getDay()]} ${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}`;
  };
  const ddmm = (iso: string) => {   // armado a mano: es-AR ignora el 2-digit del mes ("25/9")
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(iso));
    return `${p.slice(8, 10)}/${p.slice(5, 7)}`;
  };
  // Modo de entrega de cada pedido (v_pedidos_web, misma regla que los avisos de sql/079). Pablo, 28/09: si va
  // por expreso, NO se ofrece retiro (las distancias son grandes) y cuándo le llega lo sabe el expreso.
  const { data: modos } = await supabase.from("v_pedidos_web").select("order_id, zona_expreso, nombre_expreso")
    .in("order_id", orders.map((o) => o.id)).eq("linea_rn", 1);
  const modoDe = new Map((modos ?? []).map((m: { order_id: number; zona_expreso: string | null; nombre_expreso: string | null }) => [
    String(m.order_id),
    /^retira/i.test(String(m.zona_expreso ?? "")) ? { modo: "retira", expreso: null }
      : String(m.nombre_expreso ?? "").trim() ? { modo: "expreso", expreso: String(m.nombre_expreso).trim() }
      : { modo: "reparto", expreso: null },
  ]));
  // Pablo, 30/09: sólo se listan los pedidos que faltan entregar; el resto se da por entregado y se le pide
  // la fecha si pregunta por otro. Excepción: el entregado al expreso en los últimos 7 días sigue en la lista,
  // porque "entregado" es el día que lo dejamos en el expreso y al cliente puede no haberle llegado.
  // Un pedido sin entregar de hace más de 30 días también se da por entregado: medido el 30/09, 28 de los 411
  // pedidos de 30 a 90 días seguían "recibido"/"programado" en order_tracking (estado trabado, no pendiente real).
  const aFecha = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(d);
  const hoyAR = aFecha(new Date());
  const diasDesde = (d: string) => Math.round((Date.parse(hoyAR) - Date.parse(String(d).slice(0, 10))) / 86400_000);
  // deno-lint-ignore no-explicit-any
  const estadoDe = (o: any) => { const t: any = estadoMap.get(String(o.id)); return { t, rawStatus: t?.status ?? o.status }; };
  const modoOf = (o: { id: unknown }) => modoDe.get(String(o.id)) ?? { modo: "reparto", expreso: null };
  const visibles = orders.filter((o) => {
    const { t, rawStatus } = estadoDe(o);
    if (rawStatus !== "entregado") return diasDesde(aFecha(new Date(o.created_at))) <= 30;
    return modoOf(o).modo === "expreso" && !!t?.fecha_entrega && diasDesde(t.fecha_entrega) <= 7;
  }).slice(0, 8);
  const hayOcultos = orders.length > visibles.length;
  const cierre = "Si tu consulta es por otro pedido, confirmame de qué fecha es y lo reviso.";
  const notaExpresoTxt = "\n\n🚛 En los pedidos por expreso, la fecha en que te llega puede diferir según el expreso: una vez que se lo entregamos, los tiempos de viaje dependen de ellos.";

  if (!visibles.length) {
    if (opts.plazo) return null;
    // Todos entregados: se nombra el último para que el cliente lo reconozca.
    const o = orders[0];
    const { t } = estadoDe(o);
    const m = modoOf(o);
    const cuando = t?.fecha_entrega ? ` el ${conDia(t.fecha_entrega)}` : "";
    const donde = m.modo === "expreso" ? ` en el expreso *${m.expreso}*` : "";
    return `${customer.business_name}, todos tus pedidos están entregados. El último, del ${ddmm(o.created_at)}, se entregó${donde}${cuando}.${m.modo === "expreso" ? notaExpresoTxt : ""}\n\n${cierre}`;
  }

  const estimada = new Map<string, string>();
  if (opts.plazo) {
    const { data: est } = await supabase.from("wa_fecha_estimada").select("order_id, texto").in("order_id", visibles.map((o) => o.id));
    for (const e of (est ?? []) as Array<{ order_id: number; texto: string | null }>) if (e.texto) estimada.set(String(e.order_id), e.texto);
  }
  let hayExpreso = false;
  const lines = visibles.map((o, i) => {
    const { t, rawStatus } = estadoDe(o);
    const statusText = STATUS_MAP[rawStatus] || rawStatus;
    const m = modoOf(o);
    if (m.modo === "expreso") hayExpreso = true;
    let line = `${i + 1}️⃣ Pedido del ${ddmm(o.created_at)} — ${statusText}`;
    const conFecha = t?.fecha_entrega && (rawStatus === "programado" || rawStatus === "en preparacion" || rawStatus === "facturado");
    if (conFecha) {
      if (m.modo === "expreso") { line += `: el ${conDia(t.fecha_entrega)} lo entregamos en el expreso *${m.expreso}*`; hayExpreso = true; }
      else if (m.modo === "retira") line += `: lo podés retirar desde el ${conDia(t.fecha_entrega)}`;
      else line += `: sale el ${conDia(t.fecha_entrega)}`;
    } else if (!t?.fecha_entrega && m.modo === "expreso" && rawStatus !== "entregado") {
      line += ` (va por el expreso *${m.expreso}*)`;
    }
    if (!t?.fecha_entrega && rawStatus !== "entregado" && estimada.has(String(o.id))) line += `. Entrega estimada: ${estimada.get(String(o.id))}`;
    if (t?.fecha_entrega && rawStatus === "entregado") {
      if (m.modo === "expreso") { line = `${i + 1}️⃣ Pedido del ${ddmm(o.created_at)} — ✅ entregado en el expreso *${m.expreso}* el ${conDia(t.fecha_entrega)}`; hayExpreso = true; }
      else line += ` el ${conDia(t.fecha_entrega)}`;
    }
    return line;
  });
  const notaExpreso = hayExpreso ? notaExpresoTxt : "";
  const unoSolo = visibles.length === 1;
  const enExpreso = visibles.some((o) => estadoDe(o).rawStatus === "entregado");   // entregado al expreso hace ≤ 7 días
  const titulo = enExpreso
    ? (unoSolo ? "este es tu pedido en curso" : "estos son tus pedidos en curso")
    : (unoSolo ? "este es tu pedido que falta entregar" : "estos son tus pedidos que faltan entregar");
  const resto = hayOcultos ? "Los demás pedidos ya están entregados. " : "";
  return `${customer.business_name}, ${titulo}:\n\n${lines.join("\n")}${notaExpreso}\n\n${resto}${cierre}`;
}

// deno-lint-ignore no-explicit-any
async function lookupCustomerDiscount(customer: NonNullable<Customer>, faq?: any, message = ""): Promise<string | null> {
  // OJO: la columna es `dto_vol`, no `discount` (que no existe en `customers`).
  // Con el nombre mal, el select devolvía error, `row` quedaba en null y el bot
  // le contestaba "Por volumen: 0%" a TODOS — 561 de los 1.273 clientes tienen
  // descuento no-cero. Y `dto_vol` es una FRACCIÓN (0.25 = 25%, es el mismo
  // valor que el carrito usa como `(1 - dto_vol)`), así que va × 100.
  // Auditoría 02/10: las cuatro lecturas de abajo no dependen entre sí (dos de ellas van a Gestión, que es lo lento) y
  // antes iban en fila: ahora salen juntas.
  const [{ data: row }, pagoBlock, facturasBlock, chefBlock] = await Promise.all([
    supabase.from("customers").select("dto_vol").eq("id", customer.id).maybeSingle(),
    // Descuentos por pago: SALEN DE LA TABLA del Panel (app_settings.wa_descuentos_config),
    // no hardcodeados. Así lo que el vendedor edita en "Descuentos por pago" es lo que el bot
    // le responde al cliente — la misma fuente que usan las plantillas de factura.
    pagoDiscountBlock(),
    // Pablo, 30/09: si ya tiene facturas abiertas, fechas reales ("pagando hasta el mié 14/10 tenés 25%").
    descuentosFacturasBlock(customer),
    // Pablo, 01/10 (fase 3): si además tiene facturas de Chef abiertas (cruce por CUIT), van aparte con el descuento de cada
    // factura de Chef. La tabla de descuentos de arriba es la de Loekemeyer.
    ctxPagosDeCliente(customer).then((c) => bloqueFacturasChef(c.cuit)).catch(() => null),
  ]);
  const volumeDiscount = Math.round(Number(row?.dto_vol ?? 0) * 1000) / 10;
  const extraChef = chefBlock ? `\n\n${chefBlock}` : "";
  // Pablo, 30/09 (4.3): "En las últimas facturas no veo el descuento" recibía toda la tabla y todas las facturas abiertas
  // ("muy larga"). Si habla de facturas: sólo la última, por qué no ve el descuento en ella, y el resto si lo pide.
  if (/factur/i.test(message) && facturasBlock.startsWith("*Tus facturas abiertas:*\n")) {
    const cuerpo = facturasBlock.replace("*Tus facturas abiertas:*\n", "");
    const m = cuerpo.match(/\n\n(Tenés además [^\n]+)$/);
    const ultima = m ? cuerpo.slice(0, m.index) : cuerpo;
    return `${customer.business_name}, tu última factura:\n${ultima}\n\nTu descuento por volumen (${volumeDiscount}%) ya viene en los precios. ` +
      `El de pago no figura en la factura: se te reconoce cuando pagás, según los días que pasaron.${m ? `\n\n${m[1]}` : ""}${extraChef}`;
  }

  // Plantilla editable desde el front: si trae {{descuento_volumen}} o {{descuentos_pago}}
  // se renderiza con los datos reales; si no, se usa el texto por defecto (también dinámico).
  // Una línea con un token vacío se saca entera (sin facturas abiertas no queda "Tus facturas:" suelto).
  const tpl = String(faq?.bot_response ?? "").trim();
  if (tpl.includes("{{descuento_volumen}}") || tpl.includes("{{descuentos_pago}}")) {
    const vars = {
      nombre_cliente: customer.business_name,
      descuento_volumen: volumeDiscount,
      descuentos_pago: pagoBlock,
      descuentos_facturas: facturasBlock,
    };
    return renderTemplate(sinLineasSinDato(tpl, vars), vars) + extraChef;
  }
  const pago = pagoBlock ? `\n💰 *Por pago*, contando desde la fecha de la factura:\n${pagoBlock}` : "";
  const fac = facturasBlock ? `\n\n${facturasBlock}` : "";
  return `${customer.business_name}, tus descuentos son:\n📦 *Por volumen*: ${volumeDiscount}% (ya incluido en tus precios de la web)\n💻 *Por compra web*: 2% adicional${pago}${fac}\n\nLa factura sale con el total lleno: el descuento por pago se te reconoce cuando pagás, según los días que pasaron.${extraChef}`;
}

// Facturas abiertas del cliente con las fechas REALES de cada descuento (Pablo, 30/09: "si ya tiene una factura
// deberías tomar fechas reales, si pagás antes de tal fecha tenés este descuento"; "si eligió e-cheq hay que reclamar
// el envío"). Fuente: GV_Cobranza_Deuda_Viva de Gestión (una fila por comprobante con saldo; se recalcula desde el
// Excel de deuda + los pagos del banco). La factura sale con el total lleno y el descuento se gana según los días que
// pasan desde la fecha de la factura (cobranzas_escalones = wa_descuentos_config): se cuentan corridos y se corren al
// hábil (wa_proximo_habil), igual que la fecha que ya le mandamos con la factura (lk_factura-check).
// Condición de la factura:
//   e-cheq → el descuento es fijo por el plazo del cheque: se le recuerda mandarlo, con la fecha y el monto.
//   "NN FF" / "Sin Cotizador" → sin descuento por pago: sólo el saldo.
//   contado / crédito / "Prefiero no decidir" / sin dato → los escalones que todavía no vencieron.
type GrupoDeuda = { fecha: string; condicion: string; saldo: number; n: number };

// Helpers compartidos por la FAQ de descuentos y el reenvío de factura (misma cuenta de fechas y montos).
async function contextoDescuentos() {
  // deno-lint-ignore no-explicit-any
  const cfg: any = JSON.parse((await getSetting("wa_descuentos_config")) ?? "{}");
  const pesos = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");
  const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const conDia = (iso: string) => { const d = new Date(iso + "T12:00:00Z"); return `${DIAS[d.getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`; };
  const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const cache = new Map<string, string>();
  const habilDesde = async (fecha: string, dias: number) => {
    const d = new Date(fecha + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + dias);
    const iso = d.toISOString().slice(0, 10);
    if (!cache.has(iso)) {
      const { data } = await supabase.rpc("wa_proximo_habil", { p: iso });
      cache.set(iso, typeof data === "string" ? data.slice(0, 10) : iso);
    }
    return cache.get(iso)!;
  };
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  const ultimoNum = (s: unknown) => Math.max(0, ...(String(s ?? "").match(/\d+/g) ?? []).map(Number));
  // Escalones por días desde la factura: contado + crédito (fin de cada tramo).
  const escalones: Array<{ dias: number; dto: number }> = [];
  if (cfg?.contado) escalones.push({ dias: Number(cfg.contado.dias_limite) || 14, dto: Number(cfg.contado.dto) || 0 });
  for (const r of (cfg?.credito ?? [])) if (ultimoNum(r?.label)) escalones.push({ dias: ultimoNum(r.label), dto: Number(r.dto) || 0 });
  escalones.sort((a, b) => a.dias - b.dias);

  // Líneas de pago de un grupo. `soloHoy`: sólo el escalón vigente hoy ("si la pagás hoy tenés X%").
  const lineasPago = async (gr: GrupoDeuda, soloHoy = false): Promise<string[]> => {
    const lineas: string[] = [];
    if (/e-?cheq/i.test(gr.condicion)) {
      const dias = ultimoNum(gr.condicion) || 90;
      // deno-lint-ignore no-explicit-any
      const r = (cfg?.echeq ?? []).find((x: any) => ultimoNum(x?.label) === dias);
      const dto = Number(r?.dto) || 0;
      const fechaCheque = await habilDesde(gr.fecha, dias);
      // Saldo abierto con e-cheq = no figura cobrado. Puede estar en camino: por eso "si todavía no lo mandaste".
      lineas.push(`⚠️ Elegiste pagar con *e-cheq a ${dias} días* y no lo tenemos registrado.`);
      lineas.push(`Si todavía no lo mandaste: e-cheq con fecha ${ddmm(fechaCheque)} por ${pesos(gr.saldo * (1 - dto))}${dto ? ` (${Math.round(dto * 100)}% dto)` : ""}.`);
      return lineas;
    }
    if (/\bFF\b|sin cotizador/i.test(gr.condicion)) return [`Condición ${gr.condicion.trim()}: sin descuento por pago.`];
    for (const e of escalones) {
      const hasta = await habilDesde(gr.fecha, e.dias);
      if (hasta < hoy) continue;
      if (soloHoy) {
        return [`💰 Si la pagás hoy tenés *${Math.round(e.dto * 100)}% de descuento*: pagás *${pesos(gr.saldo * (1 - e.dto))}* en vez de ${pesos(gr.saldo)} (vale hasta el ${conDia(hasta)}).`];
      }
      lineas.push(`• Pagando hasta el ${conDia(hasta)}: ${Math.round(e.dto * 100)}% → pagás ${pesos(gr.saldo * (1 - e.dto))}`);
    }
    if (!lineas.length) lineas.push(`Ya pasó el plazo de descuento por pago: el saldo es ${pesos(gr.saldo)}.`);
    return lineas;
  };
  return { cfg, pesos, ddmm, conDia, hoy, lineasPago };
}

// Pablo, 01/10 (fase 3, D008): las respuestas de pagos sirven para las dos empresas. El contexto dice qué cuentas tiene
// quien escribe: el código de Loekemeyer (si es cliente de LK) y el CUIT, que es lo que cruza con Chef (el número de
// cliente es otro en cada empresa). Un cliente sólo de Chef llega desde _shared/chef.ts con codLk = null.
// codChef: la cuenta de Chef desde la que escribe (un cliente sólo de Chef), por si el CUIT no está cargado.
export type CtxPagos = { codLk: string | null; cuit: string | null; codChef?: string | null };

export async function ctxPagosDeCliente(customer: NonNullable<Customer>): Promise<CtxPagos> {
  const { data } = await supabase.from("customers").select("cuit").eq("id", customer.id).maybeSingle();
  return { codLk: String(customer.cod_cliente), cuit: data?.cuit ?? null };
}

// Una factura de Chef con saldo (GV_Cobranza_Deuda_Viva). En Chef el descuento por pago lo trae cada factura (dto_cond,
// hasta `vence`, sólo sin pagos parciales: mismo criterio que consultar_mis_facturas); la tabla de LK no aplica.
// deno-lint-ignore no-explicit-any
function lineaFacturaChef(f: any, soloHoy: boolean, c: Awaited<ReturnType<typeof contextoDescuentos>>): string {
  const { pesos, ddmm, conDia, hoy } = c;
  const pend = Number(f.pendiente || 0), lista = Number(f.lista || 0), dto = Number(f.dto_cond || 0);
  const vence = String(f.vence ?? "").slice(0, 10) || null;
  if (vence && vence >= hoy && dto > 0 && Math.abs(pend - lista) < 1) {
    return soloHoy
      ? `💰 Si la pagás hasta el ${conDia(vence)} tenés *${Math.round(dto * 100)}% de descuento*: pagás *${pesos(pend * (1 - dto))}* en vez de ${pesos(pend)}.`
      : `• Pagando hasta el ${conDia(vence)}: ${Math.round(dto * 100)}% → pagás ${pesos(pend * (1 - dto))}`;
  }
  if (vence && vence < hoy) return `${soloHoy ? "" : "• "}Saldo ${pesos(pend)} (venció el ${ddmm(vence)}).`;
  return `${soloHoy ? "" : "• "}Saldo ${pesos(pend)}${vence ? ` (vence el ${ddmm(vence)})` : ""}.`;
}

/**
 * Facturas de Chef abiertas de un CUIT con su descuento vigente (FAQ #8 y la consulta de descuentos de un cliente de Chef).
 * "" = no tiene facturas de Chef con saldo; null = Gestión no respondió.
 */
export async function bloqueFacturasChef(cuit: unknown): Promise<string | null> {
  const deuda = await deudaChefPorCuit(cuit);
  if (deuda === null) return null;
  if (!deuda.length) return "";
  const c = await contextoDescuentos();
  const { pesos, ddmm } = c;
  const nuevas = [...deuda].sort((a, b) => String(b.fecha ?? "").localeCompare(String(a.fecha ?? "")));
  const MAX = 3;
  const bloques: string[] = [];
  for (const f of nuevas.slice(0, MAX)) {
    bloques.push(`🧾 *Factura ${f.comprobante ?? ""} del ${ddmm(String(f.fecha ?? ""))}* — saldo ${pesos(Number(f.pendiente))}\n  ${lineaFacturaChef(f, false, c)}`);
  }
  const resto = nuevas.slice(MAX);
  if (resto.length) {
    bloques.push(`Tenés además ${resto.length} factura${resto.length > 1 ? "s" : ""} de Chef abierta${resto.length > 1 ? "s" : ""} por ` +
      `${pesos(resto.reduce((s, f) => s + Number(f.pendiente || 0), 0))}: si querés, te paso el detalle.`);
  }
  return "*Tus facturas abiertas de Chef:*\n" + bloques.join("\n\n");
}

// Deuda Viva del cliente agrupada por fecha + condición (varias facturas del mismo día = un pedido), más nuevo primero.
// null = no se pudo leer (no afirmar nada); [] = no tiene facturas con saldo.
async function deudaAgrupada(cod: number | string): Promise<GrupoDeuda[] | null> {
  const g = await getGestionClient("public");
  const { data: filas, error } = await g.from("GV_Cobranza_Deuda_Viva")
    .select("comprobante, fecha, condicion, pendiente")
    .eq("empresa", "lk").eq("cod_cliente", String(cod))
    .gt("pendiente", 0).like("comprobante", "FC%")
    .order("fecha", { ascending: false });
  if (error) { console.warn("deudaAgrupada:", error.message); return null; }
  const grupos: GrupoDeuda[] = [];
  for (const f of (filas ?? []) as Array<{ fecha: string; condicion: string | null; pendiente: number }>) {
    const fecha = String(f.fecha).slice(0, 10), condicion = String(f.condicion ?? "");
    const gr = grupos.find((x) => x.fecha === fecha && x.condicion === condicion);
    if (gr) { gr.saldo += Number(f.pendiente); gr.n++; } else grupos.push({ fecha, condicion, saldo: Number(f.pendiente), n: 1 });
  }
  return grupos;
}

// Se muestran los 3 grupos más nuevos; el resto va resumido.
async function descuentosFacturasBlock(customer: NonNullable<Customer>): Promise<string> {
  try {
    const grupos = await deudaAgrupada(customer.cod_cliente);
    // Pablo, 30/09: sin facturas abiertas se lo dice (un error de lectura, en cambio, devuelve "" y la línea no sale).
    if (grupos === null) return "";
    if (!grupos.length) return "*Tus facturas abiertas:* no tenés facturas con saldo pendiente. ✅";
    const { pesos, ddmm, lineasPago } = await contextoDescuentos();
    const MAX = 1;   // Pablo, 30/09 (4.3): sólo la última; el resto si lo pide.
    const bloques: string[] = [];
    for (const gr of grupos.slice(0, MAX)) {
      const cab = `🧾 *${gr.n > 1 ? `Facturas del ${ddmm(gr.fecha)} (${gr.n})` : `Factura del ${ddmm(gr.fecha)}`}* — saldo ${pesos(gr.saldo)}`;
      bloques.push([cab, ...(await lineasPago(gr)).map((l) => "  " + l)].join("\n"));
    }
    const resto = grupos.slice(MAX);
    if (resto.length) {
      const n = resto.reduce((s, x) => s + x.n, 0), saldo = resto.reduce((s, x) => s + x.saldo, 0);
      bloques.push(`Tenés además ${n} factura${n > 1 ? "s" : ""} abierta${n > 1 ? "s" : ""} por ${pesos(saldo)}: si querés, te paso el detalle.`);
    }
    return "*Tus facturas abiertas:*\n" + bloques.join("\n\n");
  } catch (e) {
    console.warn("descuentosFacturasBlock:", e instanceof Error ? e.message : e);
    return "";
  }
}

// Reenvío de la factura (Pablo, 30/09: "enviale la factura si el cliente la vuelve a pedir y recordale los descuentos,
// si la pagás hoy tenés tanto de descuento"). Busca las facturas del cliente en isis_lk.documentos (mismos PDF que
// manda el aviso automático, bucket isis-lk de Gestión) y manda las del último día facturado, o las de la fecha o el mes
// que nombre ("la del 28/09", "la de julio"). Va como documento suelto: el cliente acaba de escribir, así que está
// dentro de las 24 h y no hace falta plantilla. El envío pasa por wa-guard como todo lo demás (llave de envíos).
// Si la factura sigue con saldo, agrega el descuento vigente HOY (misma cuenta que la FAQ de descuentos) y los datos
// para transferir; si no tiene saldo, "ya figura pagada".
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
// 6.3: último pago registrado del cliente (gv_cobranza_recibos de Gestión: un recibo por pago imputado). Si hay uno de
// los últimos 7 días se le confirma; si no, se le dice que todavía no figura y se avisa a Cobranzas (nunca que no pagó).
type Recibo = { recibo: string; fecha_primer_cobro: string; pagado: number; medio: string | null; empresa: "lk" | "chef" };

/** Último recibo de esas cuentas en una empresa (gv_cobranza_recibos de Gestión). undefined = no hay; lanza si falla. */
async function ultimoRecibo(empresa: "lk" | "chef", cods: string[]): Promise<Recibo | undefined> {
  if (!cods.length) return undefined;
  const g = await getGestionClient("public");
  const r = await Promise.race([
    g.from("gv_cobranza_recibos").select("recibo, fecha_primer_cobro, pagado, medio").eq("empresa", empresa)
      .in("cod_cliente", cods).not("fecha_primer_cobro", "is", null)
      .order("fecha_primer_cobro", { ascending: false }).limit(1),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
  ]);
  if (r.error) throw new Error(r.error.message);
  const u = (r.data ?? [])[0] as Omit<Recibo, "empresa"> | undefined;
  return u ? { ...u, empresa } : undefined;
}

// Pablo, 01/10 (fase 3): también los recibos de Chef, de las cuentas de Chef del mismo CUIT. Si tiene cuenta en las dos
// empresas, se dice a cuál fue el pago.
export async function pagoRegistrado(ctx: CtxPagos, text: string): Promise<FaqResult> {
  // Pablo, 01/10: cuando el pago no figura y se avisa a Cobranzas, el cliente recibe también cómo comunicarse con ellos
  // (ficha Empresas, de la empresa o las empresas en las que tiene cuenta). Sin datos cargados, el mensaje sale como siempre.
  let datos: string | null = null;
  const cobranzas = (reply: string, detalle: string): FaqResult => ({
    reply: datos ? `${reply}\nPara consultas sobre tus pagos podés comunicarte con Cobranzas: ${datos}` : reply,
    intent: "pago_recibido", automation_level: "needs_human",
    topic: "Pregunta si llegó su pago", alerta: { motivo: "pago", urgente: false, detalle } });
  const cargarDatos = async (tieneChef: boolean) => {
    try { datos = datosCobranzas(await datosEmpresas(), { lk: !!ctx.codLk || !tieneChef, chef: tieneChef }); }
    catch (e) { console.warn("pagoRegistrado: datos de Cobranzas:", e instanceof Error ? e.message : e); }
  };
  try {
    const codsChef = [...new Set([...(await codigosChef(ctx.cuit)), ...(ctx.codChef ? [ctx.codChef] : [])])];
    await cargarDatos(codsChef.length > 0);
    const [lk, ch] = await Promise.all([ultimoRecibo("lk", ctx.codLk ? [ctx.codLk] : []), ultimoRecibo("chef", codsChef)]);
    const dos = !!ctx.codLk && codsChef.length > 0;
    const u = [lk, ch].filter((x): x is Recibo => !!x)
      .sort((a, b) => b.fecha_primer_cobro.localeCompare(a.fecha_primer_cobro))[0];
    const a = (x: Recibo) => (dos ? (x.empresa === "chef" ? " a Chef" : " a Loekemeyer") : "");
    const pesos = (n: unknown) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");
    const ddmm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
    const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const dias = u ? Math.round((Date.parse(hoy) - Date.parse(u.fecha_primer_cobro.slice(0, 10))) / 86400_000) : null;
    if (u && dias !== null && dias <= 7) {
      return { reply: `Sí, tenemos registrado tu pago${a(u)} del ${ddmm(u.fecha_primer_cobro)} por ${pesos(u.pagado)}${u.medio ? ` (${u.medio})` : ""}. ¡Gracias! ` +
        "Si te referís a otro pago, contame la fecha y el importe y le aviso a Cobranzas.", intent: "pago_recibido", automation_level: "semi_auto" };
    }
    const ultimo = u ? ` (el último que tenemos es del ${ddmm(u.fecha_primer_cobro)} por ${pesos(u.pagado)}${a(u)})` : "";
    return cobranzas(`Todavía no lo vemos registrado${ultimo}. Le aviso a Cobranzas para que lo revise y te confirme por acá. Si tenés el comprobante, mandalo por acá así lo agilizan. 🙏`,
      `Pregunta si llegó su pago; no hay recibo de los últimos 7 días${u ? ` (último ${ddmm(u.fecha_primer_cobro)} ${pesos(u.pagado)}${a(u)})` : ""}. Escribió: ${text.slice(0, 150)}`);
  } catch (e) {
    console.warn("pagoRegistrado:", e instanceof Error ? e.message : e);
    if (datos === null) await cargarDatos(!!ctx.codChef);
    return cobranzas("Le aviso a Cobranzas para que revise tu pago y te confirme por acá. 🙏", `Pregunta si llegó su pago. Escribió: ${text.slice(0, 150)}`);
  }
}

// 4.4: busca en las facturas del cliente (isis_lk.documentos, las mismas que reenvía el bot) dos o más del mismo importe
// en 15 días. Encuentre o no, lo revisa una persona: nunca se le dice al cliente que se equivocó.
/**
 * Facturas de Loekemeyer de un cliente (isis_lk.documentos), más nueva primero. Sólo las emitidas a clientes: hasta el
 * 01/10 el filtro era sólo código + tipo "FC%", que también trae "FC Compra" (facturas de proveedores), y 37 códigos de
 * proveedor coinciden con un código de cliente.
 */
async function facturasLk(cod: string, desde?: string): Promise<FacturaDoc[]> {
  const isis = await getIsisClient();
  let q = isis.from("documentos").select("numero, punto_venta, letra, fecha, total, storage_path")
    .eq("contraparte_codigo", cod).eq("contraparte_tipo", "cliente").like("tipo", "FC%");
  if (desde) q = q.gte("fecha", desde);
  const { data, error } = await q.order("fecha", { ascending: false }).limit(60);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Omit<FacturaDoc, "empresa">>).map((d) => ({ ...d, empresa: "lk" as const }));
}

/** Facturas de las dos empresas de quien escribe. Lanza si no se pudo leer ninguna de las que corresponde mirar. */
async function facturasDe(ctx: CtxPagos, desde?: string): Promise<{ lk: FacturaDoc[]; ch: FacturaDoc[] }> {
  const [lk, ch] = await Promise.all([ctx.codLk ? facturasLk(ctx.codLk, desde) : Promise.resolve([]), facturasChef(ctx.cuit, desde)]);
  if (ch === null && !ctx.codLk) throw new Error("Gestión no respondió (isis_ch)");
  return { lk, ch: ch ?? [] };
}

export async function facturaDuplicada(ctx: CtxPagos, text: string): Promise<FaqResult> {
  const res = (reply: string, detalle: string, urgente: boolean): FaqResult => ({
    reply, intent: "factura_duplicada", automation_level: "needs_human", topic: "Factura duplicada",
    alerta: { motivo: "reclamo", urgente, detalle } });
  try {
    const { lk, ch } = await facturasDe(ctx, new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10));
    const dos = lk.length > 0 && ch.length > 0;
    const nro = (d: FacturaDoc) => `FC${d.letra ?? ""} ${d.punto_venta}-${d.numero}${dos && d.empresa === "chef" ? " (Chef)" : ""}`;
    const ddmm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
    // Duplicadas dentro de una misma empresa: una de LK y una de Chef por el mismo importe no son la misma factura.
    for (const d of [...lk, ...ch]) {
      const iguales = (d.empresa === "chef" ? ch : lk).filter((x) => Math.round(Number(x.total)) === Math.round(Number(d.total)) &&
        Math.abs(Date.parse(x.fecha.slice(0, 10)) - Date.parse(d.fecha.slice(0, 10))) <= 15 * 86400_000);
      if (iguales.length > 1) {
        const lista = iguales.map((x) => `${nro(x)} del ${ddmm(x.fecha)}`).join(" y ");
        const importe = "$" + Math.round(Number(d.total)).toLocaleString("es-AR");
        return res(`Disculpá el inconveniente. Veo ${iguales.length} facturas por ${importe}: ${lista}. Le paso a una persona del equipo para que lo corrija y te confirme por acá. 🙏`,
          `Factura duplicada: ${lista} por ${importe}. Escribió: ${text.slice(0, 150)}`, true);
      }
    }
    return res("Disculpá el inconveniente. En tus facturas de los últimos 60 días no encuentro dos por el mismo importe, así que le paso a una persona del equipo para que lo revise con vos. Si tenés los números de las facturas, pasámelos por acá. 🙏",
      `Dice que le facturaron dos veces; no hay dos facturas del mismo importe en 60 días. Escribió: ${text.slice(0, 150)}`, false);
  } catch (e) {
    console.warn("facturaDuplicada:", e instanceof Error ? e.message : e);
    return res("Disculpá el inconveniente. Le paso a una persona del equipo para que lo revise y te confirme por acá. 🙏",
      `Dice que le facturaron dos veces. Escribió: ${text.slice(0, 150)}`, true);
  }
}

// Pablo, 01/10 (fase 3): busca en las facturas de las dos empresas (LK por código, Chef por CUIT en isis_ch). Si nombra
// una empresa ("la de Chef"), sólo esa. Cada factura sale de su bucket y con los datos de pago y el descuento de SU
// empresa: nunca el alias de una para la factura de la otra.
export async function lookupFacturaReenvio(ctx: CtxPagos, message: string): Promise<FaqResult | null> {
  const derivar = (motivo: string, texto: string): FaqResult => ({
    reply: texto, intent: "factura_reenvio", automation_level: "semi_auto",
    alerta: { motivo, urgente: false, detalle: `Pidió la factura: "${message.slice(0, 150)}"` },
  });
  try {
    const isis = await getIsisClient();
    const { lk, ch } = await facturasDe(ctx);
    const t0 = message.toLowerCase();
    const dos = lk.length > 0 && ch.length > 0;
    let lista = [...lk, ...ch].sort((a, b) => b.fecha.localeCompare(a.fecha));
    if (/\bchef\b/.test(t0)) lista = lista.filter((d) => d.empresa === "chef");
    else if (/loeke/.test(t0)) lista = lista.filter((d) => d.empresa === "lk");
    if (!lista.length) {
      return derivar("factura_no_encontrada", "No encuentro facturas a tu nombre. Ya le paso el pedido a una persona del equipo para que te la mande. 🙏");
    }
    // Qué fecha: "28/09" → ese día; "julio" → la última de ese mes; si no, el último día facturado.
    const t = message.toLowerCase();
    const dm = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    const mes = MESES.findIndex((m) => t.includes(m));
    let elegidas = lista.filter((d) => d.fecha.slice(0, 10) === lista[0].fecha.slice(0, 10));
    if (dm) {
      const mmdd = `-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}`;
      const x = lista.filter((d) => d.fecha.slice(4, 10) === mmdd);
      if (x.length) elegidas = x;
    } else if (mes >= 0) {
      const delMes = lista.filter((d) => Number(d.fecha.slice(5, 7)) === mes + 1);
      if (delMes.length) elegidas = delMes.filter((d) => d.fecha.slice(0, 10) === delMes[0].fecha.slice(0, 10));
    }
    const fecha = elegidas[0].fecha.slice(0, 10);
    const conPdf = elegidas.filter((d) => d.storage_path).slice(0, 5);
    const documentos: Array<{ url: string; filename: string }> = [];
    for (const d of conPdf) {
      // Cada empresa tiene su bucket en Gestión (isis-lk / isis-ch).
      const { data: s } = await isis.storage.from(d.empresa === "chef" ? "isis-ch" : "isis-lk").createSignedUrl(d.storage_path!, 3600);
      if (s?.signedUrl) {
        documentos.push({ url: s.signedUrl,
          filename: `Factura ${d.letra ?? ""} ${d.punto_venta}-${d.numero}${dos && d.empresa === "chef" ? " Chef" : ""}.pdf`.replace(/\s+/g, " ") });
      }
    }
    const { pesos, ddmm, lineasPago, cfg } = await contextoDescuentos();
    if (!documentos.length) {
      return derivar("factura_sin_pdf", `Tu factura del ${ddmm(fecha)} todavía no tiene el PDF cargado. Ya le paso el pedido a una persona del equipo para que te la mande. 🙏`);
    }
    const total = elegidas.reduce((s, d) => s + Number(d.total || 0), 0);
    const empresasDia = new Set(elegidas.map((d) => d.empresa));
    const deQuien = dos && empresasDia.size === 1 ? (empresasDia.has("chef") ? " de Chef" : " de Loekemeyer") : "";
    const lineas = [`Te mando ${documentos.length > 1 ? `las ${documentos.length} facturas` : "la factura"}${deQuien} del ${ddmm(fecha)} (total ${pesos(total)}). 📄`];
    let alerta: FaqResult["alerta"];
    // Loekemeyer: descuento vigente hoy, con el saldo real de ese día (Deuda Viva) y la tabla de descuentos de LK.
    if (empresasDia.has("lk") && ctx.codLk) {
      if (empresasDia.size > 1) lineas.push("", "*Loekemeyer:*");
      const grupos = await deudaAgrupada(ctx.codLk);
      const delDia = (grupos ?? []).filter((g) => g.fecha === fecha);
      if (grupos && !delDia.length) lineas.push("✅ Ya figura pagada.");
      for (const gr of delDia) lineas.push("", ...(await lineasPago(gr, true)));
      if (delDia.length) {
        const alias = cfg?.pago?.alias ?? PAGO_ALIAS_FALLBACK, cbu = cfg?.pago?.cbu ?? PAGO_CBU_FALLBACK;
        lineas.push("", `Datos para el pago:\nAlias: ${alias}\nCBU: ${cbu}`);
      }
    }
    // Chef: el saldo y el descuento de cada factura (Deuda Viva, por CUIT) y los datos de pago de Chef.
    let hayChefConSaldo = false;
    if (empresasDia.has("chef")) {
      if (empresasDia.size > 1) lineas.push("", "*Chef:*");
      const deuda = await deudaChefPorCuit(ctx.cuit);
      const delDia = (deuda ?? []).filter((f) => String(f.fecha ?? "").slice(0, 10) === fecha);
      if (deuda && !delDia.length) lineas.push("✅ Ya figura pagada.");
      const c = await contextoDescuentos();
      for (const f of delDia) lineas.push("", lineaFacturaChef(f, true, c));
      if (delDia.length) {
        hayChefConSaldo = true;
        const datos = textoDatosPago((await datosEmpresas()).chef, false);
        lineas.push("", datos ? `Datos para el pago:\n${datos}` : "Los datos para transferir a Chef te los pasa Cobranzas por acá.");
        if (!datos) alerta = { motivo: "pago", urgente: false, detalle: "Se le reenvió una factura de Chef con saldo y la ficha Empresas no tiene el alias/CBU de Chef: pasale los datos para transferir." };
      }
    }
    if (lineas.some((l) => l.startsWith("Datos para el pago")) || hayChefConSaldo) lineas.push("", "Cuando pagues, mandanos el comprobante por acá. 🙏");
    return { reply: lineas.join("\n"), intent: "factura_reenvio", automation_level: "semi_auto", documentos, ...(alerta ? { alerta } : {}) };
  } catch (e) {
    console.warn("lookupFacturaReenvio:", e instanceof Error ? e.message : e);
    return derivar("factura_error", "No pude buscar tu factura en este momento. Ya le paso el pedido a una persona del equipo para que te la mande. 🙏");
  }
}

// Bloque "Por pago" armado desde wa_descuentos_config (contado + crédito[] + e-cheq[]).
// Fuente única compartida con las plantillas de factura (lk_factura-check). Editable en el Panel.
async function pagoDiscountBlock(): Promise<string> {
  try {
    // deno-lint-ignore no-explicit-any
    const cfg: any = JSON.parse((await getSetting("wa_descuentos_config")) ?? "{}");
    const pct = (d: unknown) => Math.round((Number(d) || 0) * 100);
    const lines: string[] = [];
    if (cfg?.contado) lines.push(`  • Contado (hasta ${Number(cfg.contado.dias_limite) || 0} días): ${pct(cfg.contado.dto)}%`);
    // deno-lint-ignore no-explicit-any
    for (const r of (cfg?.credito ?? [])) if (r?.label) lines.push(`  • Crédito ${r.label} días: ${pct(r.dto)}%`);
    // deno-lint-ignore no-explicit-any
    for (const r of (cfg?.echeq ?? [])) if (r?.label) lines.push(`  • E-cheq ${r.label} días: ${pct(r.dto)}%`);
    return lines.join("\n");
  } catch { return ""; }
}

// Artículo mencionado en una frase ("¿tienen stock del 506?", "me pasás el precio del 506?"):
// primero un código dentro de la frase; si no, el nombre sin las palabras de la pregunta. Antes se
// buscaba la frase entera y no encontraba nada (simulación 28/09).
async function articuloDeLaFrase(message: string): Promise<{ cod: string; description: string; list_price: number } | null> {
  for (const cod of message.match(/\b\d{3,5}[a-z]?\b/gi) ?? []) {
    const { data } = await supabase.from("products").select("cod, description, list_price").eq("cod", cod.toUpperCase()).limit(1);
    if (data?.[0]) return data[0];
  }
  const nombre = message.toLowerCase()
    .replace(/\b(tienen|tenes|tenés|hay|stock|disponib\w*|precio\w*|cu[aá]nto|sale|salen|cuesta|cuestan|vale|valen|me|pas[aá]s|pasame|decime|de|del|la|el|los|las|un|una|queda\w*|todav[ií]a)\b/g, " ")
    .replace(/[¿?!.,]/g, " ").replace(/\s+/g, " ").trim();
  if (nombre.length < 3) return null;
  const { data: products } = await supabase.rpc("wa_product_match", { p_query: nombre, p_limit: 1 });
  return products?.[0] ?? null;
}

async function lookupProductPrice(customer: NonNullable<Customer>, message: string): Promise<string | null> {
  const p = await articuloDeLaFrase(message);
  if (!p) return `¿De qué artículo? Pasame el código o el nombre y te digo el precio.`;
  const basePrice = Number(p.list_price);
  const iva = basePrice * 0.21;
  const withIva = basePrice + iva;
  const webDiscount = 0.02;
  const finalPrice = withIva * (1 - webDiscount);
  const $ = (n: number) => n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${customer.business_name}, el artículo *${p.description}* (${p.cod}), precio por unidad:\n💰 Precio sin IVA: $${$(basePrice)}\n📊 IVA 21%: $${$(iva)}\n✅ Total con IVA: $${$(withIva)}\n\n🏷️ Tu precio con descuento web (2%): $${$(finalPrice)}\n\n*(Los descuentos por pago se aplican en el carrito)*`;
}

async function lookupProductStock(customer: NonNullable<Customer>, message: string): Promise<string | null> {
  // Stock real (Gestión − pedidos web abiertos), sin números para el cliente. Antes leía p.stock, que
  // wa_product_match no devuelve: contestaba "sin stock" a todo.
  const p = await articuloDeLaFrase(message);
  if (!p) {
    return `¿Qué artículo te interesa? Pasame el código o el nombre y te confirmo si hay stock.`;
  }
  try {
    const st = await stockArticulo(p.cod);
    if (!st) return null;
    if (stockNecesitaHumano(st)) {
      await notificarHumano({
        tipo: "escalation", customerId: customer.id,
        contexto: { motivo: "consulta_stock", texto: `Consulta de stock: ${p.description} (${p.cod})`,
          razon_social: customer.business_name },
      });
    }
    return textoStock(p.description, p.cod, st) + (st.nivel === "hay" ? "\n\nPodés hacer el pedido en loekemeyer.com." : "");
  } catch (e) {
    console.error("lookupProductStock:", e);
    return null; // sin dato → sigue el flujo normal (agente), que deriva
  }
}

async function lookupOrderModify(customer: NonNullable<Customer>): Promise<string | null> {
  const { data: orders } = await supabase
    .from("orders")
    .select("id, status, created_at")
    .eq("customer_id", customer.id)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(10);
  const vivos = await sinAnulados(orders ?? []);
  if (!vivos.length) return `No tenés pedidos recientes que modificar. ¿Quieres hacer uno nuevo?`;
  const latest = vivos[0];
  const canModify = ["pendiente", "recibido"].includes(latest.status || "");
  const pd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(latest.created_at));
  const del = `${pd.slice(8, 10)}/${pd.slice(5, 7)}`;
  if (!canModify) return `Tu último pedido (el del ${del}) ya no se puede modificar desde acá.\n\nDerivamos tu solicitud a un vendedor para que evalúe opciones.`;
  return `Tu pedido del ${del} aún puede modificarse. ¿Qué cambios necesitás?\n📝 Indicame:\n• Artículos que quieres agregar/quitar\n• Cantidades\n\nUn vendedor va a confirmar los cambios.`;
}
