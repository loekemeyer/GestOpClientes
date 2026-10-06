// Alta de cliente nuevo por WhatsApp (toma de datos paso a paso) y registro por CUIT. Movido desde lk_whatsapp-webhook
// (29/09) para que el Simulador pueda correr el alta con un número nuevo (lk_bot-simular, modo "número nuevo").
// El webhook y el simulador usan exactamente este mismo código.
import { supabase } from "./supabase.ts";
import { SIM } from "./simulacion.ts";
import { extractCuit, formatoCuit, validaCuit } from "./cuit.ts";
import { type ConstanciaDatos, textoConfirmaConstancia, textoDomicilio } from "./constancia.ts";

// Siguen saliendo de acá para el resto del código (se mudaron a cuit.ts para que constancia.ts los use sin un import circular).
export { extractCuit, validaCuit };

export interface RegisterResult {
  request_id: number;
  status: string;
  business_name: string | null;
  cod_cliente: number | null;
  primary_phone: string | null;
}

export async function tryRegister(phone: string, cuit: string): Promise<RegisterResult | null> {
  const { data, error } = await supabase.rpc("bot_register_request_v2", {
    p_telefono: phone,
    p_cuit: cuit,
  });

  if (error) {
    console.error("Error en bot_register_request_v2:", error.message);
    return null;
  }

  if (!data?.length) return null;
  return data[0];
}

// ─── Alta de cliente nuevo (no-cliente sin CUIT en sistema) ────────
// Toma de datos paso a paso, 0 tokens (determinístico, sin IA). Se dispara
// cuando un no-cliente acepta registrarse (o su CUIT no está en el sistema).
// El estado vive en `wa_prospect_leads` (status='pending' + alta_step). Al
// terminar: se deja el "cable" para el vendedor (fila en wa_alertas_humano,
// SIN enchufar a ninguna notificación push todavía) y se le avisa al cliente
// que la solicitud va a revisión.

export const ALTA_INTRO =
  `¡Genial! Te tomo los datos para registrarte. 📋\n\n` +
  `Te voy a ir preguntando de a uno. Si querés cortar, escribí *cancelar*.\n\n` +
  `📄 Si tenés la *constancia de inscripción* de ARCA en PDF, mandámela y me ahorrás varias preguntas.\n\n` +
  `🔢 ¿Cuál es tu *CUIT*? (11 números, con o sin guiones)`;

// Cuando el CUIT que pasó el cliente no está en el sistema (arranca el alta con el CUIT ya cargado). Webhook, Simulador y Chat de prueba.
export const MSG_CUIT_NO_ENCONTRADO =
  `No te encontré como cliente con ese CUIT. 🤔\n\n` +
  `Si querés te tomo los datos para registrarte —así podés ver precios y hacer pedidos. ` +
  `Te pregunto de a uno (para cortar, escribí *cancelar*).\n\n` +
  `📄 Si tenés la *constancia de inscripción* de ARCA en PDF, mandámela y completo yo los datos fiscales.\n\n` +
  `📋 ¿Cuál es tu *razón social*?`;

// El CUIT ya es de un cliente (Loekemeyer o Chef): no es un alta, es vincular el número, y lo confirma una persona (sql/072, sql/116).
export const MSG_CUIT_YA_CLIENTE =
  "Ese CUIT ya es cliente nuestro 👍 Por seguridad, un asesor confirma que este número es de la empresa y te avisamos por acá.";

