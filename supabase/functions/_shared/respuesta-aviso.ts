// respuesta-aviso — qué hace el bot cuando el cliente CONTESTA un aviso automático
// (pedido recibido, programado, en viaje, …). Pedido de Pablo Olejavetzky (28/09).
//
// Cómo sabe que es una respuesta a un aviso: lk_outbox-flush guarda cada aviso en el historial
// como "[Aviso automático <plantilla> · pedido <id>]\n<texto que leyó el cliente>". Si el ÚLTIMO
// mensaje del historial es un aviso de las últimas 48 h, lo que escribe el cliente es la respuesta.
//
// Ramas (deterministas, 0 tokens) — en este orden:
//   1. Quiere cambiar / cancelar / reclamar  → deriva a un asesor (wa_alertas_humano).
//   2. Pregunta cuándo llega                 → estado y fecha real del pedido (Gestión).
//   3. Agradece / confirma (mensaje corto)   → respuesta breve.
//   4. Cualquier otra cosa                   → null: sigue el flujo normal (FAQ / agente), que ya ve
//                                              el aviso en el historial con el texto real.

import { getSetting, supabase } from "./supabase.ts";
import { notificarHumano } from "./alertas.ts";
import { SIM } from "./simulacion.ts";
import { estadoPedidos, sinAnulados } from "./pedidos-anulados.ts";
import { franjaDeRetiro, retiroInformado, textoFranjaConfirmada, textoRetiroConfirmado } from "./fecha-retiro.ts";
import { claseNombrada, derivacionExcel, esRespuestaAExcel, PREGUNTA_EXCEL } from "./pasar-excel.ts";
import { compararMails, mailsEscritos, mailsRegistrados, PREGUNTA_MAIL_FACTURAS, TEXTO_MAIL_COINCIDE, TEXTO_MAIL_NO_COINCIDE, TEXTO_MAIL_SIN_REGISTRO } from "./mail-facturas.ts";

const VENTANA_HORAS = 48;
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// Pablo, 30/09: el verbo sacar/quitar conjugado, no la raíz suelta. "sac" / "quit" sueltos agarraban artículos
// ("Agregá 60 sacacorchos al pedido" iba a un asesor como si pidiera SACAR; igual sacapuntas, quitamanchas).
// Cierra con "no sigue una letra" y no con \b: en JS la "á" no es \w, así que "sacá " no tiene \b después.
const SACAR = String.raw`\b(?:(?:sac|quit)[aá](?:r(?:me|le|les|lo|la|los|las)?|n|s|mos|nos|ndo|me|le|les|lo|la|los|las)?|(?:saqu|quit)[eé][a-z]*)(?![a-zñáéíóúü])`;
const RE_SACAR = new RegExp(SACAR, "i");

const RE_CAMBIO = new RegExp(String.raw`(cancel|anul|cambi(ar|á|a|en|ame|arme|arlo|alo|emos)\b|modific|${SACAR}|\bno\s+(voy|vamos|estoy|estamos|pue\w*|pod\w*|llego|llegamos)\b|reci[eé]n\s+(el|la|para|a\s+partir)|otro d[ií]a|reprogram|posterg|adelant|devol|reclam|falt[aó]|equivoc|error)`, "i");

