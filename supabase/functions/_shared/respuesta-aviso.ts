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

import { supabase } from "./supabase.ts";
import { notificarHumano } from "./alertas.ts";
import { SIM } from "./simulacion.ts";
import { sinAnulados } from "./pedidos-anulados.ts";

const VENTANA_HORAS = 48;
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

const RE_CAMBIO = /(cancel|anul|cambi(ar|á|a|en|ame|arme|arlo|alo|emos)\b|modific|agreg|sum[aá]|quit|sac[aá]|\bno\s+(voy|vamos|estoy|estamos|pue\w*|pod\w*|llego|llegamos)\b|reci[eé]n\s+(el|la|para|a\s+partir)|otro d[ií]a|reprogram|posterg|adelant|devol|reclam|falt[aó]|equivoc|error)/i;

// Pedido de cambio de fecha / cancelación AUNQUE lo último no haya sido un aviso (simulación 28/09:
// "No pueeo pasar el 30, puedo pasar recien el 4/10" caía en la FAQ de dirección del depósito).
// Fuerte = alcanza sola. "No puedo / no llego…" sólo cuenta si además habla de una fecha, un día o
// del retiro/entrega (para no derivar "no puedo abrir el catálogo").
const RE_CAMBIO_FUERTE = /(reprogram|posterg|cancel|anul|cambi\w*\s+(la\s+|el\s+)?(fecha|d[ií]a|entrega|retiro)|otro\s+d[ií]a|reci[eé]n\s+(el|la|para|a\s+partir))/i;
// Pablo, 29/09: "Agregá 60 sacacorchos al pedido web" (agregar/sacar algo de un pedido ya hecho) va directo a un asesor,
// sin preguntar antes qué modelo es: la persona lo confirma con el cliente. Chequeo humano primero.
const RE_EDITA_PEDIDO = /\b(agreg|sum[aá]|a[ñn]ad|sac[aá]|quit)\w*[^?.!]{0,60}\b(al|del|en el|a mi|de mi)\s+pedido/i;
// Pablo, 29/09: "¿Puedo retirarlo el sábado 3?" / "¿paso el jueves?" — pide un día de retiro. Los retiros son de lunes a
// viernes; si pide fin de semana se le explica y se le ofrece reprogramar; si pide un día hábil se deriva a un asesor
// para reprogramar el retiro (antes caía en la respuesta fija del depósito, #4, que no contestaba la pregunta).
const RE_RETIRO_DIA = /\b(retir|pas(o|ar|amos|ás|as)\b|busc)\w*[^?.!]{0,40}\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}\s*\/\s*\d{1,2})/i;
const HORARIO_RETIRO = "de lunes a viernes, de 9 a 12 y de 13 a 16:30 h";
function pideFinDeSemana(t: string): boolean {
  if (/s[aá]bado|domingo/i.test(t)) return true;
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
    supabase.rpc("bot_estado_pedidos_gv", { p_ids: [pedido] }),
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
export async function pedidoDeCambio(
  phone: string,
  text: string,
  customer: { customer_id: string; business_name: string } | null,
): Promise<string | null> {
  if (!customer) return null;
  const t = text.trim();
  const retiroDia = RE_RETIRO_DIA.test(t);
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
  const { data: est } = await supabase.rpc("bot_estado_pedidos_gv", { p_ids: ordsVivos.map((o) => o.id) });
  const abiertos = new Set((est ?? []).filter((e: { status: string }) => e.status !== "entregado")
    .map((e: { order_id: number }) => Number(e.order_id)));
  const ped = ordsVivos.find((o) => abiertos.has(Number(o.id)));
  if (!ped) return null;

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

  if (RE_CAMBIO.test(t)) {
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