// Pablo, 29/09 (alta mixta): los 10 datos acordados, en este orden. El CUIT se pide sólo si el alta arrancó sin él
// (con "registrarme"); si vino de cuit_not_found ya está validado. El vendedor, el código y el descuento los completa
// quien aprueba desde Tareas (lk_alertas alta_crear), que además crea el acceso a la web.
// deno-lint-ignore no-explicit-any
type AltaLead = any;
// `extra`: otros campos que la misma respuesta completa (el "sí, entregamos en el domicilio fiscal" llena también localidad, provincia y CP).
type AltaParse = { value: unknown; extra?: Record<string, unknown> } | { error: string };
type AltaPaso = {
  field: string; prompt: string;
  /** Texto propio según el lead (ej. proponer el domicilio fiscal de la constancia); null = usar `prompt`. */
  promptDe?: (l: AltaLead) => string | null;
  skip?: (l: AltaLead) => boolean;
  parse?: (t: string, phone: string, l: AltaLead) => AltaParse;
};
const ALTA_STEPS: AltaPaso[] = [
  { field: "cuit", prompt: "🔢 ¿Cuál es tu *CUIT*? (11 números, con o sin guiones)", skip: (l) => !!l.cuit,
    parse: (t) => { const c = extractCuit(t); return c ? { value: c } : { error: "Ese CUIT no parece válido 🤔 Revisá que tenga los 11 números bien copiados y pasámelo de nuevo." }; } },
  { field: "razon_social", prompt: "📋 ¿Cuál es tu *razón social*?", skip: (l) => !!l.razon_social },
  { field: "condicion_iva", prompt: "🧾 ¿Condición frente al IVA? (*Responsable inscripto*, *Monotributo* o *Exento*)", skip: (l) => !!l.condicion_iva,
    parse: (t) => /inscrip|\bri\b|responsable/i.test(t) ? { value: "Responsable inscripto" }
      : /monot/i.test(t) ? { value: "Monotributo" } : /exent/i.test(t) ? { value: "Exento" }
      : { error: "No te entendí 🤔 Escribí *Responsable inscripto*, *Monotributo* o *Exento*." } },
  { field: "nombre_contacto", prompt: "👤 ¿*Nombre de contacto*? (nombre y apellido)" },
  { field: "telefono", prompt: "📱 ¿*Teléfono* de contacto? Si es este mismo número, escribí *este*.",
    parse: (t, phone) => /^(este|el mismo|mismo|este mismo|es este)\b/i.test(t.trim()) ? { value: phone }
      : t.replace(/\D/g, "").length < 8 ? { error: "Ese teléfono parece corto 🤔 Pasámelo con característica (ej: *11 2345-6789*) o escribí *este*." }
      : { value: t.trim() } },
  { field: "mail", prompt: "📧 ¿*Mail*? (ej: nombre@dominio.com)",
    parse: (t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.trim()) ? { value: t.trim() }
      : { error: "Ese mail no parece válido 🤔 Debería ser algo tipo *nombre@dominio.com*. ¿Me lo pasás de nuevo?" } },
  { field: "direccion", prompt: "📍 Dirección de *entrega*: ¿calle y número?",
    // Si el cliente mandó la constancia y confirmó sus datos, se le propone entregar en el domicilio fiscal (no siempre es el mismo).
    promptDe: (l) => { const d = domicilioDeConstancia(l); return d ? `📍 ¿Entregamos en tu domicilio fiscal, *${textoDomicilio(d)}*? Respondé *sí*, o pasame la dirección de *entrega* (calle y número).` : null; },
    parse: (t, _phone, l) => {
      const d = domicilioDeConstancia(l);
      if (!d) return { value: t.trim() };
      if (esConfirmacion(t) || /^\W*(la misma|misma|el mismo|mismo|igual|ah[ií]|en el fiscal)\b/i.test(t)) {
        return { value: d.calle, extra: { localidad: d.localidad, provincia: d.provincia, codigo_postal: d.codigoPostal } };
      }
      if (RE_NIEGA.test(t)) return { error: "Dale 👍 Pasame la dirección de *entrega* (calle y número)." };
      return { value: t.trim() };
    } },
  { field: "localidad", prompt: "📍 ¿*Localidad*?", skip: (l) => !!l.localidad },
  { field: "provincia", prompt: "📍 ¿*Provincia*?", skip: (l) => !!l.provincia },
  { field: "codigo_postal", prompt: "📍 ¿*Código postal*?", skip: (l) => !!l.codigo_postal,
    parse: (t) => { const m = t.toUpperCase().match(/\b([A-Z]?\d{4}[A-Z]{0,3})\b/); return m ? { value: m[1] } : { error: "No encontré el código postal 🤔 Son 4 números (ej: *1417*)." }; } },
  { field: "expreso_nombre", prompt: "🚚 ¿Te lo mandamos por *expreso* (interior)? Decime cuál. Si recibís en CABA o GBA, escribí *no*.",
    parse: (t) => /^(no|ninguno|no\s+uso|reparto|caba|gba)\b/i.test(t.trim()) ? { value: null } : { value: t.trim() } },
  { field: "tipo_comercio", prompt: "🏪 Por último, ¿qué *tipo de comercio* tenés? (ej: bazar, mayorista, distribuidor). Si preferís no decirlo, escribí *saltar*.",
    parse: (t) => /^(saltar|no|-|paso)\b/i.test(t.trim()) ? { value: null } : { value: t.trim() } },
];
// Salta los pasos que no corresponden (ej. CUIT ya cargado) desde `desde`.
function altaProximoPaso(desde: number, lead: AltaLead): number {
  let i = desde;
  while (i < ALTA_STEPS.length && ALTA_STEPS[i].skip?.(lead)) i++;
  return i;
}