// Pedido de cambio de fecha / cancelación AUNQUE lo último no haya sido un aviso (simulación 28/09:
// "No pueeo pasar el 30, puedo pasar recien el 4/10" caía en la FAQ de dirección del depósito).
// Fuerte = alcanza sola. "No puedo / no llego…" sólo cuenta si además habla de una fecha, un día o
// del retiro/entrega (para no derivar "no puedo abrir el catálogo").
// Agregar (sin sacar) lo resuelve la IA con solicitar_agregado_pedido, aunque diga "modificar" (Pablo, 29/09).
const RE_AGREGA = /\b(agreg|sum[aá]|a[ñn]ad)\w*/i;
const RE_CAMBIO_FUERTE = /(reprogram|posterg|cancel|anul|cambi\w*\s+(la\s+|el\s+)?(fecha|d[ií]a|entrega|retiro)|otro\s+d[ií]a|reci[eé]n\s+(el|la|para|a\s+partir))/i;
// Pablo, 29/09: SACAR algo de un pedido ya hecho va directo a un asesor. AGREGAR ya no: lo toma la IA, que confirma
// modelo y cajas y deja la tarea con botón "Aplicar" (solicitar_agregado_pedido, sql/099).
const RE_EDITA_PEDIDO = new RegExp(String.raw`${SACAR}[^?.!]{0,60}\b(al|del|en el|a mi|de mi)\s+pedido`, "i");
// Pablo, 29/09: "¿Puedo retirarlo el sábado 3?" / "¿paso el jueves?" — pide un día de retiro. Los retiros son de lunes a
// viernes; si pide fin de semana se le explica y se le ofrece reprogramar; si pide un día hábil se deriva a un asesor
// para reprogramar el retiro (antes caía en la respuesta fija del depósito, #4, que no contestaba la pregunta).
// Pablo, 30/09: también "hoy" / "mañana" y el día ANTES del verbo ("¿Mañana puedo pasar a retirar?", "El jueves paso
// a buscarlo"); antes eso caía en la IA, que contestaba "depende de la logística interna". Para esos casos nuevos el
// verbo tiene que ser de retiro de verdad (retirar, buscar, pasar a retirar/buscar, pasar por el depósito): "Mañana te
// paso el comprobante" no es un retiro. "A la mañana" / "por la mañana" es la hora, no el día.
const DIA_RETIRO = String.raw`(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}\s*\/\s*\d{1,2}|hoy|(?<!la\s)ma[nñ]ana)`;
const VERBO_RETIRO_FUERTE = String.raw`(retir\w*|busc\w*|pas(o|ar|amos|ás|as)\s+(a\s+(retir|busc)\w*|por\s+(el\s+)?dep[oó]sito))`;
const RE_RETIRO_DIA = new RegExp(
  String.raw`\b(retir|pas(o|ar|amos|ás|as)\b|busc)\w*[^?.!]{0,40}\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}\s*\/\s*\d{1,2})` +
  String.raw`|\b${VERBO_RETIRO_FUERTE}[^?.!]{0,40}\b${DIA_RETIRO}|\b${DIA_RETIRO}\b[^?.!]{0,40}\b${VERBO_RETIRO_FUERTE}`, "i");
const HORARIO_RETIRO = "de lunes a viernes, de 9 a 12 y de 13 a 16:30 h";
const DIAS_ASCII = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
// Fecha (YYYY-MM-DD, hora AR) que pide el cliente: "el jueves" = el próximo jueves desde hoy; "el 3/10" = esa fecha.
function fechaPedida(t: string): string | null {
  const hoyAR = new Date(Date.now() - 3 * 3600_000);
  const base = Date.UTC(hoyAR.getUTCFullYear(), hoyAR.getUTCMonth(), hoyAR.getUTCDate(), 12);
  const m = t.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
  if (m) {
    let d = Date.UTC(hoyAR.getUTCFullYear(), Number(m[2]) - 1, Number(m[1]), 12);
    if (d < base - 60 * 86400_000) d = Date.UTC(hoyAR.getUTCFullYear() + 1, Number(m[2]) - 1, Number(m[1]), 12);
    return new Date(d).toISOString().slice(0, 10);
  }
  const txt = t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const i = DIAS_ASCII.findIndex((d) => new RegExp(`\\b${d}\\b`).test(txt));
  if (i < 0) {
    // Sin día de semana ni fecha: "pasado mañana", "hoy", "mañana" (no "a la mañana", que es la hora). Pablo, 30/09.
    const rel = /\bpasado\s+manana\b/.test(txt) ? 2 : /\bhoy\b/.test(txt) ? 0 : /(?<!la\s)\bmanana\b/.test(txt) ? 1 : -1;
    return rel < 0 ? null : new Date(base + rel * 86400_000).toISOString().slice(0, 10);
  }
  const dif = (i - new Date(base).getUTCDay() + 7) % 7;
  return new Date(base + dif * 86400_000).toISOString().slice(0, 10);
}
function pideFinDeSemana(t: string): boolean {
  if (/s[aá]bado|domingo/i.test(t)) return true;
  // "hoy" / "mañana" un viernes o un sábado caen en fin de semana.
  if (/\b(hoy|ma[nñ]ana)\b/i.test(t) && !/\b\d{1,2}\s*\/\s*\d{1,2}\b/.test(t)) {
    const f = fechaPedida(t);
    if (f) { const dia = new Date(`${f}T12:00:00Z`).getUTCDay(); return dia === 0 || dia === 6; }
  }
  const m = t.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
  if (!m) return false;
  const hoy = new Date();
  let d = new Date(Date.UTC(hoy.getUTCFullYear(), Number(m[2]) - 1, Number(m[1]), 15));
  if (d.getTime() < hoy.getTime() - 60 * 86400_000) d = new Date(Date.UTC(hoy.getUTCFullYear() + 1, Number(m[2]) - 1, Number(m[1]), 15));
  const dia = d.getUTCDay();
  return dia === 0 || dia === 6;
}
const RE_NO_PUEDO = /\bno\s+(pue\w*|pod\w*|voy|vamos|llego|llegamos|estoy|estamos)\b/i;
const RE_FECHA_O_RETIRO = /(\b\d{1,2}\s*\/\s*\d{1,2}\b|\bel\s+\d{1,2}\b|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[nñ]ana|semana|fecha|\bd[ií]a\b|retir|pasar|buscar|entreg|recib)/i;
const RE_CUANDO = /(cu[aá]ndo|a qu[eé] hora|horario|qu[eé] d[ií]a|lleg|entreg|sale|salida|d[oó]nde est|en qu[eé] (va|est))/i;
// Agradece / confirma: el mensaje está hecho SÓLO de estas palabras (y emojis/puntuación).
const PALABRAS_OK = new Set(["hola", "buenas", "buen", "buenos", "dia", "día", "dias", "días", "tardes", "gracias", "muchas",
  "mil", "genial", "buenisimo", "buenísimo", "barbaro", "bárbaro", "perfecto", "excelente", "ok", "okey", "oka", "okk",
  "dale", "listo", "joya", "bien", "re", "super", "súper", "de", "nada", "igualmente", "saludos", "abrazo", "espectacular"]);
