// chef — atención a clientes que sólo le compran a Chef, por el mismo número que Loekemeyer (Pablo Olejavetzky, 01/10).
//
// Por qué un corte y no atención completa: las herramientas del bot (pedidos, estado, facturas de isis_lk, stock,
// catálogo) todavía buscan en Loekemeyer por número de cliente, y ese número es otro cliente en cada empresa (el 2444
// es Relca en LK y Cencosud en Chef). Hasta que cada consulta sepa de qué empresa es, a un cliente de Chef el bot le
// contesta sólo lo que ya cruza por CUIT y no puede mezclar empresas:
//   · saludo y "gracias";
//   · facturas de Chef sin pagar (GV_Cobranza_Deuda_Viva, empresa chef, por CUIT) y datos de pago de Chef (ficha
//     Empresas; si Chef no tiene alias cargado, Cobranzas se los pasa: nunca el alias de Loekemeyer);
//   · fase 3 (01/10): reenvío de la factura (isis_ch, bucket isis-ch), factura duplicada, "¿recibieron el pago?"
//     (recibos de Chef) y descuentos de sus facturas — las mismas funciones de faq.ts que usa un cliente de LK, con
//     codLk = null;
//   · "¿cuándo llega mi pedido?": sus pedidos de Chef con estado y fecha de salida (pedidos-marca.ts);
//   · "¿tienen X?" (fase 4, paso A): productos del catálogo de Chef con código, unidades por caja y stock, sin precio ni foto
//     (catalogo-chef.ts);
// y todo lo demás lo pasa a una persona (alerta cliente_chef). Es el mismo principio que la llave de envío: un corte
// en un solo lugar, que se levanta cuando cada consulta sepa de qué empresa es.
//
// Quién es cliente de Chef: bot_identificar_chef (sql/115) — vinculación aprobada en bot_chef_whatsapps o el padrón de
// teléfonos de Gestión con empresa, sólo si todo lo que hay para ese teléfono en las dos empresas es el mismo CUIT. El
// webhook la llama únicamente cuando wa_identify_customer no encontró un cliente de LK.

import { supabase } from "./supabase.ts";
import { notificarHumano } from "./alertas.ts";
import { SIM } from "./simulacion.ts";
import {
  bloqueFacturasChef, type CtxPagos, esSoloSaludo, facturaDuplicada, type FaqResult, lookupFacturaReenvio, pagoRegistrado,
  RE_ESTADO_PEDIDO, RE_FACTURA_DUPLICADA, RE_PAGO_RECIBIDO, RE_PIDE_FACTURA, RE_PLAZO_ENTREGA,
} from "./faq.ts";
import { esConsultaEstado, pedidosChef, textoPedidosChef } from "./pedidos-marca.ts";
import { responderProductosChef } from "./catalogo-chef.ts";
import { datosCobranzas, datosEmpresas, deudaChefPorCuit, textoDatosPago } from "./empresas.ts";

export interface CuentaChef {
  cod_cliente: string;
  razon_social: string;
  cuit: string | null;
  fuente: string;          // "vinculo" | "gv_clientes_whatsapp" | "simulador"
}

/** La cuenta de Chef de un teléfono, o null si no es (sólo) cliente de Chef o si la consulta falla. */
export async function cuentaChef(phone: string): Promise<CuentaChef | null> {
  const { data, error } = await supabase.rpc("bot_identificar_chef", { p_phone: phone });
  if (error) {
    console.error("bot_identificar_chef:", error.message);
    return null;
  }
  const r = data?.[0];
  return r?.cod_cliente
    ? { cod_cliente: String(r.cod_cliente), razon_social: String(r.razon_social ?? ""), cuit: r.cuit ?? null, fuente: String(r.fuente ?? "") }
    : null;
}

// "gracias", "ok gracias", "dale, perfecto", "👍": sólo palabras de cortesía (mismo criterio que esSoloSaludo).
const PALABRAS_CORTESIA = new Set(["gracias", "graciass", "muchas", "mil", "ok", "oka", "okey", "okk", "dale", "perfecto",
  "genial", "listo", "barbaro", "joya", "buenisimo", "de", "acuerdo", "entendido", "bueno", "igualmente", "saludos"]);