// ─── Constancia de inscripción (PDF de ARCA) ─────────────────────────────────────────────────────────────────────────────────
// Pablo, 06/10. El cliente la manda por WhatsApp (el webhook la lee con _shared/constancia.ts, por reglas, 0 tokens) y el bot le
// muestra lo que leyó. Ese estado vive en `wa_prospect_leads.raw_messages`, como una entrada más con `role: "constancia"` (sin columnas
// nuevas): `pendiente` (esperando el "sí"), `aplicada` (completó CUIT, razón social e IVA) o `descartada` (dijo que no, o contestó otra cosa).
// deno-lint-ignore no-explicit-any
type EntradaMsg = any;
const mensajesDe = (l: AltaLead): EntradaMsg[] => Array.isArray(l?.raw_messages) ? l.raw_messages : [];

/** La constancia que se le mostró y todavía no confirmó: sólo si es lo ÚLTIMO del lead (lo que escribe ahora la contesta). */
function constanciaPendiente(l: AltaLead): EntradaMsg | null {
  const m = mensajesDe(l);
  const ult = m[m.length - 1];
  return ult?.role === "constancia" && ult.estado === "pendiente" ? ult : null;
}

/** Domicilio fiscal de la última constancia confirmada, mientras no haya dirección de entrega cargada. */
function domicilioDeConstancia(l: AltaLead): ConstanciaDatos["domicilio"] {
  if (l?.direccion) return null;
  const m = mensajesDe(l);
  for (let i = m.length - 1; i >= 0; i--) {
    if (m[i]?.role === "constancia" && m[i].estado === "aplicada") return m[i].datos?.domicilio ?? null;
  }
  return null;
}

/** "Sí" a lo que se le mostró: una afirmación corta, o "correcto" / "está bien". */
export function esConfirmacion(text: string): boolean {
  return esAfirmacion(text) || /^\W*(est[aá] bien|as[ií] es|son correctos|todo bien)\W*$/i.test(text.trim());
}
const RE_NIEGA = /^\W*(no|nop|nope|incorrecto|incorrectos|est[aá] mal|no son|no es)\b/i;

/** Lo que se le pregunta ahora (o null si el alta ya está completa). Sirve para no dejarlo parado cuando manda algo que no es una respuesta. */
export function promptActual(l: AltaLead): string | null {
  const i = altaProximoPaso(l.alta_step ?? 0, l);
  return i < ALTA_STEPS.length ? (ALTA_STEPS[i].promptDe?.(l) ?? ALTA_STEPS[i].prompt) : null;
}

/** ¿Este CUIT ya es de un cliente de Loekemeyer o de Chef? (el alta no aplica: se vincula el número con revisión humana) */
export async function cuitYaEsCliente(cuit: string): Promise<boolean> {
  const { data: lk } = await supabase.from("customers").select("id").eq("cuit", cuit).limit(1);
  if (lk?.length) return true;
  const { data: ch } = await supabase.from("bot_cuentas").select("razon_social").eq("empresa", "CH").eq("cuit", cuit).limit(1);
  return !!ch?.length;
}

/**
 * Llegó una constancia de un no-cliente y se la pudo leer (_shared/constancia.ts). Si el CUIT ya es cliente, va a vinculación; si no,
 * se le muestra lo que se leyó y se espera su "sí" (nada se usa sin confirmar: el PDF es público y la lectura no está validada con una
 * constancia real). Con un alta en curso suma la constancia a ese lead; sin alta, la abre con el CUIT.
 */