function esAgradecimiento(t: string): boolean {
  const palabras = t.toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const hayEmojiOk = /[👍🙏👌🙌😊☺💪❤]/u.test(t);
  return (palabras.length > 0 || hayEmojiOk) && palabras.every((w) => PALABRAS_OK.has(w));
}

export interface AvisoReciente {
  plantilla: string;
  pedido: number | null;
  texto: string;
}

/** El aviso al que el cliente estaría respondiendo, o null. */
export async function avisoReciente(phone: string): Promise<AvisoReciente | null> {
  const { data } = SIM.activo
    ? { data: SIM.historial.slice(-1) }
    : await supabase.from("bot_historial_chat")
      .select("rol, contenido, creado_en")
      .eq("telefono", phone)
      .order("creado_en", { ascending: false })
      .limit(1);
  const ult = data?.[0];
  if (!ult || ult.rol !== "assistant") return null;
  const m = /^\[Aviso automático (\S+)(?: · pedido (\d+))?\]\n?([\s\S]*)$/.exec(String(ult.contenido ?? ""));
  if (!m) return null;
  if (Date.now() - new Date(ult.creado_en).getTime() > VENTANA_HORAS * 3600_000) return null;
  return { plantilla: m[1], pedido: m[2] ? Number(m[2]) : null, texto: m[3] ?? "" };
}

// Último mensaje del historial si lo escribió el bot ("" si no): para saber si el cliente insiste con lo mismo.
const MARCA_RETIRO_INFORMADO = "Si necesitás que sea otro día, decime cuál y se lo paso a un asesor.";
async function ultimoMensajeBot(phone: string): Promise<string> {
  const { data } = SIM.activo
    ? { data: SIM.historial.slice(-1) }
    : await supabase.from("bot_historial_chat").select("rol, contenido").eq("telefono", phone)
      .order("creado_en", { ascending: false }).limit(1);
  const ult = data?.[0];
  return ult && ult.rol === "assistant" ? String(ult.contenido ?? "") : "";
}