export function esCortesia(text: string): boolean {
  const palabras = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (!palabras.length) return /^[\s\p{Extended_Pictographic}‍️]+$/u.test(text);   // sólo emojis (👍, 🙏)
  return !/\d/.test(text) && palabras.length <= 5 && palabras.every((p) => PALABRAS_CORTESIA.has(p));
}
const RE_COMPROBANTE = /(comprobante|ya (te |les )?(pagu[eé]|transfer[ií]|deposit[eé])|(recibieron|les lleg[oó]|te lleg[oó]|vieron) (el |mi |la )?(pago|transferencia|dep[oó]sito)|te (paso|mando|env[ií]o) (el|la) (comprobante|transferencia))/i;
const RE_DEUDA = /(cu[aá]nto (debo|te debo|les debo|tengo que pagar|hay que pagar|es lo que debo)|deuda|saldo|estado de cuenta|resumen de cuenta|facturas? (pendientes?|impagas?|vencidas?|a pagar|sin pagar|adeudadas?)|qu[eé] (debo|tengo (pendiente|para pagar|que pagar))|tengo algo (pendiente|para pagar|vencido))/i;
const RE_DESCUENTO = /(descuento|bonificaci|cu[aá]nto (me )?(sale|queda|pago) si (pago|abono|transfiero))/i;
const RE_DATOS_PAGO =/(\balias\b|\bcbu\b|\bcvu\b|transfer(encia|ir|irles|irte)\b|datos (de|para) (pago|pagar|transferir|la transferencia)|cuenta (bancaria|para (pagar|transferir|depositar))|d[oó]nde (les |te )?(pago|transfiero|deposito)|c[oó]mo (les |te )?pago)/i;

/**
 * Consultas de plata (facturas, saldo, pagos, comprobantes, descuentos, datos para transferir): un cliente de las dos marcas
 * las recibe con las dos empresas separadas (faq.ts y consultar_mis_facturas), así que la puerta de marca no las pregunta.
 */
export function esConsultaDePagos(t: string): boolean {
  return RE_FACTURA_DUPLICADA.test(t) || RE_PIDE_FACTURA.test(t) || RE_PAGO_RECIBIDO.test(t) || RE_COMPROBANTE.test(t) ||
    RE_DESCUENTO.test(t) || RE_DEUDA.test(t) || RE_DATOS_PAGO.test(t);
}

const pesos = (n: unknown) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR", { maximumFractionDigits: 0 });
const fechaLarga = (f: unknown) => { const s = String(f ?? ""); return s.length >= 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : ""; };
const ddmm = (f: unknown) => { const s = String(f ?? ""); return s.length >= 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : ""; };
const hoyAR = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());

/** ¿Ya hay una alerta abierta de este número con ese motivo (desde `desdeHoras` atrás)? En el simulador, nunca. */
async function alertaAbierta(phone: string, motivo: string, desdeHoras: number | null): Promise<boolean> {
  if (SIM.activo) return false;
  let q = supabase.from("wa_alertas_humano").select("id")
    .eq("phone", phone).in("estado", ["pendiente", "notificado"]).eq("contexto->>motivo", motivo);
  if (desdeHoras) q = q.gt("created_at", new Date(Date.now() - desdeHoras * 3600_000).toISOString());
  const { data } = await q.limit(1);
  return !!data?.length;
}

function contextoChef(cuenta: CuentaChef, text: string) {
  return {
    empresa: "CH", cod_cliente_chef: cuenta.cod_cliente, cuit: cuenta.cuit, razon_social: cuenta.razon_social || null,
    texto_recibido: text.trim().slice(0, 300),
  };
}

/** Aviso a Cobranzas (una alerta abierta por número alcanza, igual que consultar_mis_facturas). */
async function avisarCobranzas(phone: string, cuenta: CuentaChef, text: string, detalle: string): Promise<void> {
  if (await alertaAbierta(phone, "pago", null)) return;
  await notificarHumano({
    tipo: "escalation", phone, customerId: null,
    contexto: { motivo: "pago", origen: "cliente_chef", urgente: false, texto: detalle, ...contextoChef(cuenta, text) },
  });
}

async function datosDePagoChef(): Promise<string | null> {
  const emp = await datosEmpresas();
  return textoDatosPago(emp.chef, true);
}

/**
 * Respuesta del bot a un cliente de Chef. `via` dice por qué camino salió (para el simulador y los logs).
 * Nunca devuelve datos de Loekemeyer: ni alias, ni pedidos, ni facturas.
 */