export async function procesarConstancia(
  phone: string,
  d: ConstanciaDatos,
  archivo: string | null,
  send: (reply: string) => Promise<void>,
): Promise<void> {
  const lead = await getPendingLead(phone);
  if (await cuitYaEsCliente(d.cuit)) {
    if (lead) await supabase.from("wa_prospect_leads").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", lead.id);
    if (!SIM.activo) await tryRegister(phone, d.cuit);   // el simulador no pide vinculaciones reales
    await send(MSG_CUIT_YA_CLIENTE);
    return;
  }
  if (lead?.cuit && lead.cuit !== d.cuit) {
    await send(`El CUIT de la constancia (${formatoCuit(d.cuit)}) no es el que me pasaste antes (${formatoCuit(lead.cuit)}). ` +
      `Revisá cuál es el correcto y mandame la constancia de nuevo, o escribime el CUIT.`);
    return;
  }
  const entrada = { role: "constancia", estado: "pendiente", datos: d, archivo, desdeConstancia: !lead, ts: new Date().toISOString() };
  if (lead) {
    await supabase.from("wa_prospect_leads").update({ raw_messages: [...mensajesDe(lead), entrada], updated_at: new Date().toISOString() }).eq("id", lead.id);
  } else {
    await crearLead(phone, "[constancia de inscripción]", d.cuit, [entrada]);
  }
  await send(textoConfirmaConstancia(d));
}

export const MSG_ALTA_COMPLETA =
  `✅ ¡Listo! Ya tengo todos tus datos.\n\n` +
  `La solicitud irá a revisión y nos pondremos en contacto con vos cuando sea aprobada. ¡Gracias! 🙌`;

export const MSG_ALTA_CANCELADA =
  `Listo, cancelé el registro. Si querés retomarlo más adelante, escribime *registrarme*. 👋`;

// Dispara el alta (aceptar el registro / "soy nuevo").
//
// Punto 11 de la auditoría del 07/09: esto matcheaba `alta`, `registro` y —lo peor— `dale`
// sueltos. Al pedido de CUIT alguien contesta "dale, ya te lo paso" y arrancaba el alta;
// el CUIT del mensaje siguiente se guardaba como `razon_social`, y como `ALTA_STEPS` no
// tiene paso de CUIT, ese lead quedaba SIN CUIT para siempre.
//
// Ahora son frases explícitas. `dale`/`sí` solos ya no alcanzan: tienen que venir pegados a
// la intención ("dale, registrame"). Y si el mensaje trae un CUIT, `handleRegistration` ya
// cortó antes de llegar acá. (Nota 05/10: desde el 29/09 el alta SÍ tiene paso de CUIT, así que ese CUIT ya no se guardaría como razón
// social; igual se mantiene la regla de frases explícitas, y el "sí" suelto sólo vale como respuesta a la oferta de registro: ver `iniciaAlta`.)
export const RE_ALTA_START =
  // Pablo, 30/09: "queremos abrir cuenta" / "ser distribuidor" (visto en las consultas reales) pedían el CUIT antes de
  // arrancar el alta. Sólo se mira para números que todavía no son clientes, así que "cuenta corriente" de un cliente no cae acá.
  // Pablo, 30/09 (10.2 y 10.3): "tengo un comercio y quiero comprar por mayor" y "somos distribuidora, nos interesa
  // incorporar su línea" arrancan el alta igual que "quiero ser cliente".
  /\b(soy nuevo|no soy cliente|nuevo cliente|quiero ser cliente|(darme|dar) de alta|registrame|registrarme|registrarte|quiero registrarme|quiero el registro|primera vez que (compro|les compro|escribo)|abrir (una )?cuenta|ser (distribuidor|distribuidora|revendedor|revendedora)(es|s)?|comprar (por|al) mayor|(tengo|tenemos) un (comercio|local|negocio|bazar)|somos (una |un )?(distribuidora|distribuidor|mayorista|comercio|bazar)|incorporar (su|sus|la|tu|tus) (l[ií]nea|productos|marca)|trabajar con (ustedes|su marca|tu marca)|(ser|hacerme|hacerse) (un |una )?clientes?|que (me|nos) (registren|den de alta|den el alta|abran (una )?cuenta)|(solicitar|pedir) (el |un |mi )?(alta|registro))\b/i;
// Pablo, 05/10: "Hola me gustaría ser cliente" ganaba la respuesta fija del saludo ("decime si querés que te registre") y el
// cliente tenía que contestar de nuevo: faltaban "ser cliente" a secas ("me gustaría / quisiera / me interesa ser cliente") y
// "que me registren". Es seguro ampliar: si el CUIT que pide el primer paso ya es cliente, el alta se corta y pasa a vinculación.

