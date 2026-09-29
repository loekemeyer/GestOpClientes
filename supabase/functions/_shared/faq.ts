// Flujo cara-al-cliente 2026-09-04: no-cliente prioriza institucional; lookup payment_data
//   (alias/CBU desde wa_descuentos_config). Deploy vía CI al pushear a main.
// _shared/faq.ts — Pre-check de FAQs (respuestas AUTO/SEMIAUTO/HUMANO)
// que corre antes de tocar el LLM. Consume la tabla `wa_faq` vía la RPC
// `wa_faq_match` y elige entre `bot_response` (cliente identificado) e
// `institutional_response` (sin cliente, tono institucional).
//
// El agente conversacional (`runConversation`) queda como último recurso:
// solo se invoca si acá no hay match útil.

import { supabase } from "./supabase.ts";
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
function esSoloSaludo(text: string): boolean {
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
const RE_YA_PAGUE = /\b(ya (les |te )?(pagu[eé]|transfer[ií]|deposit[eé]|abon[eé]|cancel[eé])|(les |te )?(transfer[ií]|pagu[eé]|deposit[eé]) (ayer|hoy|el)|sigue figurando|me sigue (apareciendo|saliendo)|no (se )?(me )?(acredit|impact|figura (el|mi) pago))/i;
const RE_RETIRO = /\b(retir(o|ar|arlo|arla|amos|a)|pas(ar|o|amos) a buscar|buscarlo|ir a buscar|lo busco|voy a buscar)\b/i;

/** Pedido abierto más reciente del cliente que va por expreso (no anulado, no entregado). null si no hay. */
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
    return `${customer.business_name}, no tenés pedidos recientes (últimos 90 días). Si querés hacer uno, decime.`;
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
  // Plantilla editable desde el front: si trae {{descuento_volumen}} o {{descuentos_pago}}
  // se renderiza con los datos reales; si no, se usa el texto por defecto (también dinámico).
  const tpl = String(faq?.bot_response ?? "").trim();
  if (tpl.includes("{{descuento_volumen}}") || tpl.includes("{{descuentos_pago}}")) {
    return renderTemplate(tpl, {
      nombre_cliente: customer.business_name,
      descuento_volumen: volumeDiscount,
      descuentos_pago: pagoBlock,
    });
  }
  const pago = pagoBlock ? `\n💰 *Por pago*:\n${pagoBlock}` : "";
  return `${customer.business_name}, tus descuentos son:\n📦 *Por volumen*: ${volumeDiscount}%\n💻 *Por compra web*: 2% adicional${pago}\n\nEstos se aplican sobre el precio base de la web. 💡`;
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