export async function atenderClienteChef(
  phone: string,
  text: string,
  cuenta: CuentaChef,
): Promise<{ reply: string; via: string; yaSaluda?: boolean; documentos?: Array<{ url: string; filename: string }> }> {
  const t = text.trim();
  const ctx: CtxPagos = { codLk: null, cuit: cuenta.cuit, codChef: cuenta.cod_cliente };
  // Respuesta de faq.ts: la alerta (si la trae) sale con los datos de la cuenta de Chef; los PDF los manda el webhook.
  const desdeFaq = async (r: FaqResult, via: string) => {
    if (r.alerta) {
      await notificarHumano({ tipo: "otro", phone, customerId: null, contexto: {
        motivo: r.alerta.motivo, ...(r.alerta.urgente !== undefined ? { urgente: r.alerta.urgente } : {}),
        detalle: r.alerta.detalle ?? null, ...contextoChef(cuenta, t) } });
    }
    return { reply: r.reply, via, ...(r.documentos?.length ? { documentos: r.documentos } : {}) };
  };

  if (esCortesia(t)) return { reply: "¡De nada! 🙌", via: "chef_gracias" };

  if (esSoloSaludo(t)) {
    return {
      reply: `¡Hola${cuenta.razon_social ? ` ${cuenta.razon_social}` : ""}! 👋\n\n` +
        `Por acá te puedo pasar tus facturas de Chef (saldo, descuento y el PDF) y los datos para transferir. ` +
        `Para cualquier otra consulta te responde una persona del equipo. ¿En qué te ayudo?`,
      via: "chef_saludo", yaSaluda: true,
    };
  }

  if (RE_FACTURA_DUPLICADA.test(t)) return await desdeFaq(await facturaDuplicada(ctx, t), "chef_factura_duplicada");
  if (RE_PIDE_FACTURA.test(t)) {
    const r = await lookupFacturaReenvio(ctx, t);
    if (r) return await desdeFaq(r, "chef_factura_reenvio");
  }
  // "¿Recibieron el pago?": se mira en los recibos de Chef (gv_cobranza_recibos); si no figura, avisa a Cobranzas.
  if (RE_PAGO_RECIBIDO.test(t) && !/comprobante/i.test(t)) return await desdeFaq(await pagoRegistrado(ctx, t), "chef_pago_recibido");

  // "Te paso el comprobante", "ya pagué": lo registra Cobranzas.
  if (RE_COMPROBANTE.test(t)) {
    await avisarCobranzas(phone, cuenta, t, "Cliente de Chef: avisa un pago o manda comprobante por WhatsApp.");
    // Pablo, 01/10: con los datos de Cobranzas de Chef (ficha Empresas), si están cargados.
    const cob = datosCobranzas(await datosEmpresas(), { lk: false, chef: true });
    return {
      reply: "¡Gracias! Le paso a Cobranzas para que lo registre y te confirme por acá. " +
        "Si todavía no mandaste el comprobante, mandá la foto o el PDF por este chat. 🙏" +
        (cob ? `\nPara consultas sobre tus pagos podés comunicarte con Cobranzas: ${cob}` : ""),
      via: "chef_pago_aviso",
    };
  }

  // "¿Cuándo llega mi pedido?" (Pablo, 01/10): sus pedidos de Chef con estado y fecha de salida (pedidos-marca.ts). Si pregunta
  // por el plazo general y no tiene nada pendiente, no hay qué listar: sigue a una persona.
  if (esConsultaEstado(t)) {
    const pedidos = await pedidosChef({ cuit: cuenta.cuit, codChef: cuenta.cod_cliente });
    if (pedidos === null) {
      await notificarHumano({ tipo: "otro", phone, customerId: null, contexto: {
        motivo: "entrega", detalle: "Cliente de Chef pregunta por su pedido y Gestión no respondió: pasale el estado.", ...contextoChef(cuenta, t) } });
      return { reply: "No pude consultar tus pedidos en este momento. Le paso tu consulta a una persona del equipo, que te responde por acá. 🙏", via: "chef_pedidos_error" };
    }
    const reply = textoPedidosChef(cuenta.razon_social || "Hola", pedidos, hoyAR(), { soloSiHay: RE_PLAZO_ENTREGA.test(t) && !RE_ESTADO_PEDIDO.test(t) });
    if (reply) return { reply, via: "chef_pedidos" };
  }

  // "¿Qué descuento tengo si pago hoy?": el de cada factura de Chef abierta (lo trae la factura: dto_cond hasta vence).
  if (RE_DESCUENTO.test(t)) {
    const bloque = await bloqueFacturasChef(cuenta.cuit);
    if (bloque === null) {
      await avisarCobranzas(phone, cuenta, t, "Cliente de Chef consultó sus descuentos y Gestión no respondió: pasale el detalle.");
      return { reply: "No pude consultar tus facturas en este momento. Le paso tu consulta a Cobranzas, que te responde por acá. 🙏", via: "chef_descuentos_error" };
    }
    if (!bloque) {
      return { reply: "No tenés facturas de Chef abiertas. El descuento por pago depende de la condición de cada factura y figura en ella.", via: "chef_descuentos" };
    }
    // Sólo hay descuento si alguna factura trae uno vigente (lineaFacturaChef escribe "Pagando hasta el …: X%"): las de condición
    // "30 FF", "Sin Cotizador" o ya vencidas se pagan por el saldo.
    const hayDto = /Pagando hasta el/.test(bloque);
    return {
      reply: `${bloque}\n\n` + (hayDto
        ? "El descuento se reconoce cuando pagás, hasta la fecha que figura en cada factura."
        : "Ninguna de estas facturas tiene descuento por pago: se pagan por el saldo hasta su vencimiento."),
      via: "chef_descuentos",
    };
  }

  if (RE_DEUDA.test(t)) {
    const facturas = await deudaChefPorCuit(cuenta.cuit);
    if (facturas === null) {
      await avisarCobranzas(phone, cuenta, t, "Cliente de Chef consultó su saldo y Gestión no respondió: pasale el saldo.");
      return { reply: "No pude consultar tus facturas en este momento. Le paso tu consulta a Cobranzas, que te responde por acá. 🙏", via: "chef_deuda_error" };
    }
    const total = facturas.reduce((a, f) => a + Number(f.pendiente || 0), 0);
    await avisarCobranzas(phone, cuenta, t, facturas.length
      ? `Cliente de Chef consultó su saldo por WhatsApp: ${facturas.length} factura(s) impaga(s), ${pesos(total)}.`
      : "Cliente de Chef consultó su saldo por WhatsApp: no tiene facturas impagas.");
    if (!facturas.length) return { reply: "No tenés facturas de Chef pendientes de pago. ✅", via: "chef_deuda" };
    const hoy = hoyAR();
    const lineas = facturas.slice(0, 15).map((f) => {
      const vence = String(f.vence ?? "").slice(0, 10) || null;
      const estado = vence ? (vence < hoy ? ` (vencida el ${ddmm(vence)})` : ` (vence el ${ddmm(vence)})`) : "";
      // Fase 3: el descuento lo trae la factura (dto_cond hasta vence, sin pagos parciales), igual que consultar_mis_facturas.
      const pend = Number(f.pendiente || 0), dto = Number(f.dto_cond || 0);
      const conDto = vence && vence >= hoy && dto > 0 && Math.abs(pend - Number(f.lista || 0)) < 1
        ? ` → con ${Math.round(dto * 100)}% pagando hasta el ${ddmm(vence)}: ${pesos(pend * (1 - dto))}` : "";
      return `• Factura ${f.comprobante ?? ""} del ${fechaLarga(f.fecha)}: ${pesos(f.pendiente)}${estado}${conDto}`;
    });
    if (facturas.length > 15) lineas.push(`• y ${facturas.length - 15} más`);
    const datos = await datosDePagoChef();
    return {
      reply: `Tenés ${facturas.length === 1 ? "1 factura" : `${facturas.length} facturas`} de Chef sin pagar, ` +
        `por un total de ${pesos(total)} (con IVA):\n${lineas.join("\n")}\n\n` +
        (datos ?? "Los datos para transferir a Chef te los pasa Cobranzas por acá.") +
        `\n\nCuando pagues, mandanos el comprobante por acá. 🙏`,
      via: "chef_deuda",
    };
  }

  if (RE_DATOS_PAGO.test(t)) {
    const datos = await datosDePagoChef();
    if (!datos) {
      await avisarCobranzas(phone, cuenta, t, "Cliente de Chef pide los datos para transferir y la ficha Empresas no tiene el alias/CBU de Chef.");
      return { reply: "Los datos para transferir a Chef te los pasa Cobranzas por acá en un rato. 🙏", via: "chef_datos_pago_sin_cargar" };
    }
    return { reply: `${datos}\n\nCuando pagues, mandanos el comprobante por acá. 🙏`, via: "chef_datos_pago" };
  }

  // "¿Tienen coladores?" (fase 4, paso A): busca en el catálogo de Chef. Sin precio (lo pasa una persona) ni foto. Si no es una
  // pregunta de producto clara o algo falla, devuelve null y sigue a una persona.
  const prod = await responderProductosChef(t);
  if (prod) {
    if (prod.alerta && !(await alertaAbierta(phone, prod.alerta.motivo, 2))) {
      await notificarHumano({ tipo: "otro", phone, customerId: null, contexto: {
        motivo: prod.alerta.motivo, detalle: prod.alerta.detalle, ...contextoChef(cuenta, t) } });
    }
    return { reply: prod.reply, via: prod.via };
  }

  // Todo lo demás: a una persona. Una alerta por número cada 2 h; los mensajes siguientes quedan en la charla.
  if (await alertaAbierta(phone, "cliente_chef", 2)) {
    return { reply: "Ya le pasé tu consulta a una persona del equipo: te responde por acá. 🙏", via: "chef_derivado_ya_avisado" };
  }
  await notificarHumano({ tipo: "otro", phone, customerId: null, contexto: { motivo: "cliente_chef", ...contextoChef(cuenta, t) } });
  return {
    reply: "Gracias por escribirnos. Tu consulta la responde una persona del equipo por acá, a la brevedad. 🙏",
    via: "chef_derivado",
  };
}