// Pablo, 05/10: el "sí" a la oferta de registro. El saludo de un no-cliente le ofrece registrarse ("Decime si querés que te
// registre…") y el cliente contesta "Sí" / "Dale" / "Sí, por favor": ninguno de los tres arrancaba el alta, caía en "pasame tu CUIT".
// Una afirmación suelta NO alcanza por sí sola (al "¿me pasás tu CUIT?" también se contesta "dale"): sólo vale si lo ÚLTIMO que
// dijo el bot fue ofrecer el registro. Misma regla que el punto 11 de la auditoría: frases explícitas, no palabras sueltas.
const RE_OFERTA_REGISTRO = /que te registre|te registro|registrarme|registrarte|te tomo los datos/i;
const AFIRMA_SI = new Set(["si", "sii", "siii", "dale", "daale", "ok", "okey", "okay", "bueno", "claro", "perfecto", "obvio",
  "quiero", "vamos", "adelante", "hagamoslo", "anotame", "correcto", "correctos", "exacto"]);
const AFIRMA_RELLENO = new Set(["de", "una", "por", "favor", "porfa", "me", "gustaria", "quisiera", "registrame", "registrarme", "genial"]);
const RE_AFIRMA_EMOJI = /^(?:\s*[👍👌✅🙌🤝]\s*)+$/u;

/** "Sí", "Dale", "Sí, por favor", "Bueno dale", "De una", "👍": una afirmación corta y nada más (hasta 5 palabras). */
export function esAfirmacion(text: string): boolean {
  if (RE_AFIRMA_EMOJI.test(text)) return true;
  const palabras = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zñ\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!palabras.length || palabras.length > 5) return false;
  if (!palabras.every((p) => AFIRMA_SI.has(p) || AFIRMA_RELLENO.has(p))) return false;
  return palabras.some((p) => AFIRMA_SI.has(p)) || palabras.join(" ").includes("de una");
}

/** ¿Este mensaje de un no-cliente arranca el alta? Pide registrarse con palabras propias, o dice "sí" a la oferta del bot. */
export function iniciaAlta(text: string, ultimoBot: string): boolean {
  return RE_ALTA_START.test(text) || (RE_OFERTA_REGISTRO.test(ultimoBot) && esAfirmacion(text));
}

/** Último mensaje del bot a este teléfono ("" si lo último del historial no lo escribió el bot). Se lee ANTES de guardar el
 *  mensaje que llegó, porque después lo último del historial es el del cliente. */
export async function ultimoMensajeDelBot(phone: string): Promise<string> {
  const { data } = await supabase.from("bot_historial_chat").select("rol, contenido").eq("telefono", phone)
    .order("creado_en", { ascending: false }).limit(1);
  const ult = data?.[0];
  return ult && ult.rol === "assistant" ? String(ult.contenido ?? "") : "";
}

// Textos del no-cliente que todavía no arrancó el alta. Los usan el webhook, el Simulador y el Chat de prueba.
export const MSG_CUIT_INVALIDO =
  `Ese CUIT no parece válido 🤔\n\n` +
  `Verificá que tenga *11 dígitos* y esté bien copiado (con o sin guiones), y probá de nuevo.\n\n` +
  `Si no lo tenés a mano, escribinos a ventas@loekemeyer.com`;

// Pablo, 05/10: antes mezclaba las dos cosas en una sola pregunta ("pasame tu CUIT… si todavía no sos cliente, decime registrarme")
// y quien quería ser cliente no sabía qué contestar. Ahora son dos caminos, cada uno con su palabra. "sí" / "dale" también arrancan el alta.
export const MSG_NO_CLIENTE =
  `Todavía no te tengo registrado como cliente. 🤔\n\n` +
  `• Si ya sos cliente: pasame tu *CUIT* (con o sin guiones) y te vinculo este número.\n` +
  `• Si querés ser cliente: escribí *registrarme* y te tomo los datos (te pregunto de a uno).`;

export interface RespuestaNoCliente { respuestas: string[]; via: string }

/**
 * El flujo de un no-cliente SIN efectos reales: lo que corren el Simulador (modo "número nuevo") y el Chat de prueba. Es el mismo
 * orden que el webhook (alta en curso → alta pedida → respuesta fija → CUIT → alta → "no te tengo"), pero cuando el CUIT ya es de un
 * cliente NO pide la vinculación (el webhook sí, con `tryRegister`). Quien lo llama prende `SIM.activo` para que el alta tampoco
 * cree la alerta de Tareas. Antes el Chat de prueba tenía una copia vieja (otras preguntas, otro regex, sin el "sí"), así que
 * probar ahí no mostraba lo que contesta el bot de verdad. `faq` lo pasa quien llama (cada uno arma su propio `via`).
 */
