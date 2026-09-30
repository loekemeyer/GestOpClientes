// Flujo cara-al-cliente 2026-09-04: no-cliente prioriza institucional; lookup payment_data
//   (alias/CBU desde wa_descuentos_config). Deploy vía CI al pushear a main.
// _shared/faq.ts — Pre-check de FAQs (respuestas AUTO/SEMIAUTO/HUMANO)
// que corre antes de tocar el LLM. Consume la tabla `wa_faq` vía la RPC
// `wa_faq_match` y elige entre `bot_response` (cliente identificado) e
// `institutional_response` (sin cliente, tono institucional).
//
// El agente conversacional (`runConversation`) queda como último recurso:
// solo se invoca si acá no hay match útil.

import { getGestionClient, getIsisClient, supabase } from "./supabase.ts";
import { notificarHumano } from "./alertas.ts";
import { stockArticulo, stockNecesitaHumano, textoStock } from "./stock.ts";
import { sinAnulados } from "./pedidos-anulados.ts";

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
  if (customer && vaALaIA(text)) return null;
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
    } else if (customer && top.db_lookup_type === "factura_reenvio") {
      const r = await lookupFacturaReenvio(customer, text);
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
    case "customer_discount":  return lookupCustomerDiscount(customer, faq);
    case "product_price":      return lookupProductPrice(customer, message);
    case "product_stock":      return lookupProductStock(customer, message);
    case "order_modify":       return lookupOrderModify(customer);
    default:                   return null;
  }
}