const fechaCorta = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(new Date(iso).toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const conDia = (ymd?: string | null) => {
  if (!ymd) return "";
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00Z`);
  return `${DIAS[d.getUTCDay()]} ${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
};

async function estadoPedido(pedido: number): Promise<string> {
  const [{ data: ord }, { data: est }] = await Promise.all([
    supabase.from("orders").select("created_at").eq("id", pedido).maybeSingle(),
    estadoPedidos([pedido]),
  ]);
  const del = ord?.created_at ? ` del ${fechaCorta(ord.created_at)}` : "";
  const e = est?.[0];
  const status = String(e?.status ?? "");
  const fecha = e?.fecha_entrega ? conDia(String(e.fecha_entrega)) : "";
  if (status === "entregado") {
    return `Tu pedido${del} figura como entregado${fecha ? ` el ${fecha}` : ""}. Si no lo recibiste, avisanos por acá y lo revisamos.`;
  }
  if (!fecha || status === "recibido" || !status) {
    return `Tu pedido${del} está recibido y todavía no tiene fecha de entrega. Te avisamos por acá apenas la tenga.`;
  }
  const etapa = status === "en preparacion" ? "en preparación" : status;
  return `Tu pedido${del} está ${etapa} y sale el ${fecha}. Cualquier cambio te avisamos por acá.`;
}

/**
 * Cliente con un pedido abierto que pide cambiar la fecha o cancelar, en cualquier momento de la
 * charla → deriva a un asesor (alerta respuesta_aviso_cambio → tarea en Planify). null si no aplica.
 */
// Pablo, 30/09 (2.9): "una anulación no es un cambio, tenemos que ver el estado del pedido antes de hacerlo". Se le dice en
// qué estado está y la alerta sale como anulación (motivo anulacion_pedido, urgente), con el estado para quien la toma.
const RE_ANULA = /\b(anul\w*|cancel\w*|dar\s+de\s+baja|no\s+lo\s+(quiero|necesito)\s+m[aá]s)/i;
async function anularPedido(
  phone: string, t: string, customer: { customer_id: string; business_name: string },
  ped: { id: number | string; created_at: string }, e: { status?: string; fecha_entrega?: string | null } | undefined,
): Promise<string> {
  const del = fechaCorta(ped.created_at);
  const st = String(e?.status ?? "recibido");
  const sale = e?.fecha_entrega ? ` (sale el ${conDia(String(e.fecha_entrega).slice(0, 10))})` : "";
  const estado = st === "facturado" ? "ya está facturado y listo para salir"
    : st === "programado" || st === "en preparacion" ? `ya está programado${sale}`
    : "todavía no entró en preparación";
  await notificarHumano({
    tipo: "escalation", phone, customerId: customer.customer_id,
    contexto: { motivo: "anulacion_pedido", pedido: ped.id, texto_recibido: t.slice(0, 300), estado_pedido: st,
      detalle: `Anulación del pedido del ${del} (${st})`, razon_social: customer.business_name },
  });
  return st === "recibido" || st === "pendiente"
    ? `Tu pedido del ${del} ${estado}. Le paso la anulación a una persona del equipo, que te la confirma por acá. 🙏`
    : `Tu pedido del ${del} ${estado}. Le paso la anulación a una persona del equipo para que revise si todavía se puede frenar, y te confirma por acá. 🙏`;
}

export async function pedidoDeCambio(
  phone: string,
  text: string,
  customer: { customer_id: string; business_name: string } | null,
): Promise<string | null> {
  if (!customer) return null;
  const t = text.trim();
  // Pablo, 07/10 (m36, m37): el cliente contesta "¿Pasás por la mañana o por la tarde?" → se confirma y Ventas recibe la franja (segundo aviso, completa el primero).
  // Primero la prueba barata (el mensaje dice una franja); recién ahí se mira el último mensaje del bot. "No puedo…" / un cambio de fecha siguen su camino.
  const franja = franjaDeRetiro(t);
  if (franja && !RE_CAMBIO_FUERTE.test(t) && !RE_NO_PUEDO.test(t)) {
    const info = retiroInformado(await ultimoMensajeBot(phone));
    if (info) {
      await notificarHumano({
        tipo: "escalation", phone, customerId: customer.customer_id,
        contexto: { motivo: "entrega", urgente: false, texto_recibido: t.slice(0, 300), razon_social: customer.business_name,
          detalle: `Retira el pedido del ${info.del} el ${info.dia}, por la ${franja} (completa el aviso anterior)` },
      });
      return textoFranjaConfirmada(info.dia, franja);
    }
  }
  // Pablo, 07/10 (m68): el cliente contesta "¿A qué mail te llegaron las facturas?" con un mail → se compara con el de su ficha (customers.mail). Si coincide, se lo confirma; si no coincide o
  // la ficha no tiene mail, se lo pasa a Ventas (alerta nota_cliente, no urgente). Nunca se le muestra el mail registrado. Primero la prueba barata (el mensaje trae un mail).
  const dichos = t.length <= 300 ? mailsEscritos(t) : [];
  if (dichos.length && (await ultimoMensajeBot(phone)).includes(PREGUNTA_MAIL_FACTURAS)) {
    let registrados: string[] = [];
    try {
      const { data: ficha } = await supabase.from("customers").select("mail").eq("id", customer.customer_id).maybeSingle();
      registrados = mailsRegistrados(ficha?.mail as string | null | undefined);
    } catch (e) { console.error("[mail-facturas] no pude leer el mail de la ficha:", e); }
    const r = compararMails(dichos, registrados);
    if (r.tipo === "coincide") return TEXTO_MAIL_COINCIDE;
    await notificarHumano({
      tipo: "otro", phone, customerId: customer.customer_id,
      contexto: { motivo: "nota_cliente", urgente: false, texto_recibido: t.slice(0, 300), razon_social: customer.business_name,
        detalle: `Dice que las facturas le llegan a ${dichos.join(", ")}: ${r.tipo === "no_coincide" ? "no coincide con el mail de la ficha" : "la ficha no tiene mail (o no se pudo leer)"}` },
    });
    return r.tipo === "no_coincide" ? TEXTO_MAIL_NO_COINCIDE : TEXTO_MAIL_SIN_REGISTRO;
  }
  // Pablo, 07/10 (m42): el cliente contesta "¿Qué querés pasar a Excel…?" → se deriva según lo que nombra: lista de precios y pedidos a Ventas (nota_cliente), facturas a Cobranzas (pago), otra cosa a
  // Ventas. Sólo un mensaje corto y sin signo de pregunta (una pregunta nueva sigue su camino); la prueba barata va primero.
  if (esRespuestaAExcel(t) && (await ultimoMensajeBot(phone)).includes(PREGUNTA_EXCEL)) {
    const d = derivacionExcel(claseNombrada(t) ?? "otra", t);
    await notificarHumano({
      tipo: "otro", phone, customerId: customer.customer_id,
      contexto: { motivo: d.motivo, urgente: false, texto_recibido: t.slice(0, 300), razon_social: customer.business_name, detalle: d.detalle },
    });
    return d.reply;
  }
  // La fecha del PROPIO pedido ("el pedido del 30/09 me lo entregan o lo paso a buscar?") no es un día de retiro: se saca
  // antes de buscar el día pedido (Pablo, 01/10; antes eso se derivaba a un asesor "para reprogramar el retiro").
  const tDia = t.replace(/\b(pedidos?|ordenes|orden|compras?|facturas?)\s+(?:del?|de\s+la(?:\s+fecha)?|(?:con|de)\s+fecha)\s+(?:el\s+)?(?:d[ií]a\s+)?\d{1,2}\s*\/\s*\d{1,2}(?:\s*\/\s*\d{2,4})?/gi, "$1");
  const retiroDia = RE_RETIRO_DIA.test(tDia);
  if (retiroDia && pideFinDeSemana(t)) {
    return `Los retiros son ${HORARIO_RETIRO}; los fines de semana el depósito está cerrado. Podemos reprogramar tu retiro para otro día hábil: ¿qué día te queda bien?`;
  }
  if (!(retiroDia || RE_CAMBIO_FUERTE.test(t) || RE_EDITA_PEDIDO.test(t) || (RE_NO_PUEDO.test(t) && RE_FECHA_O_RETIRO.test(t)))) return null;

  // Pedido abierto más reciente del cliente (últimos 60 días, no entregado según Gestión).
  const { data: ords } = await supabase.from("orders").select("id, created_at")
    .eq("customer_id", customer.customer_id)
    .gt("created_at", new Date(Date.now() - 60 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(10);
  const ordsVivos = await sinAnulados(ords ?? []);   // anulados/borrados en Gestión no cuentan
  if (!ordsVivos.length) return null;
  const { data: est } = await estadoPedidos(ordsVivos.map((o) => o.id));
  const abiertos = new Set((est ?? []).filter((e: { status: string }) => e.status !== "entregado")
    .map((e: { order_id: number }) => Number(e.order_id)));
  if (RE_ANULA.test(t) && !retiroDia) {
    const vivos = ordsVivos.filter((o) => abiertos.has(Number(o.id)));
    if (!vivos.length) return null;
    const estDe = (o: { id: number | string }) =>
      (est ?? []).find((x: { order_id: number }) => Number(x.order_id) === Number(o.id)) as { status?: string; fecha_entrega?: string | null } | undefined;
    // "anulá el pedido del 30/09": ése. Si no dice cuál y tiene más de uno abierto, se le pregunta (no se asume el último).
    const fechaDicha = t.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
    const elegido = fechaDicha
      ? vivos.find((o) => fechaCorta(o.created_at) === `${fechaDicha[1].padStart(2, "0")}/${fechaDicha[2].padStart(2, "0")}`)
      : vivos.length === 1 ? vivos[0] : undefined;
    if (elegido) return await anularPedido(phone, t, customer, elegido, estDe(elegido));
    const lista = vivos.slice(0, 5).map((o, i) => {
      const e = estDe(o);
      const st = String(e?.status ?? "recibido");
      const txt = st === "facturado" ? "facturado, listo para salir" : st === "programado" || st === "en preparacion"
        ? `programado${e?.fecha_entrega ? `, sale el ${conDia(String(e.fecha_entrega).slice(0, 10))}` : ""}` : "recibido, todavía sin fecha de salida";
      return `${i + 1}️⃣ Pedido del ${fechaCorta(o.created_at)} — ${txt}`;
    });
    return `¿Cuál de tus pedidos querés anular?\n\n${lista.join("\n")}\n\nConfirmame de qué fecha es y lo reviso.`;
  }
  let ped = ordsVivos.find((o) => abiertos.has(Number(o.id)));
  if (!ped) return null;
  // Pablo, 30/09 (3.1): "el jueves lo retiro" con dos pedidos abiertos tomaba el más nuevo (listo recién el 05/10) y lo
  // derivaba, aunque el del 25/09 ya está listo. Se prefiere el pedido de retiro que ya esté listo para el día pedido.
  if (retiroDia) {
    const pedida0 = fechaPedida(tDia);
    const abiertosIds = ordsVivos.filter((o) => abiertos.has(Number(o.id))).map((o) => o.id);
    const { data: vs } = await supabase.from("v_pedidos_web").select("order_id, zona_expreso").in("order_id", abiertosIds).eq("linea_rn", 1);
    const esRet = new Set((vs ?? []).filter((v: { zona_expreso: string | null }) => /^retira/i.test(String(v.zona_expreso ?? "")))
      .map((v: { order_id: number }) => Number(v.order_id)));
    const listo = ordsVivos.find((o) => {
      if (!abiertos.has(Number(o.id)) || !esRet.has(Number(o.id))) return false;
      const e = (est ?? []).find((x: { order_id: number }) => Number(x.order_id) === Number(o.id)) as { fecha_entrega?: string | null } | undefined;
      return !!pedida0 && !!e?.fecha_entrega && String(e.fecha_entrega).slice(0, 10) <= pedida0;
    });
    if (listo) ped = listo;
  }

  // Pablo, 29/09: si pide retirar un día hábil igual o posterior al día desde el que el pedido está listo para retirar,
  // se le confirma directo (no hace falta una persona). Si pide antes, o el pedido no es de retiro o no tiene fecha, deriva.
  if (retiroDia) {
    const e = (est ?? []).find((x: { order_id: number }) => Number(x.order_id) === Number(ped.id)) as
      { fecha_entrega?: string | null } | undefined;
    const pedida = fechaPedida(tDia);
    const { data: v } = await supabase.from("v_pedidos_web").select("zona_expreso, nombre_expreso")
      .eq("order_id", ped.id).eq("linea_rn", 1).limit(1).maybeSingle();
    const esRetiro = /^retira/i.test(String(v?.zona_expreso ?? ""));
    const expreso = String(v?.nombre_expreso ?? "").trim();
    // Pedido por expreso: no se le ofrece retiro (Pablo, 28/09), se le dice por qué expreso sale.
    if (!esRetiro && expreso) {
      return `Tu pedido del ${fechaCorta(ped.created_at)} sale por el expreso ${expreso}, así que no se retira en nuestro depósito. Los tiempos de viaje los maneja el expreso: para saber cuándo te llega, consultalo con ellos.`;
    }
    const lista = e?.fecha_entrega ? String(e.fecha_entrega).slice(0, 10) : null;
    // "Hoy" pasadas las 16:30 (hora AR) ya no se puede confirmar: va a un asesor.
    const ahoraAR = new Date(Date.now() - 3 * 3600_000);
    const hoyCerrado = pedida === ahoraAR.toISOString().slice(0, 10) && ahoraAR.getUTCHours() * 60 + ahoraAR.getUTCMinutes() >= 16 * 60 + 30;
    if (esRetiro && pedida && lista && pedida >= lista && !hoyCerrado) {
      // Pablo, 07/10 (m36, m37): además pregunta si pasa por la mañana o por la tarde y deja un aviso a Ventas para que lo tengan a mano (motivo entrega, no urgente).
      // Hoy pasado el mediodía ya no se pregunta: sólo queda la tarde.
      const hoyPasadoMediodia = pedida === ahoraAR.toISOString().slice(0, 10) && ahoraAR.getUTCHours() >= 12;
      await notificarHumano({
        tipo: "escalation", phone, customerId: customer.customer_id,
        contexto: { motivo: "entrega", urgente: false, pedido: ped.id, texto_recibido: t.slice(0, 300), razon_social: customer.business_name,
          detalle: `Va a retirar el pedido del ${fechaCorta(ped.created_at)} el ${conDia(pedida)}${hoyPasadoMediodia ? " por la tarde" : " (franja sin confirmar)"}` },
      });
      return textoRetiroConfirmado(fechaCorta(ped.created_at), conDia(pedida), !hoyPasadoMediodia);
    }
    // Pablo, 01/10: pide un día ANTERIOR al que el pedido está listo: se le contesta con la fecha real (antes iba directo a un
    // asesor "para reprogramar", aunque sólo preguntaba). Si insiste (el último mensaje del bot ya fue éste), recién ahí deriva.
    const hoyYmd = ahoraAR.toISOString().slice(0, 10);
    if (esRetiro && pedida && lista && pedida < lista && pedida >= hoyYmd && !(await ultimoMensajeBot(phone)).includes(MARCA_RETIRO_INFORMADO)) {
      return `Tu pedido del ${fechaCorta(ped.created_at)} está programado: lo podés retirar desde el ${conDia(lista)}, de 9 a 12 o de 13 a 16:30 h, en Virgilio 2788. ${MARCA_RETIRO_INFORMADO}`;
    }
  }

  await notificarHumano({
    tipo: "escalation", phone, customerId: customer.customer_id,
    contexto: { motivo: "respuesta_aviso_cambio", pedido: ped.id, texto_recibido: t.slice(0, 300),
      razon_social: customer.business_name },
  });
  if (retiroDia) {
    return `Le paso a un asesor el retiro de tu pedido del ${fechaCorta(ped.created_at)} para reprogramarlo y te confirma por acá. 🙏 Recordá que los retiros son ${HORARIO_RETIRO}.`;
  }
  return `Le paso tu pedido del ${fechaCorta(ped.created_at)} a un asesor para que coordine el cambio y te escriba por acá. 🙏`;
}

// ── Respuesta al recordatorio de descuento (pedido_recordatorio_descuento) — Pablo, 30/09 ──
// Sin IA. Los datos salen del texto que leyó el cliente (guardado en el historial por lk_outbox-flush):
// "…compra facturada el 28/09: si la pagás hasta el martes 13/10 tenés *25% de descuento* y abonás *$896.668* en vez de
// $1.195.557…". Ramas, en este orden:
//   1. Reclama ("hay un error", "no es así", "no debo")  → alerta a una persona con motivo reclamo_saldo.
//   2. Ya pagó / manda el comprobante                     → gracias + "mandá el comprobante por acá" (sin tarea).
//   3. Posterga ("no puedo", "pago el lunes", "el 20/10") → con qué descuento quedaría ese día (mismos escalones).
//   4. Gracias / ok                                       → respuesta corta que habla de la factura, no del pedido.
//   5. Otra cosa                                          → null: flujo normal.
const RE_RECLAMO_SALDO = /(error|equivoc|no\s+es\s+as[ií]|no\s+corresponde|no\s+coincide|incorrect|no\s+(te\s+)?debo|no\s+deb[eo]mos|mal\s+(el|la|calculad)|reclam|ya\s+(la\s+|lo\s+)?hab[ií]a\s+pagad)/i;
const RE_YA_PAGUE = /(\bya\s+(te\s+|les\s+)?(pagu|pagam|transfer|deposit|abon|mand|envi)\w*|\b(pagu[eé]|pagamos|transfer[ií]|transferimos|deposit[eé]|abon[eé])\b|comprobante|\bya\s+(est[aá]|qued[oó])\s+pag)/i;
const RE_POSTERGA = /(\bno\s+(pue\w*|pod\w*|llego|llegamos|voy|vamos|tengo)\b|m[aá]s\s+adelante|despu[eé]s|semana\s+que\s+viene|pr[oó]xima\s+semana|fin\s+de\s+mes|\bpag(o|amos|ar[eé]|ar[ií]a)\b|\b(lunes|martes|mi[eé]rcoles|jueves|viernes)\b|\b\d{1,2}\s*\/\s*\d{1,2}\b)/i;
const pesosAR = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");

async function responderRecordatorio(
  phone: string, t: string, customer: { customer_id: string; business_name: string }, aviso: AvisoReciente,
): Promise<string | null> {
  const fac = /facturada el (\d{2})\/(\d{2})/.exec(aviso.texto);
  const saldoTxt = /en vez de \$([\d.]+)/.exec(aviso.texto);
  const saldo = saldoTxt ? Number(saldoTxt[1].replace(/\./g, "")) : 0;
  const delFac = fac ? ` del ${fac[1]}/${fac[2]}` : "";

  if (RE_RECLAMO_SALDO.test(t)) {
    await notificarHumano({
      tipo: "otro", phone, customerId: customer.customer_id,
      contexto: { motivo: "reclamo_saldo", plantilla: aviso.plantilla, texto_recibido: t.slice(0, 300),
        razon_social: customer.business_name, detalle: `Respondió al recordatorio de descuento de la factura${delFac}` },
    });
    return `Gracias por avisar. Le paso tu consulta sobre la factura${delFac} a una persona del equipo para que lo revise y te escriba por acá. 🙏`;
  }

  if (RE_YA_PAGUE.test(t)) {
    return "¡Gracias! Si tenés el comprobante, mandalo por acá así lo registramos. 🙏";
  }

  if (RE_POSTERGA.test(t) && fac && saldo > 0) {
    // Fecha de la factura (año: el actual, o el anterior si daría en el futuro).
    const hoyAR = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    let fechaFac = `${hoyAR.slice(0, 4)}-${fac[2]}-${fac[1]}`;
    if (fechaFac > hoyAR) fechaFac = `${Number(hoyAR.slice(0, 4)) - 1}-${fac[2]}-${fac[1]}`;
    // Escalones del Panel (wa_descuentos_config), igual que la factura y la FAQ de descuentos.
    // deno-lint-ignore no-explicit-any
    let cfg: any = {};
    try { cfg = JSON.parse((await getSetting("wa_descuentos_config")) ?? "{}"); } catch { /* sin config: sin escalones */ }
    const ultimoNum = (s: unknown) => Math.max(0, ...(String(s ?? "").match(/\d+/g) ?? []).map(Number));
    const esc: Array<{ dias: number; dto: number }> = [];
    if (cfg?.contado) esc.push({ dias: Number(cfg.contado.dias_limite) || 14, dto: Number(cfg.contado.dto) || 0 });
    for (const r of (cfg?.credito ?? [])) if (ultimoNum(r?.label)) esc.push({ dias: ultimoNum(r.label), dto: Number(r.dto) || 0 });
    esc.sort((a, b) => a.dias - b.dias);
    // Un escalón no depende del otro: los hábiles se piden todos juntos (antes, uno por uno).
    const tramos: Array<{ hasta: string; dto: number }> = await Promise.all(esc.map(async (e) => {
      const d = new Date(fechaFac + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + e.dias);
      const iso = d.toISOString().slice(0, 10);
      const { data } = await supabase.rpc("wa_proximo_habil", { p: iso });
      return { hasta: typeof data === "string" ? data.slice(0, 10) : iso, dto: e.dto };
    }));
    const pedida = fechaPedida(t);
    if (pedida && pedida >= hoyAR) {
      const tramo = tramos.find((x) => x.hasta >= pedida);
      if (!tramo || tramo.dto <= 0) {
        return `Si pagás el ${conDia(pedida)} ya no tendría descuento por pago: el total es ${pesosAR(saldo)}.`;
      }
      return `Si pagás el ${conDia(pedida)} tenés *${Math.round(tramo.dto * 100)}% de descuento*: abonás *${pesosAR(saldo * (1 - tramo.dto))}* (vale hasta el ${conDia(tramo.hasta)}).`;
    }
    // Sin fecha: las fechas que le quedan.
    const quedan = tramos.filter((x) => x.hasta >= hoyAR && x.dto > 0);
    if (!quedan.length) return `El plazo de descuento de la factura${delFac} ya venció: el total es ${pesosAR(saldo)}.`;
    return `Sin problema. Estas son las fechas que te quedan para la factura${delFac}:\n` +
      quedan.map((x) => `• Pagando hasta el ${conDia(x.hasta)}: ${Math.round(x.dto * 100)}% → abonás ${pesosAR(saldo * (1 - x.dto))}`).join("\n");
  }

  if (t.length <= 60 && esAgradecimiento(t)) {
    return `¡Gracias a vos! Cualquier consulta sobre tu factura${delFac}, escribinos por acá.`;
  }
  return null;
}

/**
 * Si `text` es una respuesta a un aviso reciente y cae en una rama determinista, devuelve el
 * texto a contestar (y ya dejó la alerta si corresponde). Si no, null → flujo normal.
 */
export async function responderAviso(
  phone: string,
  text: string,
  customer: { customer_id: string; business_name: string } | null,
): Promise<string | null> {
  if (!customer) return null;
  const aviso = await avisoReciente(phone);
  if (!aviso) return null;
  const t = text.trim();

  // El recordatorio de descuento habla de un PAGO, no de un pedido: tiene sus propias ramas (y si ninguna aplica, sigue
  // el flujo normal sin pasar por las de pedido: "no puedo" o "error" no son un cambio de pedido acá).
  if (aviso.plantilla.startsWith("pedido_recordatorio_descuento")) return await responderRecordatorio(phone, t, customer, aviso);

  if (RE_ANULA.test(t) && aviso.pedido) {
    const [{ data: ord }, { data: est }] = await Promise.all([
      supabase.from("orders").select("id, created_at").eq("id", aviso.pedido).maybeSingle(),
      estadoPedidos([aviso.pedido]),
    ]);
    if (ord) return await anularPedido(phone, t, customer, ord, est?.[0]);
  }
  if (RE_CAMBIO.test(t) && !(RE_AGREGA.test(t) && !(RE_SACAR.test(t) || /\b(cancel|anul)/i.test(t)))) {
    await notificarHumano({
      tipo: "escalation",
      phone,
      customerId: customer.customer_id,
      contexto: {
        motivo: "respuesta_aviso_cambio",
        plantilla: aviso.plantilla,
        pedido: aviso.pedido,
        texto_recibido: t.slice(0, 300),
        razon_social: customer.business_name,
      },
    });
    return "Le paso tu pedido a un asesor para que lo vea y te escriba por acá. 🙏";
  }

  if (RE_CUANDO.test(t) && aviso.pedido) {
    return await estadoPedido(aviso.pedido);
  }

  if (t.length <= 60 && esAgradecimiento(t)) {
    let del = "";
    if (aviso.pedido) {
      const { data: ord } = await supabase.from("orders").select("created_at").eq("id", aviso.pedido).maybeSingle();
      if (ord?.created_at) del = ` del ${fechaCorta(ord.created_at)}`;
    }
    return `¡Gracias a vos! Cualquier consulta sobre tu pedido${del}, escribinos por acá.`;
  }

  return null;
}