export async function atenderNoCliente(
  phone: string,
  text: string,
  opts: { ultimoBot: string; faq: (t: string) => Promise<{ reply: string; via: string } | null> },
): Promise<RespuestaNoCliente> {
  const respuestas: string[] = [];
  const send = async (r: string) => { respuestas.push(r); };
  const lead = await getPendingLead(phone);
  if (lead) {
    await handleAltaStep(phone, text, lead, send);
    return { respuestas, via: "alta (paso a paso)" };
  }
  const quiereAlta = iniciaAlta(text, opts.ultimoBot);
  const faq = quiereAlta ? null : await opts.faq(text);   // mismo orden que el webhook
  if (faq) return { respuestas: [faq.reply], via: faq.via };

  const cuit = extractCuit(text);
  if (cuit) {
    const { data: ya } = await supabase.from("customers").select("business_name").eq("cuit", cuit).limit(1);
    // sql/116: si no es de Loekemeyer pero sí de Chef, también va a vinculación (antes arrancaba el alta).
    const { data: yaCh } = ya?.length ? { data: [] } : await supabase.from("bot_cuentas").select("razon_social")
      .eq("empresa", "CH").eq("cuit", cuit.replace(/\D/g, "")).limit(1);
    if (ya?.length || yaCh?.length) {
      const nombre = ya?.length ? ya[0].business_name : yaCh![0].razon_social;
      return {
        respuestas: [`Encontré la cuenta de *${nombre}*. 👍\n\nPor seguridad, un asesor tiene que confirmar que este número es de la empresa antes de vincularlo. (Prueba: no se pide la vinculación.)`],
        via: ya?.length ? "registro por CUIT" : "registro por CUIT (cliente de Chef)",
      };
    }
    await crearLead(phone, text, cuit);
    return {
      respuestas: [MSG_CUIT_NO_ENCONTRADO],
      via: "alta (arranca con CUIT)",
    };
  }
  if (text.replace(/\D/g, "").length >= 11) return { respuestas: [MSG_CUIT_INVALIDO], via: "CUIT inválido" };
  if (quiereAlta) {
    await crearLead(phone, text, null);
    return { respuestas: [ALTA_INTRO], via: "alta (arranca)" };
  }
  return { respuestas: [MSG_NO_CLIENTE], via: "no cliente" };
}

// Cortar el alta en curso.
export const RE_ALTA_CANCEL = /\b(cancelar|cancelá|salir|dejar|olvidalo|no quiero|parar|basta)\b/i;

/**
 * v14.13 — punto 11c de la auditoría del 07/09. Antes esto usaba `.maybeSingle()`, que con DOS
 * filas `pending` del mismo teléfono devuelve `null` y un error PGRST116 que nadie miraba. El
 * resultado era el peor posible: el paso que intercepta el alta no se activaba nunca y el bot
 * contestaba "pasame tu CUIT" **en loop para siempre**, sin forma de salir.
 *
 * Ahora se toma el más reciente (`order` + `limit(1)`), así dos filas no rompen nada, y el
 * error se loguea en vez de tragarse. El índice único parcial de `sql/059` impide que se
 * vuelvan a crear dos, pero esto tiene que aguantar las que ya existan.
 */
/**
 * v14.13 — punto 11a: además, un alta abierta **vence**. Sin vencimiento, quien abandonaba
 * en el campo 4 y volvía dos semanas después con un "hola, me pasás la lista?" tenía ese
 * saludo guardado como mail o como dirección: el paso del alta se come cualquier mensaje.
 * El único escape era `RE_ALTA_CANCEL`, que nadie sabe que existe.
 *
 * A las `ALTA_TTL_HORAS` sin tocar, el alta se marca `expired` y el flujo arranca de cero
 * (el índice único parcial de sql/059 es sobre `status='pending'`, así que expirarla libera
 * el teléfono para un alta nueva).
 */
const ALTA_TTL_HORAS = 48;