// Datos para transferir (alias / CBU). SEMIAUTO editable: el texto se edita en
// wa_faq (tokens {{alias}} {{cbu}}); los valores salen de app_settings.wa_descuentos_config
// (pago.alias / pago.cbu), editables desde el Panel de Control. Sirve a cliente y no-cliente.
const PAGO_ALIAS_FALLBACK = "loeke.srl";
const PAGO_CBU_FALLBACK = "1910027855002702387450";
// deno-lint-ignore no-explicit-any
async function lookupPaymentData(faq: any, customer: Customer): Promise<string | null> {
  let alias = PAGO_ALIAS_FALLBACK, cbu = PAGO_CBU_FALLBACK;
  const { data } = await supabase.from("app_settings").select("value").eq("key", "wa_descuentos_config").maybeSingle();
  try {
    const cfg = JSON.parse(String(data?.value ?? "{}"));
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
  return renderTemplate(String(tpl), { nombre_cliente: customer?.business_name, alias, cbu }).trim();
}

const RE_NO_LLEGO = /\b(no (me )?(lleg[oó]|vino|entregaron|trajeron)|nunca lleg|todav[ií]a no (lleg|vino|me)|ten[ií]a que (llegar|venir|haber llegado)|deb[ií]a (llegar|venir)|sigo esperando|no lleg[oó] nada)/i;
const RE_DETALLE_PEDIDO = /(qu[eé]\s+(incluye|tiene|trae|lleva|contiene|ped[ií]|hab[ií]a|va)\b[^?]{0,40}pedido|pedido[^?]{0,30}\b(incluye|contiene|trae|tiene)\b|detalle\s+(de(l)?\s+)?(mi\s+|el\s+)?pedido|(art[ií]culos|productos|[ií]tems|cosas)\s+(de(l)?|en)\s+(mi\s+|el\s+)?pedido)/i;
const RE_INGRESO = /\bcu[aá]ndo\s+(ingres|entra|vuelve|repon|hay\b|habr|llega(n)?\s+(el|la|los|las|un|una)\s+(art|prod|import|nuev|novedad))/i;
const RE_RECLAMO = /(\brot[oa]s?\b|\bromp|fallad|defectuos|mal estado|da[ñn]ad|cobr\S*\s+(de\s+m[aá]s|mal|distinto|otro)|precio\s+(viejo|distinto|equivocado|mal)|no\s+(me\s+)?(aplic|respet|hicieron\s+el\s+descuento)|est[aá]\s+mal\b|vino\s+mal|lleg\w*\s+(mal|\d+\s+de\s+\d+)|llegaron\s+\d+|\bme\s+falt|\bfalt(a|an|aron)\s+\d|incorrect|equivocad|reclam)/i;
const RE_YA_PAGUE = /\b(ya (les |te )?(pagu[eé]|transfer[ií]|deposit[eé]|abon[eé]|cancel[eé])|(les |te )?(transfer[ií]|pagu[eé]|deposit[eé]) (ayer|hoy|el)|sigue figurando|me sigue (apareciendo|saliendo)|no (se )?(me )?(acredit|impact|figura (el|mi) pago))/i;
const RE_RETIRO = /\b(retir(o|ar|arlo|arla|amos|a)|pas(ar|o|amos) a buscar|buscarlo|ir a buscar|lo busco|voy a buscar)\b/i;

/** Pedido abierto más reciente del cliente que va por expreso (no anulado, no entregado). null si no hay. */
const RE_NUEVA_DIRECCION = /(cambi\S*\s+(de\s+|la\s+|mi\s+)?(direcci[oó]n|domicilio|local|sucursal)|me\s+mud|nos\s+mudamos|nueva\s+(direcci[oó]n|sucursal)|(agregar|sumar|cargar)\s+(una\s+)?(direcci[oó]n|sucursal)|otra\s+(direcci[oó]n|sucursal))/i;
const RE_DIRECCION_ENTREGA = /(mi|la)\s+direcci[oó]n\s+de\s+(entrega|env[ií]o)|a\s+d[oó]nde\s+(me\s+)?(lo|la|los|las)?\s*(mand|env[ií]|entreg|despach|llev)|a\s+qu[eé]\s+(sucursal|direcci[oó]n|expreso|transporte)|d[oó]nde\s+(me\s+)?(lo\s+)?entregan|por\s+qu[eé]\s+(expreso|transporte)|qu[eé]\s+(expreso|transporte)\s+(me\s+)?(lo\s+)?(lleva|mand|us)/i;

// A dónde va cada pedido abierto del cliente: sucursal de entrega cargada en la web y, si sale por expreso, cuál.
const RE_DUPLICADO = /((pedido|confirm|carg|compra)[^.?!]{0,40}(duplic|repetid|dos veces|\b2 veces|varias veces|m[aá]s de una vez|tres veces)|(duplic|repetid|dos veces|\b2 veces|varias veces|m[aá]s de una vez)[^.?!]{0,40}(pedido|confirm|carg))/i;
const RE_CLAVE = /((olvid|recuper|resete|blanque|cambi|perd|nueva|bloque|no\s+(me\s+)?(acuerdo|recuerdo))[^.?!]{0,40}(contrase|\bclave|password|usuario)|(contrase|\bclave|password|usuario)[^.?!]{0,40}(olvid|no\s+(me\s+)?(anda|funciona|toma|deja|acuerdo|recuerdo|entra)|incorrect|inv[aá]lid|bloque)|no\s+(puedo|logro|me\s+deja)\s+(entrar|ingresar|loguear)[^.?!]{0,30}(web|p[aá]gina|sistema|cuenta)?|(necesito|pasame|pas[aá]s|mandame|dame|no\s+tengo)\s+(mi\s+|el\s+|un\s+|la\s+)?(usuario|\bclave|contrase))/i;
const RE_SUCURSAL_WEB = /(no\s+(me\s+)?(deja|puedo|aparece|figura|sale)[^.?!]{0,30}sucursal|sucursal[^.?!]{0,30}no\s+(me\s+)?(deja|aparece|figura|sale|puedo))/i;
// Pablo, 30/09 (simulación con 57 mensajes reales): respuestas fijas que se disparaban por una palabra suelta. Todos estos
// van a la IA, que tiene las herramientas para resolverlos o derivarlos.
// "Quería agregar 60 unidades del 067 al pedido de ayer" → #21 (mínimo de compra) por "unidad". Agregar lo resuelve la IA
// (solicitar_agregado_pedido, botón Aplicar).
const RE_AGREGA_A_PEDIDO = /\b(agreg|sum[aá]|sumar|a[ñn]ad)\w*[^.?!]{0,60}\bpedido\b/i;
// "Te paso el cotizador con el pedido" → #11 (lista de precios) por "cotizador": el cliente MANDA un pedido, no pide la lista.
const RE_ENVIA_PEDIDO = /\b(te\s+|les\s+)?(paso|pasamos|env[ií]o|enviamos|mando|mandamos|adjunt\w*)(?![a-zñáéíóú])[^.?!]{0,40}\b(cotizador|pedido|orden\s+de\s+compra|planilla|excel)/i;
// "¿Recibieron el pago?" → #15 (medios de pago) por "pago": pregunta si LLEGÓ un pago (lo ve Cobranzas).
const RE_PAGO_RECIBIDO = /(recib\w*|lleg[oó]|acredit\w*|impact\w*|vieron|entr[oó])[^.?!]{0,30}\b(el\s+|mi\s+|la\s+)?(pago|transferencia|dep[oó]sito|e-?cheq|cheque)|\b(pago|transferencia|dep[oó]sito)[^.?!]{0,30}\b(recib|lleg[oó]|acredit|impact)/i;
// "El pedido me salió a nombre de mi otra razón social" → #1 (estado de pedidos). Hay que refacturar: lo deriva la IA.
const RE_RAZON_SOCIAL_MAL = /(otra\s+raz[oó]n\s+social|raz[oó]n\s+social\s+(equivocad|incorrect|distint|mal)|a\s+nombre\s+de\s+(mi\s+)?(otra|otro)\b|otro\s+cuit)/i;
// "Me facturaron el mismo pedido dos veces" → control de pedidos repetidos. Es una FACTURA duplicada: reclamo, lo deriva la IA.
const RE_FACTURA_DUPLICADA = /(factur\w*[^.?!]{0,40}(dos veces|\b2 veces|duplicad|repetid|de m[aá]s)|(duplicad|repetid)\w*[^.?!]{0,20}factura)/i;
// "Cargué todo por unidad y después lo edité por caja" → #21 por "unidad": cuenta un error de carga, no pregunta si venden por unidad.
const RE_ERROR_CARGA = /\b(cargu[eé]|cargamos|cargaron|edit[eé]|editamos|me\s+equivoqu[eé]|nos\s+equivocamos|puse|pusimos)(?![a-zñáéíóú])[^.?!]{0,60}\b(unidad|caja|pedido)/i;
function vaALaIA(text: string): boolean {
  return RE_AGREGA_A_PEDIDO.test(text) || RE_PAGO_RECIBIDO.test(text) || RE_RAZON_SOCIAL_MAL.test(text) ||
    RE_FACTURA_DUPLICADA.test(text) ||
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
    supabase.rpc("bot_estado_pedidos_gv", { p_ids: ids }),
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
    supabase.rpc("bot_estado_pedidos_gv", { p_ids: ids }),
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

async function lookupOrderStatus(customer: NonNullable<Customer>): Promise<string> {
  const { data: crudos } = await supabase
    .from("orders")
    .select("id, created_at, total, status")
    .eq("customer_id", customer.id)
    .or("sheets_sent.is.null,sheets_sent.eq.true")   // un pedido que nunca se envió no tiene estado
    .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(15);
  // Anulados o borrados en Gestión: para el bot no existen (pedidos-anulados.ts).
  const orders = (await sinAnulados(crudos ?? [])).slice(0, 5);
  if (!orders?.length) {
    // Pedidos por WhatsApp apagados (28/09): se lo manda a la web, no "decime".
    return `${customer.business_name}, no tenés pedidos recientes (últimos 90 días). Si querés hacer uno, entrá a loekemeyer.com → "Pedidos Mayorista".`;
  }
  // Estado real del pedido en Gestión Virgilio (RPC bot_estado_pedidos_gv, sql/066). Para
  // los pedidos anteriores a Gestión cae sola a order_tracking. Antes se leía order_tracking
  // directo, que llenaba la planilla de Producción y dejó de traer programados/entregados.
  const { data: estados, error: estErr } = await supabase
    .rpc("bot_estado_pedidos_gv", { p_ids: orders.map((o) => o.id) });
  if (estErr) console.error("Error en bot_estado_pedidos_gv:", estErr.message);
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
  let hayExpreso = false;
  const lines = orders.map((o, i) => {
    // deno-lint-ignore no-explicit-any
    const t: any = estadoMap.get(String(o.id));
    const rawStatus = t?.status ?? o.status;
    const statusText = STATUS_MAP[rawStatus] || rawStatus;
    const m = modoDe.get(String(o.id)) ?? { modo: "reparto", expreso: null };
    let line = `${i + 1}️⃣ Pedido del ${ddmm(o.created_at)} — ${statusText}`;
    const conFecha = t?.fecha_entrega && (rawStatus === "programado" || rawStatus === "en preparacion" || rawStatus === "facturado");
    if (conFecha) {
      if (m.modo === "expreso") { line += `: el ${conDia(t.fecha_entrega)} lo entregamos en el expreso *${m.expreso}*`; hayExpreso = true; }
      else if (m.modo === "retira") line += `: lo podés retirar desde el ${conDia(t.fecha_entrega)}`;
      else line += `: sale el ${conDia(t.fecha_entrega)}`;
    } else if (!t?.fecha_entrega && m.modo === "expreso" && rawStatus !== "entregado") {
      line += ` (va por el expreso *${m.expreso}*)`;
    }
    if (t?.fecha_entrega && rawStatus === "entregado") {
      if (m.modo === "expreso") { line = `${i + 1}️⃣ Pedido del ${ddmm(o.created_at)} — ✅ entregado en el expreso *${m.expreso}* el ${conDia(t.fecha_entrega)}`; hayExpreso = true; }
      else line += ` el ${conDia(t.fecha_entrega)}`;
    }
    return line;
  });
  const notaExpreso = hayExpreso
    ? "\n\n🚛 Desde que lo entregamos en el expreso, los tiempos de viaje los maneja el expreso: para saber cuándo te llega, consultalo directamente con ellos."
    : "";
  return `${customer.business_name}, acá está el estado de tus pedidos:\n\n${lines.join("\n")}${notaExpreso}\n\n¿Necesitás más detalle de alguno?`;
}

// deno-lint-ignore no-explicit-any
async function lookupCustomerDiscount(customer: NonNullable<Customer>, faq?: any): Promise<string | null> {
  // OJO: la columna es `dto_vol`, no `discount` (que no existe en `customers`).
  // Con el nombre mal, el select devolvía error, `row` quedaba en null y el bot
  // le contestaba "Por volumen: 0%" a TODOS — 561 de los 1.273 clientes tienen
  // descuento no-cero. Y `dto_vol` es una FRACCIÓN (0.25 = 25%, es el mismo
  // valor que el carrito usa como `(1 - dto_vol)`), así que va × 100.
  const { data: row } = await supabase
    .from("customers").select("dto_vol").eq("id", customer.id).maybeSingle();
  const volumeDiscount = Math.round(Number(row?.dto_vol ?? 0) * 1000) / 10;
  // Descuentos por pago: SALEN DE LA TABLA del Panel (app_settings.wa_descuentos_config),
  // no hardcodeados. Así lo que el vendedor edita en "Descuentos por pago" es lo que el bot
  // le responde al cliente — la misma fuente que usan las plantillas de factura.
  const pagoBlock = await pagoDiscountBlock();
  // Pablo, 30/09: si ya tiene facturas abiertas, fechas reales ("pagando hasta el mié 14/10 tenés 25%").
  const facturasBlock = await descuentosFacturasBlock(customer);
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
    return renderTemplate(sinLineasSinDato(tpl, vars), vars);
  }
  const pago = pagoBlock ? `\n💰 *Por pago*, contando desde la fecha de la factura:\n${pagoBlock}` : "";
  const fac = facturasBlock ? `\n\n${facturasBlock}` : "";
  return `${customer.business_name}, tus descuentos son:\n📦 *Por volumen*: ${volumeDiscount}% (ya incluido en tus precios de la web)\n💻 *Por compra web*: 2% adicional${pago}${fac}\n\nLa factura sale con el total lleno: el descuento por pago se te reconoce cuando pagás, según los días que pasaron.`;
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
  const { data: cfgRow } = await supabase.from("app_settings").select("value").eq("key", "wa_descuentos_config").maybeSingle();
  // deno-lint-ignore no-explicit-any
  const cfg: any = JSON.parse(String(cfgRow?.value ?? "{}"));
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
  return { cfg, pesos, ddmm, lineasPago };
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
    const MAX = 3;
    const bloques: string[] = [];
    for (const gr of grupos.slice(0, MAX)) {
      const cab = `🧾 *${gr.n > 1 ? `Facturas del ${ddmm(gr.fecha)} (${gr.n})` : `Factura del ${ddmm(gr.fecha)}`}* — saldo ${pesos(gr.saldo)}`;
      bloques.push([cab, ...(await lineasPago(gr)).map((l) => "  " + l)].join("\n"));
    }
    const resto = grupos.slice(MAX);
    if (resto.length) {
      const n = resto.reduce((s, x) => s + x.n, 0), saldo = resto.reduce((s, x) => s + x.saldo, 0);
      bloques.push(`Y ${n} factura${n > 1 ? "s" : ""} anterior${n > 1 ? "es" : ""} por ${pesos(saldo)}.`);
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
async function lookupFacturaReenvio(customer: NonNullable<Customer>, message: string): Promise<FaqResult | null> {
  const derivar = (motivo: string, texto: string): FaqResult => ({
    reply: texto, intent: "factura_reenvio", automation_level: "semi_auto",
    alerta: { motivo, urgente: false, detalle: `Pidió la factura: "${message.slice(0, 150)}"` },
  });
  try {
    const isis = await getIsisClient();
    const { data: docs, error } = await isis.from("documentos")
      .select("numero, punto_venta, letra, fecha, total, storage_path")
      .eq("contraparte_codigo", String(customer.cod_cliente)).like("tipo", "FC%")
      .order("fecha", { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    const lista = (docs ?? []) as Array<{ numero: string; punto_venta: string; letra: string; fecha: string; total: number; storage_path: string | null }>;
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
      const { data: s } = await isis.storage.from("isis-lk").createSignedUrl(d.storage_path!, 3600);
      if (s?.signedUrl) documentos.push({ url: s.signedUrl, filename: `Factura ${d.letra ?? ""} ${d.punto_venta}-${d.numero}.pdf`.replace(/\s+/g, " ") });
    }
    const { pesos, ddmm, lineasPago, cfg } = await contextoDescuentos();
    if (!documentos.length) {
      return derivar("factura_sin_pdf", `Tu factura del ${ddmm(fecha)} todavía no tiene el PDF cargado. Ya le paso el pedido a una persona del equipo para que te la mande. 🙏`);
    }
    const total = elegidas.reduce((s, d) => s + Number(d.total || 0), 0);
    const lineas = [`Te mando ${documentos.length > 1 ? `las ${documentos.length} facturas` : "la factura"} del ${ddmm(fecha)} (total ${pesos(total)}). 📄`];
    // Descuento vigente hoy, con el saldo real de ese día (Deuda Viva).
    const grupos = await deudaAgrupada(customer.cod_cliente);
    const delDia = (grupos ?? []).filter((g) => g.fecha === fecha);
    if (grupos && !delDia.length) lineas.push("✅ Ya figura pagada.");
    for (const gr of delDia) lineas.push("", ...(await lineasPago(gr, true)));
    if (delDia.length) {
      const alias = cfg?.pago?.alias ?? PAGO_ALIAS_FALLBACK, cbu = cfg?.pago?.cbu ?? PAGO_CBU_FALLBACK;
      lineas.push("", `Datos para el pago:\nAlias: ${alias}\nCBU: ${cbu}`);
    }
    return { reply: lineas.join("\n"), intent: "factura_reenvio", automation_level: "semi_auto", documentos };
  } catch (e) {
    console.warn("lookupFacturaReenvio:", e instanceof Error ? e.message : e);
    return derivar("factura_error", "No pude buscar tu factura en este momento. Ya le paso el pedido a una persona del equipo para que te la mande. 🙏");
  }
}

// Bloque "Por pago" armado desde wa_descuentos_config (contado + crédito[] + e-cheq[]).
// Fuente única compartida con las plantillas de factura (lk_factura-check). Editable en el Panel.
async function pagoDiscountBlock(): Promise<string> {
  try {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "wa_descuentos_config").maybeSingle();
    // deno-lint-ignore no-explicit-any
    const cfg: any = JSON.parse(String(data?.value ?? "{}"));
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