export async function getPendingLead(phone: string) {
  const { data, error } = await supabase
    .from("wa_prospect_leads")
    .select("id, cuit, razon_social, condicion_iva, nombre_contacto, telefono, mail, direccion, localidad, provincia, codigo_postal, expreso_nombre, tipo_comercio, alta_step, raw_messages, updated_at")
    .eq("phone", phone)
    .eq("status", "pending")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) console.error(`[alta] getPendingLead(${phone}) falló:`, error.message);
  const lead = (data && data[0]) || null;
  if (!lead) return null;

  const tocado = lead.updated_at ? Date.parse(String(lead.updated_at)) : NaN;
  if (Number.isFinite(tocado) && Date.now() - tocado > ALTA_TTL_HORAS * 3600_000) {
    const { error: e2 } = await supabase
      .from("wa_prospect_leads")
      .update({ status: "expired" })
      .eq("id", lead.id)
      .eq("status", "pending");
    if (e2) {
      // No se pudo expirar: mejor seguir con el alta vieja que perder los datos ya cargados.
      console.error(`[alta] no pude expirar el lead ${lead.id}:`, e2.message);
      return lead;
    }
    console.log(`[alta] lead ${lead.id} de ${phone} vencido (>${ALTA_TTL_HORAS} h sin actividad).`);
    return null;
  }
  return lead;
}

/** Avisa al vendedor de un alta completa. CABLE SIN ENCHUFAR: solo deja la
 *  fila en wa_alertas_humano; todavía no hay push/notificación conectada. */
export async function notificarAltaVendedor(phone: string, lead: Record<string, unknown>): Promise<void> {
  // Simulador (modo número nuevo): la alerta sólo se crea de verdad con "Crear tareas de prueba", marcada 🧪.
  if (SIM.activo) {
    SIM.alertas.push({ tipo: "alta_cliente_nuevo", lead_id: lead.id ?? null, cuit: lead.cuit ?? null, razon_social: lead.razon_social ?? null,
      nombre_contacto: lead.nombre_contacto ?? null, localidad: lead.localidad ?? null, motivo: "solicitud_alta_completa" });
    return;
  }
  try {
    await supabase.from("wa_alertas_humano").insert({
      tipo: "alta_cliente_nuevo",
      phone,
      contexto: {
        lead_id: lead.id ?? null,
        cuit: lead.cuit ?? null,
        razon_social: lead.razon_social ?? null,
        nombre_contacto: lead.nombre_contacto ?? null,
        localidad: lead.localidad ?? null,
        motivo: "solicitud_alta_completa",
      },
    });
  } catch (e) {
    console.error("notificarAltaVendedor falló:", e);
  }
}

/** Guarda lo contestado y avanza: pregunta lo que sigue, o cierra el alta y avisa al vendedor si ya no falta nada. */
async function guardarYAvanzar(
  phone: string,
  // deno-lint-ignore no-explicit-any
  lead: any,
  messages: EntradaMsg[],
  campos: Record<string, unknown>,
  desde: number,
  send: (reply: string) => Promise<void>,
  prefijo = "",
): Promise<void> {
  const actualizado = { ...lead, ...campos, raw_messages: messages };
  const siguiente = altaProximoPaso(desde, actualizado);
  const completo = siguiente >= ALTA_STEPS.length;
  await supabase.from("wa_prospect_leads")
    .update({
      ...campos,
      alta_step: siguiente,
      raw_messages: messages,
      ...(completo ? { status: "complete" } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id);

  if (!completo) { await send(prefijo + (ALTA_STEPS[siguiente].promptDe?.(actualizado) ?? ALTA_STEPS[siguiente].prompt)); return; }
  await notificarAltaVendedor(phone, actualizado);
  await send(MSG_ALTA_COMPLETA);
}

/** Enruta la respuesta del cliente al campo del alta que corresponda. */
export async function handleAltaStep(
  phone: string,
  text: string,
  // deno-lint-ignore no-explicit-any
  lead: any,
  send: (reply: string) => Promise<void>,
): Promise<void> {
  if (RE_ALTA_CANCEL.test(text)) {
    await supabase.from("wa_prospect_leads")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", lead.id);
    await send(MSG_ALTA_CANCELADA);
    return;
  }

  const messages = Array.isArray(lead.raw_messages) ? [...lead.raw_messages] : [];
  const mensajeCliente = { role: "user", content: text, ts: new Date().toISOString() };
  let reset: Record<string, unknown> = {};   // campos que se vuelven a dejar vacíos si se descarta la constancia

  // La constancia que se le mostró y todavía no contestó: "sí" la aplica (CUIT, razón social, IVA); "no" u otra cosa la descarta.
  const pend = constanciaPendiente(lead);
  if (pend) {
    const entrada = messages[messages.length - 1];
    if (esConfirmacion(text)) {
      const d: ConstanciaDatos = entrada.datos;
      const relleno: Record<string, unknown> = {};
      if (!lead.cuit) relleno.cuit = d.cuit;
      if (!lead.razon_social) relleno.razon_social = d.razonSocial;
      if (!lead.condicion_iva && d.condicionIva) relleno.condicion_iva = d.condicionIva;
      messages[messages.length - 1] = { ...entrada, estado: "aplicada" };
      messages.push(mensajeCliente);
      await guardarYAvanzar(phone, lead, messages, relleno, lead.alta_step ?? 0, send, "Perfecto, ya tengo tus datos fiscales. ✅\n\n");
      return;
    }
    messages[messages.length - 1] = { ...entrada, estado: "descartada" };
    // Si el alta nació de la constancia, el CUIT que trajo se saca (si no, el bot nunca se lo volvería a pedir).
    if (entrada.desdeConstancia) { reset = { cuit: null }; lead = { ...lead, cuit: null }; }
    // Dijo que no, o contestó otra cosa: la constancia se deja de lado y se vuelve a preguntar el paso en curso. Lo que escribió NO se toma
    // como respuesta (si el alta nació de la constancia, el paso en curso es el CUIT y un texto cualquiera daría "CUIT inválido").
    messages.push(mensajeCliente);
    await supabase.from("wa_prospect_leads").update({ ...reset, raw_messages: messages, updated_at: new Date().toISOString() }).eq("id", lead.id);
    const sig = promptActual({ ...lead, raw_messages: messages });
    await send((RE_NIEGA.test(text) ? "Listo, seguimos a mano. 👍" : "Dejo la constancia de lado y seguimos a mano. 👍") + (sig ? `\n\n${sig}` : ""));
    return;
  }

  const step = altaProximoPaso(lead.alta_step ?? 0, lead);
  messages.push(mensajeCliente);

  if (step >= ALTA_STEPS.length) {
    // Ya estaba completo (mensaje tardío) — no re-notificar.
    await send("Tu solicitud ya está registrada y en revisión ✅ Te avisamos por acá cuando se apruebe.");
    return;
  }
  const paso = ALTA_STEPS[step];
  if (!text.trim()) { await send("Se me quedó vacío 🤔 ¿Me lo repetís?"); return; }
  const r: AltaParse = paso.parse ? paso.parse(text, phone, lead) : { value: text.trim() };
  if ("error" in r) { await send(r.error); return; }   // dato mal → se repregunta el MISMO campo

  // CUIT que ya es cliente: no es un alta, es vincular el número (lo aprueba una persona, sql/072).
  // Pablo, 05/10: antes sólo miraba Loekemeyer (`customers`). Un cliente que sólo le compra a Chef (399 filas del padrón, 05/10) que contestaba
  // "sí" / "registrarme" y después pasaba su CUIT hacía el alta entera como si fuera nuevo. `tryRegister` ya sabe vincular a Chef (sql/116).
  if (paso.field === "cuit" && await cuitYaEsCliente(String(r.value))) {
    await supabase.from("wa_prospect_leads").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", lead.id);
    if (!SIM.activo) await tryRegister(phone, String(r.value));   // el simulador no pide vinculaciones reales
    await send(MSG_CUIT_YA_CLIENTE);
    return;
  }

  await guardarYAvanzar(phone, lead, messages, { ...reset, [paso.field]: r.value, ...(r.extra ?? {}) }, step + 1, send);
}

/** Crea el lead (status='pending', alta_step=0). No envía nada: el caller
 *  decide el copy de arranque. `cuit` opcional (viene de cuit_not_found). */
/**
 * v14.13 — idempotente. Antes insertaba sin mirar si el teléfono ya tenía un alta abierta, que
 * es exactamente cómo se llegaba a las dos filas `pending` que dejaban el alta en loop.
 */
export async function crearLead(phone: string, text: string, cuit: string | null, extraMensajes: EntradaMsg[] = []): Promise<void> {
  const abierto = await getPendingLead(phone);
  if (abierto) {
    console.log(`[alta] ${phone} ya tenía un alta abierta (lead ${abierto.id}); no se crea otra.`);
    return;
  }
  const { error } = await supabase.from("wa_prospect_leads").insert({
    phone,
    cuit,
    alta_step: 0,
    status: "pending",
    raw_messages: [{ role: "user", content: text, ts: new Date().toISOString() }, ...extraMensajes],
  });
  // 23505 = chocó con el índice único parcial de sql/059: otra entrega del mismo mensaje
  // ganó la carrera. No es un error: el alta ya existe.
  if (error && error.code !== "23505") {
    console.error(`[alta] no se pudo crear el lead de ${phone}:`, error.message);
  }
}

