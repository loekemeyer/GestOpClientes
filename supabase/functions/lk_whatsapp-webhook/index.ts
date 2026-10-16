// lk_whatsapp-webhook — Webhook principal del bot WhatsApp Loekemeyer
// Edge Function en proyecto PaginaLK (kwkclwhmoygunqmlegrg)
//
// GET  → verificación Meta
// POST → mensaje entrante de WhatsApp | action:flush (outbox)
//
// Usa RPCs bot_* para todo acceso a datos (no queries directos).
// Claude tool-use para conversación inteligente.

import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import { supabase, getSetting, habilitarCacheSettings, primeSettings } from "../_shared/supabase.ts";
import {
  sendText,
  sendImage,
  sendDocument,
  sendTemplate,
  markRead,
  extractMessage,
  downloadMediaFromMeta,
  WaApiError,
  type WaMessage,
} from "../_shared/wa-api.ts";
import {
  loadHistory,
  pedidoEnCurso,
  pedidosWaHabilitados,
  runConversation,
  saveMessage,
  type MediaAction,
} from "../_shared/bot-conversation.ts";
import { decidirCapaFija, esSoloSaludo, handleFaq } from "../_shared/faq.ts";
import { respuestasRecientes } from "../_shared/mensaje-compuesto.ts";
import { partirRespuesta } from "../_shared/partir-respuesta.ts";
import { esConsultaDeDisponibilidad } from "../_shared/consulta-disponibilidad.ts";
import { datosDeAccesoWeb, taparClave, TEXTO_CLAVE_A_PERSONA, textoAccesoWeb } from "../_shared/clave-web.ts";
import { notificarHumano } from "../_shared/alertas.ts";
import { pareceAtaqueEntrada } from "../_shared/ataque-entrada.ts";
import { RESPALDO_IA_CAIDA } from "../_shared/respaldo-texto.ts";
import {
  atiendeLaPausa, botEnPausa, CLAVE_PAUSA, contextoAlertaPausa, MINUTOS_ENTRE_AVISOS_PAUSA, MOTIVO_PAUSA, sigueElCaminoNormal, textoParaGuardar,
} from "../_shared/pausa-bot.ts";
import { abrirTurno, guardarTurno, iaEmpieza, iaTermina, type Turno } from "../_shared/tiempos-turno.ts";
import { avisarFueraDeHorario } from "../_shared/fuera-de-horario.ts";
import { contextoAlertaTope, mensajeTope } from "../_shared/tope-ia.ts";
import {
  CACHE_GASTO_MS, contextoAlertaGasto, FUNCION_CLIENTES, inicioDiaArgentina, type NivelGasto, nivelDeGasto, sumarGasto, type Topes, topesDeSettings,
} from "../_shared/tope-gasto.ts";
import {
  contextoAlertaPresupuesto, inicioMesArgentina, pctDelMes, pozoDeSettings, presupuestoDeSettings, sumarGastoMes, umbralCruzado, umbralesDeSettings,
} from "../_shared/presupuesto-ia.ts";
import { contextoAlertaCliente, inicioSemanaArgentina, MSG_TOPE_CLIENTE, nivelClienteGasto, topesClienteDeSettings } from "../_shared/tope-cliente.ts";
import { conCalendario, dentroDeHorario, leerHorario } from "../_shared/horario.ts";
import { cargarCalendario } from "../_shared/feriados.ts";
import { pedidoDeCambio, responderAviso } from "../_shared/respuesta-aviso.ts";
import { atenderMalHumor } from "../_shared/humor.ts";
import { atenderClienteChef, cuentaChef } from "../_shared/chef.ts";
import { datosEmpresas, respuestaComprobante } from "../_shared/empresas.ts";
import { audioActivo, audioEco, textoEco, transcribirAudio } from "../_shared/transcribir.ts";
import { conEtiqueta, puertaMarca } from "../_shared/marca.ts";
import { verificarFirmaMeta } from "../_shared/webhook-firma.ts";
import { compararCotizadorConWeb, esArchivoDePedido, leerPedidoArchivo, resolverArticulos, respuestaPedidoArchivo, sucursalesDelCliente, textoConfirmacion } from "../_shared/pedido-archivo.ts";
import { ALTA_INTRO, crearLead, esAfirmacion, extractCuit, getPendingLead, handleAltaStep, iniciaAlta, MSG_CUIT_INVALIDO, MSG_CUIT_NO_ENCONTRADO, MSG_NO_CLIENTE, procesarConstancia, promptActual, RE_ALTA_START, tryRegister, ultimoMensajeDelBot } from "../_shared/alta.ts";
import { leerConstancia } from "../_shared/constancia.ts";
import { lineaSegura } from "../_shared/dato-externo.ts";
import { contextoAlertaArchivo, MOTIVO_ARCHIVO_SOSPECHOSO, VENTANA_AVISO_MS } from "../_shared/archivo-sospechoso.ts";
import { describirFotoProducto } from "../_shared/vision-producto.ts";
import { type CandidatoFoto, matchFotoProducto, MAX_CANDIDATOS } from "../_shared/match-foto-producto.ts";

// Auditoría de performance (02/10/2026): este webhook leía app_settings ~17 veces por mensaje, un viaje a la base cada una
// (3 ó 4 sólo en loadConfig, antes de mirar el mensaje). Ahora la tabla (40 filas, 8 KB) se lee ENTERA una vez por mensaje
// (`primeSettings`, en el handler POST) y las lecturas que siguen salen de memoria durante 15 s. Sólo este isolate: el
// Simulador y el chat de prueba no la prenden y siguen viendo cada cambio al instante. La llave de envíos
// (`wa_envio_automatico`) no pasa por acá: la lee `wa_puede_enviar` en SQL desde wa-guard. Detalle en _shared/supabase.ts.
habilitarCacheSettings(15_000);

// ─── Config (app_settings → fallback Deno.env) ─────────────────────
// Prioridad: app_settings → env var. app_settings es la fuente de verdad —
// se puede rotar el token desde SQL/dashboard sin tocar secrets de Supabase
// ni redeployar. La env var queda como fallback para bootstrapping o si
// alguien limpia app_settings por error.
//
// Ojo: si tenés env var vieja + app_settings actualizado, este orden usa el
// app_settings (correcto). El orden inverso te dejaría con el token viejo
// funcionando y el nuevo ignorado.

interface Config {
  waPhoneId: string;
  waToken: string;
  waVerifyToken: string;
  anthropicKey: string;
}

async function loadConfig(): Promise<Config> {
  const waPhoneId = (await getSetting("LK_WA_PHONE_ID")) ?? Deno.env.get("LK_WA_PHONE_ID") ?? "";
  // Token de envío de WhatsApp. Prioriza el secret del Vault `WHATSAPP_ACCESS_TOKEN` (el mismo
  // que ya usan lk_factura-check / lk_templates), y deja `LK_WA_TOKEN` (app_settings/env) como
  // respaldo. Objetivo: sacar el token de `app_settings` y tener UNA sola fuente en el Vault
  // (2026-09-10, seguridad). Rotarlo pasa a ser sólo actualizar ese secret.
  const waToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN")
    ?? (await getSetting("LK_WA_TOKEN")) ?? Deno.env.get("LK_WA_TOKEN") ?? "";
  const waVerifyToken = (await getSetting("LK_WA_VERIFY_TOKEN")) ?? Deno.env.get("LK_WA_VERIFY_TOKEN") ?? "";
  const anthropicKey = (await getSetting("ANTHROPIC_API_KEY")) ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";

  if (!waPhoneId || !waToken || !waVerifyToken || !anthropicKey) {
    const missing = [
      !waPhoneId && "LK_WA_PHONE_ID",
      !waToken && "LK_WA_TOKEN",
      !waVerifyToken && "LK_WA_VERIFY_TOKEN",
      !anthropicKey && "ANTHROPIC_API_KEY",
    ].filter(Boolean);
    throw new Error("Faltan credenciales (ni app_settings ni env var): " + missing.join(", "));
  }

  return { waPhoneId, waToken, waVerifyToken, anthropicKey };
}

// ─── Customer lookup ───────────────────────────────────────────────
//
// Dos fuentes, en cascada — el MISMO orden que `lk_chat-test`, para que la
// consola de prueba y producción identifiquen igual (antes divergían y por eso
// en el test andaba y en WhatsApp no):
//
//   1. `wa_identify_customer` → desde sql/073 mira PRIMERO la vinculación aprobada
//      (`bot_customer_whatsapps`) y después `wa_clientes_telefono`, copia del padrón de
//      teléfonos de Gestión Virgilio (`virgilio.whatsapp_clientes`, NO Isis); si el teléfono
//      es de más de una empresa no identifica. Normaliza las variantes 54 / 9 / 15, así que
//      matchea el `from` de Meta contra el formato con el que está cargado.
//      Cobertura medida el 2026-09-07: resuelve 547 de los 610, 0 ambiguos
//      (los 63 restantes son fijos, no líneas de WhatsApp).
//   2. `bot_cliente_por_whatsapp` → `bot_customer_whatsapps`, la vinculación
//      explícita que se pide por WhatsApp y aprueba un humano (desde sql/072 de verdad:
//      antes bot_register_request_v2 auto-vinculaba sólo con el CUIT). Hoy tiene 0
//      filas: por eso el webhook, que consultaba SOLO ésta, no identificaba a
//      NADIE y todo mensaje caía a la rama de no-cliente.
//
// El orden es a pedido del dueño (2026-09-07): que el bot reconozca ya a los
// teléfonos del padrón de Gestión. Cuando `bot_customer_whatsapps` se empiece a poblar sigue
// sirviendo, como override de lo que diga el padrón.

interface CustomerContext {
  customer_id: string;
  cod_cliente: number;
  business_name: string;
  dto_vol: number;
}

/** El descuento por volumen no lo devuelve `wa_identify_customer`. */
async function getDtoVol(customerId: string): Promise<number> {
  const { data } = await supabase
    .from("customers").select("dto_vol").eq("id", customerId).maybeSingle();
  return Number(data?.dto_vol ?? 0);
}

async function getCustomerContext(phone: string): Promise<CustomerContext | null> {
  // 1. Vinculación aprobada + padrón de Gestión Virgilio, sin adivinar (sql/073)
  const { data: ident, error: identErr } = await supabase.rpc("wa_identify_customer", {
    p_phone: phone,
  });
  if (identErr) console.error("Error en wa_identify_customer:", identErr.message);

  const iRow = ident?.[0];
  if (iRow?.customer_id) {
    return {
      customer_id: iRow.customer_id,
      cod_cliente: Number(iRow.cod_cliente),
      business_name: iRow.customer_name,
      dto_vol: await getDtoVol(iRow.customer_id),
    };
  }

  // 2. Vinculación explícita
  const { data, error } = await supabase.rpc("bot_cliente_por_whatsapp", {
    p_telefono: phone,
  });

  if (error) {
    console.error("Error en bot_cliente_por_whatsapp:", error.message);
    return null;
  }

  if (!data?.length) return null;

  const row = data[0];
  return {
    customer_id: row.customer_id ?? row.id,
    cod_cliente: row.cod_cliente,
    business_name: row.business_name,
    dto_vol: row.dto_vol ?? 0,
  };
}

// ─── Modo conversación (bot / humano) ──────────────────────────────

async function getConversationMode(phone: string): Promise<string> {
  const { data, error } = await supabase.rpc("bot_conv_get_modo", {
    p_telefono: phone,
  });
  if (error) {
    console.error("Error en bot_conv_get_modo:", error.message);
    return "bot";
  }
  return data ?? "bot";
}

// ─── Registro / vinculación ────────────────────────────────────────

/** Maneja el flujo de registro para teléfonos no identificados */
async function handleRegistration(
  phone: string,
  text: string,
  contactName: string | undefined,
  cfg: Config,
  // Pablo, 05/10: lo decide el paso 4 (pidió registrarse con palabras propias o dijo "sí" a la oferta del bot).
  quiereAlta: boolean = RE_ALTA_START.test(text),
): Promise<void> {
  // Guardamos el mensaje entrante y cada respuesta en el historial, para que
  // el flujo de identificación (CUIT) sea visible en Conversaciones y se pueda
  // debuggear qué mandó el cliente y qué contestó el bot.
  await saveMessage(phone, "user", text);
  const send = async (reply: string): Promise<void> => {
    await enviarTexto(cfg, phone, reply);
    await saveMessage(phone, "assistant", reply);
  };

  const cuit = extractCuit(text);

  if (!cuit) {
    // Si el cliente tipeó ~11 dígitos pero no pasan la validación (módulo 11),
    // es un CUIT mal copiado: avisamos en vez de repetir el saludo genérico.
    // Un CUIT válido en cualquier mensaje siguiente lo toma extractCuit y avanza
    // (el flujo es stateless: cada mensaje de no-cliente reintenta el registro).
    const digitos = text.replace(/\D/g, "").length;
    if (digitos >= 11) {
      await send(MSG_CUIT_INVALIDO);
      return;
    }
    // Aceptó registrarse (o dijo "soy nuevo") sin pasar CUIT → arrancar alta.
    if (quiereAlta) {
      await crearLead(phone, text, null);
      await send(ALTA_INTRO);
      return;
    }
    await send(MSG_NO_CLIENTE);
    return;
  }

  const result = await tryRegister(phone, cuit);

  if (!result) {
    await send(
      "Hubo un error al procesar tu solicitud. Intentá de nuevo o contactá a ventas: ventas@loekemeyer.com",
    );
    return;
  }

  switch (result.status) {
    case "already_registered": {
      await send(
        `¡Hola ${result.business_name}!\n\n` +
        `Ya estás registrado. ¿En qué te puedo ayudar?\n\n` +
        `📦 Estado de pedidos\n` +
        `🔍 Buscar productos\n` +
        `🚚 Consultar entregas\n` +
        `💬 Cualquier consulta`,
      );
      break;
    }

    case "auto_associated": {
      await send(
        `¡Hola ${result.business_name}!\n\n` +
        `Ya quedaste vinculado a este número.\n` +
        `Podés consultarme por:\n\n` +
        `📦 Estado de tus pedidos\n` +
        `🔍 Buscar productos\n` +
        `🚚 Consultar entregas\n` +
        `💬 Cualquier otra consulta`,
      );
      break;
    }

    case "cuit_not_found": {
      // No está en el sistema → arrancar la toma de datos. El CUIT ya validado
      // (módulo 11) queda guardado en el lead. Un solo mensaje: ofrecer + 1er campo.
      await crearLead(phone, text, cuit);
      await send(MSG_CUIT_NO_ENCONTRADO);
      break;
    }

    case "pending_review": {
      // sql/072: un número nuevo nunca se vincula sólo con el CUIT; lo aprueba una persona
      // desde el dashboard (lk_vinculaciones). El aviso de aprobado/rechazado sale por wa_outbox.
      await send(
        `Encontré la cuenta de *${result.business_name}*.\n\n` +
        `Por seguridad, un asesor tiene que confirmar que este número es de la empresa antes de vincularlo. ` +
        `Te avisamos por este medio apenas quede listo.\n\n` +
        `Si es urgente, escribinos a ventas@loekemeyer.com o al WhatsApp 11 3118 1021.`,
      );
      break;
    }

    case "too_many_attempts": {
      await send(
        `Probaste varios CUIT desde este número en poco tiempo, así que por seguridad no puedo seguir con la vinculación por este medio.\n\n` +
        `Escribinos a ventas@loekemeyer.com o al WhatsApp 11 3118 1021 y lo resolvemos.`,
      );
      break;
    }

    case "pending_primary": {
      await send(
        `Encontré la cuenta de *${result.business_name}*.\n\n` +
        `Como ya hay un teléfono principal registrado, tu solicitud queda pendiente de aprobación.\n\n` +
        `Te vamos a avisar cuando se apruebe.`,
      );
      break;
    }

    default: {
      await send(
        `Tu solicitud está en estado: ${result.status}. Contactá a ventas si necesitás ayuda.`,
      );
    }
  }
}

// ─── Envío de media (resultado de tools) ───────────────────────────

async function sendMediaActions(
  media: MediaAction[],
  phone: string,
  cfg: Config,
): Promise<void> {
  for (const m of media) {
    try {
      if (m.type === "image") {
        await sendImage(cfg.waPhoneId, cfg.waToken, phone, m.url, m.caption);
      } else if (m.type === "document") {
        await sendDocument(
          cfg.waPhoneId, cfg.waToken, phone,
          m.url, m.filename ?? "archivo.pdf", m.caption,
        );
      }
    } catch (e) {
      console.error("Error enviando media:", e);
    }
  }
}

// ─── Flush outbox (enviar mensajes pendientes) ─────────────────────

/**
 * ¿Meta rechazó por idioma? El código 132001 es "Template name does not exist in the
 * translation": la plantilla existe, pero no en el idioma que le pedimos. Se mira el
 * `code` de `WaApiError` y, por las dudas, el texto (si algún día llega envuelto).
 */
function esErrorDeIdioma(e: unknown): boolean {
  if (e instanceof WaApiError && e.code === 132001) return true;
  return /132001|does not exist in the translation/i.test(e instanceof Error ? e.message : String(e));
}

async function flushOutbox(cfg: Config): Promise<{ sent: number; failed: number }> {
  const { data: batch, error } = await supabase.rpc("bot_flush_outbox", {
    p_limit: 20,
  });

  if (error || !batch?.length) {
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  // Idioma de las plantillas, configurable desde el Panel sin tocar código.
  const tplLang = (await getSetting("wa_template_lang")) || "es_AR";
  const tplLangAlt = (await getSetting("wa_template_lang_fallback")) || "es";

  for (const msg of batch) {
    try {
      if (msg.template_name) {
        // Enviar template aprobado por Meta
        const params: string[] = [];
        if (msg.template_params) {
          const vals = Object.values(msg.template_params);
          for (const v of vals) params.push(String(v));
        }
        // Punto 31 de la auditoría del 07/09: el idioma estaba clavado en "es_AR" y
        // `pedido_recordatorio_25` viene fallando con **#132001 "Template name does not
        // exist in the translation"**, que es literalmente "existe la plantilla pero no en
        // ese idioma". Ninguna plantilla se envió nunca con es_AR desde acá (las 12 salidas
        // son texto libre; la única con template es `hello_world`, en_US).
        //
        // Ahora: el idioma sale de `app_settings.wa_template_lang` (default es_AR) y, si
        // Meta contesta 132001, se reintenta UNA vez con el idioma de respaldo
        // (`wa_template_lang_fallback`, default "es"). No es adivinar: 132001 identifica
        // exactamente ese caso, y un solo reintento no puede volverse un loop.
        // El modulo compartido recibe los `components` de Meta ya armados (la copia local
        // que se borro los armaba adentro). Sin parametros no se manda `components`: Meta
        // rechaza un array vacio en una plantilla que no tiene variables.
        const comps = params.length
          ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }]
          : undefined;
        try {
          await sendTemplate(cfg.waPhoneId, cfg.waToken, msg.phone, msg.template_name, tplLang, comps);
        } catch (e) {
          if (!esErrorDeIdioma(e)) throw e;
          console.warn(`[outbox] ${msg.template_name} no existe en ${tplLang}; reintento en ${tplLangAlt}.`);
          await sendTemplate(cfg.waPhoneId, cfg.waToken, msg.phone, msg.template_name, tplLangAlt, comps);
        }
      } else if (msg.body) {
        // Enviar texto libre (dentro de ventana 24h)
        await sendText(cfg.waPhoneId, cfg.waToken, msg.phone, msg.body);
      } else {
        await supabase.rpc("bot_outbox_mark", {
          p_id: msg.id, p_status: "failed", p_error: "Sin body ni template",
        });
        failed++;
        continue;
      }

      // Marcar como enviado
      await supabase.rpc("bot_outbox_mark", {
        p_id: msg.id, p_status: "sent",
      });
      sent++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`Outbox ${msg.id} falló:`, errMsg);
      await supabase.rpc("bot_outbox_mark", {
        p_id: msg.id, p_status: "failed", p_error: errMsg.slice(0, 500),
      });
      failed++;
    }
  }

  return { sent, failed };
}

// ─── Saludo por plantilla (primer contacto tras N horas de silencio) ─
// Consulta `bot_historial_chat` para decidir si es el primer mensaje del
// cliente en la ventana. Si sí, se antepone un saludo fijo con el nombre.
async function esPrimerContacto(phone: string, umbralHoras: number): Promise<boolean> {
  const since = new Date(Date.now() - umbralHoras * 3600_000).toISOString();
  const { count } = await supabase
    .from("bot_historial_chat")
    .select("id", { count: "exact", head: true })
    .eq("telefono", phone)
    .eq("rol", "user")
    .gte("creado_en", since);
  // 0 → nadie escribió en la ventana; 1 → solo el mensaje que acabamos de
  // guardar. Los dos casos son "primer contacto".
  return (count ?? 0) <= 1;
}

/** Wrapping opcional del reply con saludo cuando hay primer contacto. Pablo, 15/10 (tanda de pruebas, mensaje 1): «¡Hola!» sin nombre. Antes decía «¡Hola {razón social}!»
 *  y la base sólo tiene la razón social (1.264 clientes, 35 % con sigla de empresa y el resto casi todo personas con el apellido primero: «¡Hola Quispe Gabriel Dario Josue!»). */
async function conSaludoSiCorresponde(
  reply: string,
  phone: string,
): Promise<string> {
  const raw = await getSetting("wa_saludo_umbral_horas");
  const umbral = Number(raw) || 6;
  if (umbral <= 0) return reply; // saludo desactivado
  const primero = await esPrimerContacto(phone, umbral);
  if (!primero) return reply;
  return `¡Hola!\n\n${reply}`;
}

// ─── Statuses de Meta (delivery reports) ───────────────────────────
// Idempotente por (wamid, status). Cloud API v20+ manda estos events dentro
// del mismo webhook, en value.statuses[]. Formato:
//   {
//     id: 'wamid.HBg…',
//     status: 'sent' | 'delivered' | 'read' | 'failed',
//     timestamp: '1700000000',
//     recipient_id: '5491125608669',
//     conversation: { id, expiration_timestamp, origin: {type} },
//     pricing: { billable, pricing_model, category, type },
//     errors: [{ code, title, message, error_data:{details} }]  // solo en failed
//   }
// deno-lint-ignore no-explicit-any
async function ingestStatuses(body: any): Promise<void> {
  const changes = body?.entry?.[0]?.changes ?? [];
  for (const change of changes) {
    if (change?.field !== "messages") continue;
    const statuses = change?.value?.statuses ?? [];
    // Número de Meta que mandó el mensaje (sql/076): separa al bot de otras salidas del mismo número/app.
    const meta = change?.value?.metadata ?? {};
    for (const s of statuses) {
      if (!s?.id || !s?.status) continue;
      const tsSec = Number(s.timestamp);
      const ts = Number.isFinite(tsSec) ? new Date(tsSec * 1000).toISOString() : new Date().toISOString();
      const convExpSec = Number(s?.conversation?.expiration_timestamp);
      const convExp = Number.isFinite(convExpSec) ? new Date(convExpSec * 1000).toISOString() : null;
      try {
        await supabase.from("wa_message_status").upsert({
          wamid: s.id,
          recipient_id: s.recipient_id ?? null,
          status: s.status,
          ts,
          conversation_id: s?.conversation?.id ?? null,
          conv_expiration: convExp,
          origin_type: s?.conversation?.origin?.type ?? null,
          pricing_category: s?.pricing?.category ?? null,
          pricing_type: s?.pricing?.type ?? null,
          errors: s?.errors ?? null,
          phone_number_id: meta.phone_number_id ?? null,
          display_phone_number: meta.display_phone_number ?? null,
          raw: s,
        }, { onConflict: "wamid,status", ignoreDuplicates: true });
      } catch (e) {
        console.error("[wa_message_status] insert falló:", e);
      }
    }
  }
}

// ─── Adjuntos ────────────────────────────────────────────────────────
// Decisión de Pablo (29/09): el bot NO rechaza adjuntos. Los recibe, los guarda y se los pasa a una
// persona, que le escribe al cliente. Nada de "no enviar adjuntos".
//
//   imagen / PDF / Excel / Word / CSV → baja de Meta, sube al bucket `wa-comprobantes`, fila en
//     `wa_comprobantes` (es la tabla de adjuntos: la usa el botón "Ver adjunto" de Tareas) y alerta:
//       · foto de una rotura o faltante (el texto o la charla de los últimos 30 min hablan de un
//         reclamo) → motivo `reclamo`
//       · comprobante de pago (el texto habla de pago/transferencia) → `comprobante_recibido`; el lector
//         automático corre sólo con `app_settings.wa_comprobantes_activo` = 1
//       · cualquier otro (lista de pedido en Excel, etc.) → `adjunto_recibido`
//   audio → con `app_settings.wa_audio_activo` = 1 se transcribe con Groq Whisper (_shared/transcribir.ts) y el texto entra al
//     flujo normal como si lo hubiera escrito (textoDeAudio, abajo). Si está apagado o falla: pide que lo escriba y avisa a una persona.
//   video / sticker → pide que lo escriba (no lo podemos ver) y avisa a una persona.
//
// Si falla la bajada o la subida, igual contesta y deja la alerta (sin archivo): la persona se lo pide
// de nuevo. Respeta kill switch y whitelist.

const MSG_ADJUNTO_RECIBIDO = "Recibimos tu archivo.\nUna persona lo revisa y te escribe por este medio.";
const MSG_ADJUNTO_RECLAMO = "Recibimos la foto.\nUna persona revisa el reclamo y te escribe por este medio.";
// Mensaje de respaldo: si no hay datos de Cobranzas cargados (ficha Empresas) el comprobante se confirma sin ellos.
const MSG_ADJUNTO_PAGO = "Recibimos tu comprobante.\nUna persona lo revisa y te confirma por este medio.";
// Pablo, 01/10: el comprobante de pago recibe los datos de Cobranzas de la marca (plantillas comprobante_recibido y
// comprobante_recibido_chef, _shared/plantillas-meta.ts). Un cliente sólo de Chef recibe los de Chef; el resto, los de Loekemeyer.
async function respuestaPago(esChef: boolean): Promise<string> {
  try {
    return respuestaComprobante(await datosEmpresas(), { lk: !esChef, chef: esChef }) ?? MSG_ADJUNTO_PAGO;
  } catch (e) {
    console.error("[adjunto] datos de Cobranzas:", e instanceof Error ? e.message : e);
    return MSG_ADJUNTO_PAGO;
  }
}
// Con la transcripción prendida el audio sí se intenta escuchar: si no se pudo (muy largo, ruido, límite de Groq), se pide por escrito.
const MSG_AUDIO_NO_ENTENDIDO = "No pudimos entender tu audio.\nEscribinos tu consulta en un mensaje y te respondemos.";
const MSG_ADJUNTO_AUDIO =
  "Por ahora no podemos escuchar audios ni ver videos.\nEscribinos tu consulta en un mensaje y te respondemos.";

// Lo que se guarda y se pasa a una persona. Audio, video y sticker quedan afuera.
const ADJUNTO_MIMES = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
// Mismo criterio que RE_RECLAMO de faq.ts, más "foto de la rotura".
const RE_ADJ_RECLAMO = /(c[oó]digos?\s+de\s+barras?|\betiquet|\brot[oa]s?\b|\bromp|fallad|defectuos|mal estado|da[ñn]ad|vino\s+mal|lleg\w*\s+mal|\bme\s+falt|\bfalt(a|an|aron)\b|incorrect|equivocad|reclam|golpead|abollad|partid|quebrad)/i;
const RE_ADJ_PAGO = /(comprobante|transfer|pagu[eé]|\bpago\b|deposit|abon[eé]|recibo de pago|cheque|echeq)/i;

interface AdjuntoMsg {
  from: string;
  msgId: string;
  type: string;
  name?: string;
  mediaId?: string;
  mediaMime?: string;
  mediaFilename?: string;
  caption?: string;
}

async function handleAdjunto(msg: AdjuntoMsg, cfg: Config, msgAudio?: string): Promise<void> {
  const phone = msg.from;

  // Kill switch / whitelist (mismo gate que handleMessage)
  const raw = await getSetting("wa_bot_solo_whitelist");
  const soloWhitelist = Number(raw ?? "1") === 1;
  if (soloWhitelist && !(await estaEnWhitelist(phone))) {
    console.warn(`[whitelist-gate] adjunto de ${phone} descartado.`);
    await avisarDescartePorWhitelist(phone, {
      motivo: "whitelist_gate", origen: "adjunto", tipo_adjunto: msg.type, contact_name: lineaSegura(msg.name, 80) || null,
    });
    return;
  }

  markRead(cfg.waPhoneId, cfg.waToken, msg.msgId).catch(() => {});

  // Loggear entrada en historial (aparece en Conversaciones)
  const historialLabel = msg.caption
    ? `[ADJUNTO ${msg.type.toUpperCase()}] ${msg.caption}`
    : `[ADJUNTO ${msg.type.toUpperCase()}]`;
  try {
    await supabase.rpc("bot_guardar_mensaje", { p_telefono: phone, p_rol: "user", p_contenido: historialLabel });
  } catch (e) { console.error("adjunto: log inbound falló", e); }

  const responder = async (texto: string) => {
    try {
      await enviarTexto(cfg, phone, texto);
      await supabase.rpc("bot_guardar_mensaje", { p_telefono: phone, p_rol: "assistant", p_contenido: texto });
    } catch (e) { console.error("adjunto: respuesta falló", e); }
  };
  const customer = await getCustomerContext(phone);
  // Cliente sólo de Chef (sql/115): la alerta dice de qué cuenta de Chef es. Su código NO va a wa_comprobantes.cod_cliente
  // (ese campo es un código de Loekemeyer: el mismo número es otro cliente en cada empresa).
  const chef = customer ? null : await cuentaChef(phone);
  const alerta = async (tipo: string, contexto: Record<string, unknown>) => {
    try {
      await supabase.from("wa_alertas_humano").insert({
        tipo, phone, customer_id: customer?.customer_id ?? null,
        contexto: { wamid: msg.msgId, tipo_adjunto: msg.type, contact_name: lineaSegura(msg.name, 80) || null,
          caption: msg.caption ?? null, texto: msg.caption ?? null,
          ...(chef ? { empresa: "CH", cod_cliente_chef: chef.cod_cliente, cuit: chef.cuit, razon_social: chef.razon_social } : {}),
          ...contexto },
      });
    } catch { /* fire-and-forget */ }
  };

  // ── Audio / video / sticker: no se guardan; se pide por escrito ──
  const mime = (msg.mediaMime ?? "").toLowerCase().split(";")[0].trim();
  const esGuardable = msg.type === "image" ? true
    : msg.type === "document" ? (ADJUNTO_MIMES.has(mime) || /\.(xlsx?|csv|pdf|docx?|jpe?g|png|webp)$/i.test(msg.mediaFilename ?? ""))
    : false;
  if (!esGuardable) {
    await responder(msg.type === "audio" && msgAudio ? msgAudio : MSG_ADJUNTO_AUDIO);
    if (msg.type !== "sticker") await alerta("adjunto_recibido", { motivo: "adjunto_recibido", sin_archivo: "audio_video", mime });
    return;
  }

  // ── Qué es: reclamo con foto, comprobante de pago u otro archivo ──
  let charla = msg.caption ?? "";
  try {
    const desde = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: prev } = await supabase.from("wa_conversations").select("body")
      .like("phone", `%${phone.replace(/\D/g, "").slice(-10)}`).eq("direction", "in").gte("created_at", desde)
      .order("created_at", { ascending: false }).limit(5);
    charla += " " + (prev ?? []).map((r) => String(r.body ?? "")).join(" ");
  } catch { /* sin contexto: se clasifica por el texto del adjunto */ }
  const esFoto = msg.type === "image" || /^image\//.test(mime);
  const clase: "reclamo" | "pago" | "otro" =
    esFoto && RE_ADJ_RECLAMO.test(charla) ? "reclamo"
    : RE_ADJ_PAGO.test(charla) && (esFoto || mime === "application/pdf") ? "pago"
    : "otro";
  const tipoAlerta = clase === "pago" ? "comprobante_recibido" : clase === "reclamo" ? "reclamo" : "adjunto_recibido";
  const motivo = clase === "reclamo" ? "reclamo" : clase === "pago" ? undefined : "adjunto_recibido";
  const respuesta = clase === "reclamo" ? MSG_ADJUNTO_RECLAMO : clase === "pago" ? await respuestaPago(!!chef) : MSG_ADJUNTO_RECIBIDO;

  // ── Guardar el archivo (si algo falla, la persona se lo pide de nuevo) ──
  const codCliente = customer?.cod_cliente ? String(customer.cod_cliente) : null;
  let comprobanteId: string | null = null;
  let falla: string | null = null;
  let storagePath: string | null = null;
  let archivo: { bytes: Uint8Array; mime: string } | null = null;
  if (!msg.mediaId) falla = "sin_media_id";
  else {
    try {
      const download = await downloadMediaFromMeta(msg.mediaId, cfg.waToken);
      archivo = { bytes: download.bytes, mime: download.mime };
      const ext = extFromMime(download.mime) || extFromFilename(msg.mediaFilename) || "bin";
      storagePath = `${codCliente ?? phone}/${new Date().toISOString().slice(0, 7)}/${msg.msgId}.${ext}`;
      const up = await supabase.storage.from("wa-comprobantes").upload(storagePath, download.bytes,
        { contentType: download.mime, upsert: true });
      if (up.error) throw new Error("upload_bucket: " + up.error.message);
      const { data: ins, error: insErr } = await supabase.from("wa_comprobantes").insert({
        wamid: msg.msgId, phone, cod_cliente: codCliente, caption: msg.caption ?? null,
        storage_path: storagePath, mime_type: download.mime, size_bytes: download.fileSize,
        status: clase === "pago" ? "pending" : "no_comprobante",
      }).select("id").maybeSingle();
      if (insErr) throw new Error("insert: " + insErr.message);
      comprobanteId = ins?.id ?? null;
    } catch (e) {
      falla = e instanceof Error ? e.message : String(e);
      console.error("[adjunto] no se pudo guardar:", falla);
    }
  }

  // El lector automático de comprobantes sólo corre con el flag encendido.
  if (comprobanteId && clase === "pago" && Number((await getSetting("wa_comprobantes_activo")) ?? "0") === 1) {
    triggerParser(comprobanteId).catch((e) =>
      console.error("[adjunto] trigger parser falló:", e instanceof Error ? e.message : e));
  }

  // Pablo, 06/10: la constancia de inscripción de ARCA (PDF con texto) de alguien que todavía no es cliente se lee por REGLAS, sin IA
  // (_shared/constancia.ts): el bot le muestra lo que leyó, y con su "sí" completa CUIT, razón social e IVA del alta (_shared/alta.ts).
  // Si no se puede leer (foto, escaneo, otro PDF), sigue como siempre: lo guarda y lo revisa una persona. Con un alta en curso, además,
  // se le repite la pregunta que quedó pendiente: antes mandar un archivo lo dejaba parado en el mismo paso.
  let leadEnCurso: Awaited<ReturnType<typeof getPendingLead>> = null;
  if (!customer && !chef) {
    try {
      leadEnCurso = await getPendingLead(phone);
      const esPdf = mime === "application/pdf" || /\.pdf$/i.test(msg.mediaFilename ?? "");
      if (esPdf && archivo) {
        const datos = await leerConstancia(archivo.bytes);
        if (datos) {
          await procesarConstancia(phone, datos, storagePath, responder);
          return;
        }
      }
    } catch (e) {
      console.error("[adjunto] constancia:", e instanceof Error ? e.message : e);
    }
  }

  // Pablo, 14/10 (Fase A): una FOTO de un cliente que no es reclamo ni pago se pasa primero por visión (_shared/vision-producto.ts).
  // Desde el 16/10 describe con Haiku (Pablo: "saca gemini de toda ecuacion" — Gemini free tardaba 9-11 s y devolvía vacío). Según lo que ve:
  //  · producto dañado → reclamo (no se lee como pedido);
  //  · un producto → el agente lo busca y le ofrece opciones con fotos (reusa buscar_productos + enviar_fotos_producto);
  //  · una LISTA escrita o no se pudo ver (sin_vision) → sigue el flujo de pedido por archivo de abajo, como siempre.
  // Antes toda foto de cliente caía en leerPedidoArchivo (esArchivoDePedido matchea image/*): una foto de un solo artículo salía mal leída.
  let visionDiag: { tipo: string; raw: string | null } | null = null;
  if (clase === "otro" && customer && esFoto && archivo) {
    const tVis = Date.now();
    const vista = await describirFotoProducto(archivo.bytes, archivo.mime, cfg.anthropicKey, phone);
    visionDiag = { tipo: vista.tipo, raw: lineaSegura((vista as { raw?: string }).raw ?? "", 160) || null, ms_vision: Date.now() - tVis };
    if (vista.tipo === "danado") {
      await responder(MSG_ADJUNTO_RECLAMO);
      await alerta("reclamo", { motivo: "reclamo", visto: "producto_danado", comprobante_id: comprobanteId, mime });
      return;
    }
    // Pablo, 16/10: comprobante de pago mandado como FOTO SIN texto. RE_ADJ_PAGO no lo pudo clasificar (necesita texto),
    // la visión gratis (Gemini) sí lo reconoce. Misma respuesta que el camino "pago" por texto (respuestaPago → Cobranzas).
    // El comprobante se guardó arriba como "no_comprobante" (clase="otro"): lo pasamos a "pending" y avisamos como comprobante.
    if (vista.tipo === "comprobante") {
      await responder(await respuestaPago(!!chef));
      if (comprobanteId) {
        await supabase.from("wa_comprobantes").update({ status: "pending" }).eq("id", comprobanteId);
        // El lector pago sólo corre con el flag encendido, igual que el camino por texto (no gasta si está apagado).
        if (Number((await getSetting("wa_comprobantes_activo")) ?? "0") === 1) {
          triggerParser(comprobanteId).catch((e) =>
            console.error("[adjunto] trigger parser (visión) falló:", e instanceof Error ? e.message : e));
        }
      }
      await alerta("comprobante_recibido", { motivo: "comprobante_vision", comprobante_id: comprobanteId, mime });
      return;
    }
    // El agente es producción (modelo real): respeta el tope de gasto diario. Ya no se corta (Pablo, 14/10): pasado el tope contesta igual, pero degradado (sólo modelos gratis / Haiku).
    if (vista.tipo === "busqueda") {
      // Pablo, 16/10: "quiero que me encuentre el modelo exacto". Describir no alcanza (trae la categoría entera), así que si está
      // seteado wa_match_foto_modelo se compara la foto del cliente contra las fotos de los candidatos del catálogo (match-foto-producto.ts,
      // visión PAGA, por eso gateado). El código reconocido se le pasa al agente para que ofrezca ESE, en vez de dejarlo que pregunte "¿cuál?".
      let instruccion = `Te mando una foto de un producto que estoy buscando. En la foto se ve: ${vista.terminos}. ¿Qué tenés parecido? Mostrame opciones con la foto.`;
      let matchDiag: Record<string, unknown> | null = null;
      const matchModelo = ((await getSetting("wa_match_foto_modelo")) ?? "").trim();
      if (matchModelo && archivo) {
        try {
          const t0 = Date.now();
          const { data: cands } = await supabase.rpc("bot_buscar_productos", { p_query: vista.terminos, p_limit: 20 });
          const filas = ((cands ?? []) as Array<{ cod: unknown; description: unknown }>)
            .map((row) => ({ cod: String(row.cod ?? "").trim(), description: String(row.description ?? "") }))
            .filter((r) => r.cod).slice(0, MAX_CANDIDATOS);
          // Las URLs de las fotos se piden EN PARALELO (antes era un for secuencial: 6 RPC una atrás de otra).
          const conUrl = await Promise.all(filas.map(async (r) => {
            const { data: imgs } = await supabase.rpc("bot_obtener_imagenes_producto", { p_cod: r.cod });
            const url = (imgs as Array<{ image_urls?: string[] }> | null)?.[0]?.image_urls?.[0];
            return url ? { cod: r.cod, description: r.description, url } : null;
          }));
          const candidatos: CandidatoFoto[] = conUrl.filter((c): c is CandidatoFoto => !!c);
          const msCandidatos = Date.now() - t0;
          if (candidatos.length) {
            const t1 = Date.now();
            const m = await matchFotoProducto(cfg.anthropicKey, { bytes: archivo.bytes, mime: archivo.mime }, candidatos, matchModelo, phone);
            matchDiag = { modelo: matchModelo, cod: m.cod, confianza: m.confianza, alternativas: m.alternativas, gasto_usd: m.gasto_usd, raw: m.raw || null,
              ms_candidatos: msCandidatos, ms_match: Date.now() - t1, candidatos: candidatos.length };
            // Pablo, 16/10: cuando NO está seguro, el mensaje abre con una intro ("no puedo distinguir bien cuál es, te mando las imágenes
            // de los posibles") ANTES de las fotos; sólo con confianza alta ofrece el artículo directo.
            if (m.cod && m.confianza === "alta") {
              const desc = candidatos.find((c) => c.cod === m.cod)?.description ?? "";
              const otros = m.alternativas.length ? m.alternativas.join(" o ") : "";
              instruccion = `Te mando una foto de un producto. [Sistema: la foto coincide con el código ${m.cod} (${desc}). Ofrecé ESE artículo, mostrá su foto y confirmá que es el que busca; si pide stock o precio, consultá la herramienta.${otros ? ` Si dice que no es, el otro parecido es el código ${otros}.` : ""}]`;
            } else {
              // Confianza media/baja (m.cod con dudas) o sin match (cod null): se ofrecen los posibles con una intro de que no se distingue.
              const posibles = m.cod ? [m.cod, ...m.alternativas] : candidatos.slice(0, 4).map((c) => c.cod);
              instruccion = `Te mando una foto de un producto. [Sistema: no se pudo distinguir con certeza cuál es. EMPEZÁ tu respuesta con una línea diciendo que no podés distinguir bien cuál es y que le mandás las imágenes de los artículos posibles. Después mostrá con la foto estos códigos: ${posibles.join(", ")} y pedile que confirme cuál es mirando las imágenes. NO afirmes cuál es.]`;
            }
          }
        } catch (e) { console.error("[match-foto] webhook:", e instanceof Error ? e.message : e); }
      }
      // El agente es producción (modelo real): respeta el tope de gasto diario. Ya no se corta (Pablo, 14/10): pasado el tope contesta igual, pero degradado (sólo modelos gratis / Haiku).
      const nivelG = (await nivelGastoDiario()).nivel;
      const degradado = nivelG === "degradar" || nivelG === "escalar";
      iaEmpieza(phone);
      const result = await runConversation(
        instruccion,
        phone, customer.business_name, customer.cod_cliente, customer.dto_vol, cfg.anthropicKey, "lk_whatsapp-webhook",
        { degradado },
      ).finally(() => iaTermina(phone));
      if (result.timeout || result.llmError) {
        await avisarIaCaida(cfg, phone);
        return;
      }
      // Texto PRIMERO (así la intro "no puedo distinguir…" va antes de las fotos), partido por [[corte]] como el camino normal
      // del agente: antes esta rama mandaba result.reply crudo y el marcador [[corte]] se filtraba al cliente (Pablo, 16/10).
      const partesFoto = partirRespuesta(result.reply ?? "");
      for (const parte of partesFoto) await enviarTexto(cfg, phone, parte);
      if (partesFoto.length) await supabase.rpc("bot_guardar_mensaje", { p_telefono: phone, p_rol: "assistant", p_contenido: partesFoto.join("\n\n") });
      if (result.media.length) await sendMediaActions(result.media, phone, cfg);
      await alerta("adjunto_recibido", { motivo: "foto_producto", vision: vista.terminos,
        ...(visionDiag ? { ms_vision: visionDiag.ms_vision } : {}),
        ...(matchDiag ? { match: matchDiag } : {}), comprobante_id: comprobanteId, mime });
      return;
    }
    // "lista" / "sin_vision": sigue el flujo de pedido por archivo de abajo.
  }

  // Pablo, 29/09: un Excel, CSV, foto o PDF de un cliente que no es reclamo ni pago se lee como PEDIDO: la IA arma la lista,
  // se la mostramos para que confirme y la tarea sale con la lista para cargar (_shared/pedido-archivo.ts).
  let respuestaFinal = respuesta;
  let motivoFinal = motivo;
  let lectura: Record<string, unknown> = {};
  // Pablo, 14/10: el tope de gasto ya no corta. Un archivo de pedido es toma de pedidos (exenta de degradar, lleva plata), así que se lee siempre con su modelo fijo.
  if (clase === "otro" && customer && archivo && esArchivoDePedido(archivo.mime, msg.mediaFilename)) {
    try {
      const r = await leerPedidoArchivo(archivo.bytes, archivo.mime, cfg.anthropicKey, phone, msg.mediaFilename);
      // Pablo, 07/10: el texto crudo de la planilla se escaneó ANTES de la IA. Si trae algo que parece una orden para el bot, se avisa a Auditoría (dashboard) aunque la IA
      // la haya descartado en silencio, y el pedido lleva la marca para que Ventas revise el archivo original.
      const sospechaCruda = r.escaneo?.sospechoso === true;
      if (r.escaneo && sospechaCruda) {
        await avisarArchivoSospechoso(phone, customer, msg.mediaFilename, r.escaneo, r.lineas.some((l) => l.sospechosa === true), comprobanteId);
      }
      if (r.lineas.length) {
        const arts = await resolverArticulos(r.lineas, cfg.anthropicKey, phone);
        const cotizador = r.cotizador === true || /cotiz/i.test(msg.caption ?? "");
        // Pablo, 06/10 (m41): el cotizador trae los precios: se comparan con los de la web y se le pide confirmar artículo y valor.
        // Pablo, 07/10 (m41): con el código del cliente, una cadena con lista de precios propia no se compara por PRECIO (falsa alarma de "cotizador desactualizado").
        const cmp = await compararCotizadorConWeb(r.hoja, customer.cod_cliente).catch((e) => { console.error("[adjunto] comparación de precios:", e instanceof Error ? e.message : e); return null; });
        // Pablo, 06/10 (m41): con varias direcciones de entrega hay que preguntarle para cuál es el pedido ("eso es muy importante").
        const sucursales = await sucursalesDelCliente(customer.customer_id).catch(() => []);
        respuestaFinal = textoConfirmacion(arts, { cotizador, seguir: await pedidosWaHabilitados(), condicion_code: r.condicion_code,
          comparacion: cmp ? { texto: cmp.texto, hayDiferencias: cmp.diferencias.length > 0 } : null, sucursales });
        motivoFinal = "pedido_archivo";
        // Una línea del archivo que parecía una orden para el bot (dato-externo.ts) se avisa en la tarea: Ventas ve que el archivo trae texto raro.
        lectura = { articulos: arts, cotizador, ...(sospechaCruda || arts.some((a) => a.sospechosa) ? { texto_sospechoso: true } : {}), ...(r.condicion_code ? { condicion_code: r.condicion_code } : {}),
          ...(sucursales.length > 1 ? { sucursales_ofrecidas: sucursales.map((x) => x.slot) } : {}),
          ...(cmp ? { comparacion_precios: { diferencias: cmp.diferencias, total_cotizador: cmp.total_cotizador, version: cmp.version, ...(cmp.precio_omitido_cadena ? { precio_omitido_cadena: cmp.precio_omitido_cadena } : {}) } } : {}) };
      } else lectura = { lectura_error: r.error ?? "no se encontraron líneas de pedido", ...(sospechaCruda ? { texto_sospechoso: true } : {}) };
    } catch (e) {
      lectura = { lectura_error: e instanceof Error ? e.message : String(e) };
      console.error("[adjunto] no se pudo leer el pedido:", lectura.lectura_error);
    }
  } else if (clase === "otro" && customer && archivo && esArchivoDePedido(archivo.mime, msg.mediaFilename)) {
    // Sólo se llega acá si el tope de gasto diario está alcanzado (lo único que falló en la condición de arriba): el archivo queda para una persona.
    lectura = { lectura_error: "tope de gasto diario de IA alcanzado: el archivo no se leyó con IA, lo revisa una persona" };
  }

  if (leadEnCurso) {
    const sig = promptActual(leadEnCurso);
    if (sig) respuestaFinal += `\n\nMientras tanto seguimos con el alta:\n${sig}`;
  }
  await responder(respuestaFinal);
  await alerta(tipoAlerta, {
    ...(motivoFinal ? { motivo: motivoFinal } : {}), ...lectura,
    comprobante_id: comprobanteId, mime, archivo: lineaSegura(msg.mediaFilename, 120) || null,
    ...(falla ? { error_archivo: falla } : {}),
    ...(visionDiag ? { vision_tipo: visionDiag.tipo, vision_raw: visionDiag.raw } : {}),
  });
}

/**
 * Pablo, 07/10: aviso de AUDITORÍA cuando el texto crudo de una planilla del cliente parece una orden para el bot (Centro de mensajes › Tareas › Auditoría).
 * Una sola vez por número y por hora (VENTANA_AVISO_MS): el archivo de pedido de cada envío sigue llevando su propia marca. Nunca lanza: un fallo acá no puede frenar la
 * lectura del pedido. Va sólo al dashboard: no le habla a nadie por WhatsApp.
 */
async function avisarArchivoSospechoso(phone: string, customer: { customer_id?: string | null; business_name?: string | null } | null | undefined,
  archivo: string | undefined, escaneo: Parameters<typeof contextoAlertaArchivo>[0]["escaneo"], iaLaCopio: boolean, comprobanteId: string | null): Promise<void> {
  try {
    const { data } = await supabase.from("wa_alertas_humano").select("id").eq("phone", phone).eq("contexto->>origen", MOTIVO_ARCHIVO_SOSPECHOSO)
      .gte("created_at", new Date(Date.now() - VENTANA_AVISO_MS).toISOString()).limit(1);
    if ((data ?? []).length > 0) return;
    console.warn(`[archivo-sospechoso] planilla con texto que parece una orden (${escaneo.motivos.join(", ")}) …${phone.slice(-4)}`);
    await notificarHumano({
      tipo: "otro", phone, customerId: customer?.customer_id ?? null,
      contexto: contextoAlertaArchivo({ archivo, escaneo, iaLaCopio, razonSocial: customer?.business_name ?? null, comprobanteId }),
    });
  } catch (e) {
    console.error("[archivo-sospechoso] no se pudo avisar:", e instanceof Error ? e.message : e);
  }
}

/**
 * Pablo, 01/10: el audio de un cliente se transcribe (Groq Whisper, _shared/transcribir.ts) y el texto se procesa como un
 * mensaje escrito. `texto` null = no hay transcripción (llave apagada, número fuera de la whitelist o en la blacklist, formato
 * que no se lee, muy largo, límite o falla de Groq); `intentado` dice si se llegó a probar, para elegir qué se le contesta.
 * Mismos candados que handleMessage ANTES de bajar el audio: un número no autorizado no gasta cuota de transcripción ni
 * manda su audio a un tercero.
 */
async function textoDeAudio(msg: AdjuntoMsg, cfg: Config): Promise<{ texto: string | null; intentado: boolean }> {
  try {
    if (!(await audioActivo())) return { texto: null, intentado: false };
    const phone = msg.from;
    const soloWhitelist = Number((await getSetting("wa_bot_solo_whitelist")) ?? "1") === 1;
    if (soloWhitelist && !(await estaEnWhitelist(phone))) return { texto: null, intentado: false };
    if (await blacklistRow(phone)) return { texto: null, intentado: false };
    if (!msg.mediaId) return { texto: null, intentado: true };
    const dl = await downloadMediaFromMeta(msg.mediaId, cfg.waToken);
    const r = await transcribirAudio(dl.bytes, dl.mime, phone);
    if (r.ok) return { texto: r.texto, intentado: true };
    console.warn(`[audio] no se pudo transcribir (${r.motivo})`);
    return { texto: null, intentado: true };
  } catch (e) {
    console.error("[audio] falló:", e instanceof Error ? e.message : e);
    return { texto: null, intentado: true };
  }
}

function extFromMime(mime: string): string | null {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("spreadsheetml")) return "xlsx";
  if (m.includes("ms-excel")) return "xls";
  if (m.includes("csv")) return "csv";
  if (m.includes("wordprocessingml")) return "docx";
  if (m.includes("msword")) return "doc";
  return null;
}
function extFromFilename(name?: string): string | null {
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

/**
 * Dispara `lk_parse-comprobante` con action=parse. Fire-and-forget: no espera
 * la respuesta, así el webhook contesta a Meta rápido. El resultado queda en
 * la fila `wa_comprobantes` que ya fue insertada.
 */
async function triggerParser(comprobanteId: string): Promise<void> {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/lk_parse-comprobante`;
  // Es el SERVICE ROLE, no la anon key: se llamaba `anonKey` y eso confundía a cualquiera que
  // leyera esto (lo marcó la auditoría del 07/09). Y ahora además es lo que usa
  // `lk_parse-comprobante` para reconocer que la llamada es interna nuestra.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ action: "parse", comprobante_id: comprobanteId }),
  });
  if (!res.ok) {
    console.error(`[triggerParser] ${res.status}:`, (await res.text()).slice(0, 300));
  }
}

// ─── Kill switch por whitelist ─────────────────────────────────────
// Mientras la app está en modo "testing/rollout controlado", el bot solo
// responde a números en `wa_envio_contactos`. Cuando se decida activar
// para todos los clientes, poner `app_settings.wa_bot_solo_whitelist = 0`.
/**
 * v14.13 — punto 16 de la auditoría del 07/09. Los dos gates de whitelist insertaban una fila en
 * `wa_alertas_humano` **por cada mensaje descartado**: un número fuera de la lista que escribe
 * veinte veces deja veinte alertas idénticas, y la tabla crece sin techo. Lo que se quiere saber
 * es *qué números intentaron*, no cuántas veces — así que se guarda una por teléfono y por día.
 *
 * v2 (2026-09-09) — el techo por día no alcanzaba: seguían entrando como `tipo='otro'` y
 * `estado='pendiente'`, o sea a la MISMA cola que un comprobante que falló. Medido el 09/09:
 * 633 alertas pendientes, **631 de ellas `whitelist_gate`** (99,7%), de 73 teléfonos de los que
 * **uno solo es cliente**. 534 salieron de un único evento el 03/09 15:22 — una encuesta mandada
 * desde esa línea que contestaron 54 personas ("35/40min", "2 hs", "A"/"B"): tráfico ajeno al bot.
 * Con eso, la cola de "atender a mano" era 99% ruido y lo poco real quedaba enterrado.
 *
 * Ahora se separa por QUIÉN escribió, que es lo único que cambia si hay que hacer algo:
 *
 *   · teléfono que resuelve a un cliente → `estado='pendiente'`. Un cliente real escribió y el
 *     bot no le contestó por la whitelist: eso sí lo tiene que ver alguien.
 *   · cualquier otro                     → `estado='descartado'`. Queda registrado (para saber
 *     qué números intentaron) pero no ensucia la cola.
 *
 * Y va con `tipo='whitelist_gate'` en vez de `'otro'`, para poder filtrarlo sin leer el jsonb.
 * `descartado` ya estaba en el CHECK de `estado` (sql/044), así que no hace falta tocar la tabla.
 */
async function avisarDescartePorWhitelist(
  phone: string,
  contexto: Record<string, unknown>,
  // Si el que llama ya identificó al cliente (handleMessage lo hace junto con los otros candados), no se vuelve a consultar.
  yaIdentificado?: CustomerContext | null,
): Promise<void> {
  try {
    const desde = new Date(); desde.setUTCHours(0, 0, 0, 0);
    const { count } = await supabase
      .from("wa_alertas_humano")
      .select("id", { count: "exact", head: true })
      .eq("phone", phone)
      .eq("contexto->>motivo", "whitelist_gate")
      .gte("created_at", desde.toISOString());
    if ((count ?? 0) > 0) return;   // ya quedó registrado hoy

    // Si falla la identificación, se asume que NO es cliente: mejor un aviso de menos en la cola
    // que volver a llenarla de ruido. La fila queda igual, con el teléfono, para poder revisarla.
    let cliente: CustomerContext | null = yaIdentificado ?? null;
    if (yaIdentificado === undefined) {
      try { cliente = await getCustomerContext(phone); } catch { /* no identificado */ }
    }

    await supabase.from("wa_alertas_humano").insert({
      tipo: "whitelist_gate",
      phone,
      customer_id: cliente?.customer_id ?? null,
      estado: cliente ? "pendiente" : "descartado",
      contexto: { ...contexto, es_cliente: !!cliente, cod_cliente: cliente?.cod_cliente ?? null },
    });
  } catch { /* fire-and-forget: no puede frenar el descarte */ }
}

async function estaEnWhitelist(phone: string): Promise<boolean> {
  // Match por los últimos 10 dígitos (mismo criterio que wa_identify_customer y wa_puede_enviar).
  // El inbound de Meta llega con el 9 argentino (5491131181027) y la whitelist puede estar cargada
  // sin él (541131181027): comparar el string completo con .eq("phone") descartaba en silencio a un
  // número que SÍ estaba en la whitelist, y el bot nunca le contestaba. La tabla es chica, así que
  // traer todas las filas y comparar normalizado no pesa.
  const t = (phone ?? "").replace(/\D/g, "").slice(-10);
  if (t.length < 10) return false;
  const { data } = await supabase.from("wa_envio_contactos").select("phone");
  return (data ?? []).some((r) => String(r.phone ?? "").replace(/\D/g, "").slice(-10) === t);
}

/** Fila de `wa_blacklist` del número, o null si no está. `avisado_at` marca si ya se le
 *  mandó el aviso de "fuera de servicio" (para avisar UNA vez y después silencio). (sql/012) */
async function blacklistRow(phone: string): Promise<{ avisado_at: string | null } | null> {
  const { data, error } = await supabase
    .from("wa_blacklist")
    .select("phone, avisado_at")
    .eq("phone", phone)
    .maybeSingle();
  // Ante un error de lectura NO bloqueamos: es preferible atender de más que dejar
  // mudo a un cliente legítimo porque falló una consulta.
  if (error) { console.error("[blacklist] no pude consultar:", error.message); return null; }
  return data ? { avisado_at: (data.avisado_at as string | null) ?? null } : null;
}

/**
 * Tope de CONSULTAS AL AGENTE (IA) por hora y por teléfono (`wa_check_rate_limit`, sql/012).
 * Se llama sólo en el paso 6 (justo antes de `runConversation`), así que el contador de
 * `wa_rate_limit` cuenta únicamente los mensajes que llegan al agente — no las FAQ/AUTO ni
 * los flujos deterministas. Apagado por defecto: sólo corre si `wa_rate_limit_enabled = 1`.
 *
 * Devuelve null si puede seguir. Si pasó el tope devuelve `{ avisar }`, donde
 * `avisar` es true SÓLO en el primer mensaje por encima del tope: si no, cada
 * mensaje de más dispara otro aviso y el tope termina generando más tráfico del
 * que corta. Se mira `bot_historial_chat` para saber en cuál está.
 */
async function pasoElTope(phone: string): Promise<{ avisar: boolean; limite: number } | null> {
  const habilitado = Number((await getSetting("wa_rate_limit_enabled")) ?? "0") === 1;
  if (!habilitado) return null;
  const limite = Number(await getSetting("wa_rate_limit_per_hour")) || 20;
  const { data: bloqueado, error } = await supabase
    .rpc("wa_check_rate_limit", { p_phone: phone, p_limit: limite });
  if (error) { console.error("[rate-limit] no pude consultar:", error.message); return null; }
  if (bloqueado !== true) return null;
  // El contador lo lleva la RPC en `wa_rate_limit`, por hora de reloj (date_trunc), y ya
  // sumó el mensaje de ahora. El primero que pasa el tope es el que deja el contador en
  // `limite + 1`: sólo ese avisa. No se recalcula por otro lado para no tener dos ventanas
  // distintas diciendo cosas distintas.
  const { data: fila } = await supabase
    .from("wa_rate_limit")
    .select("msg_count")
    .eq("phone", phone)
    .order("window_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  return { avisar: Number(fila?.msg_count ?? 0) === limite + 1, limite };
}

/**
 * Tope de GASTO GLOBAL DIARIO de IA (Pablo, 07/10: "dejalo en US$ 2 con aviso a US$ 1"). El tope por hora de arriba es por número y no hay techo total.
 * Cuenta sólo lo que gastan los CLIENTES (bot_token_usage del webhook; el Simulador no), el día es el de Argentina y ante un error de lectura NO bloquea.
 * Detalle, montos y por qué en _shared/tope-gasto.ts.
 */
let cacheGasto: { hasta: number; usd: number } | null = null;
async function gastoClientesHoy(): Promise<number | null> {
  if (cacheGasto && cacheGasto.hasta > Date.now()) return cacheGasto.usd;
  const desde = new Date(inicioDiaArgentina(Date.now())).toISOString();
  // Sólo las filas con costo: las del modelo gratis (US$ 0) son la mayoría y no suman. Diez mil filas pagas en un día serían miles de dólares: el tope saltó mucho antes.
  const { data, error } = await supabase.from("bot_token_usage").select("estimated_cost_usd")
    .eq("function_name", FUNCION_CLIENTES).gt("estimated_cost_usd", 0).gte("created_at", desde).limit(10000);
  if (error) { console.error("[tope-gasto] no pude leer el gasto:", error.message); return null; }
  const usd = sumarGasto(data ?? []);
  cacheGasto = { hasta: Date.now() + CACHE_GASTO_MS, usd };
  return usd;
}

async function nivelGastoDiario(): Promise<{ nivel: NivelGasto; gasto: number; topes: Topes }> {
  const sinTope = { nivel: "ok" as NivelGasto, gasto: 0, topes: topesDeSettings(null, null) };
  try {
    const topes = topesDeSettings(await getSetting("ia_tope_gasto_usd"), await getSetting("ia_aviso_gasto_usd"), await getSetting("ia_tope_escalar_usd"));
    if (!(topes.tope > 0)) return { nivel: "ok", gasto: 0, topes }; // apagado con 0: ni siquiera se lee el gasto
    const gasto = await gastoClientesHoy();
    if (gasto === null) return { nivel: "ok", gasto: 0, topes };
    return { nivel: nivelDeGasto(gasto, topes), gasto, topes };
  } catch (e) {
    // Una excepción acá llegaría al handler y el webhook devolvería 500: Meta reintentaría el mensaje. Se atiende de más antes que dejar mudo a un cliente.
    console.error("[tope-gasto] falló la lectura del gasto, se sigue sin tope:", e instanceof Error ? e.message : e);
    return sinTope;
  }
}

/** ¿Ya hay hoy una alerta `tope_gasto` de ese nivel (con `phone`, de ese número)? Ante un error dice que sí: ante la duda no se repite ni al equipo ni al cliente. */
async function alertaGastoDeHoy(nivel: "aviso" | "degradar" | "escalar", phone: string | null): Promise<boolean> {
  try {
    let q = supabase.from("wa_alertas_humano").select("id")
      .eq("contexto->>motivo", "tope_gasto").eq("contexto->>nivel", nivel)
      .gte("created_at", new Date(inicioDiaArgentina(Date.now())).toISOString());
    if (phone) q = q.eq("phone", phone);
    const { data, error } = await q.limit(1);
    if (error) { console.error("[tope-gasto] no pude leer las alertas de hoy:", error.message); return true; }
    return (data ?? []).length > 0;
  } catch (e) {
    console.error("[tope-gasto] falló la lectura de las alertas de hoy:", e instanceof Error ? e.message : e);
    return true;
  }
}

/** ¿Estamos DENTRO del horario de atención (Configuración › Derivaciones + feriados del calendario de Planify)? Ante un error dice que NO:
 *  la alerta de `escalar` es un extra y no vale la pena mandarla si no se pudo confirmar que hay gente. Nunca lanza. */
async function dentroDelHorarioDeAtencion(): Promise<boolean> {
  try {
    let guardado: unknown;
    try { guardado = JSON.parse((await getSetting("wa_derivaciones")) ?? "{}")?.horario; } catch { guardado = undefined; }
    const h = conCalendario(leerHorario(guardado), await cargarCalendario());
    return dentroDeHorario(new Date(), h);
  } catch (e) {
    console.error("[tope-gasto] no pude leer el horario de atención:", e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Se llama en el paso 6, justo antes de `runConversation`. NINGÚN nivel corta al agente (Pablo, 14/10: «que no corte»). Devuelve:
 *   • "ok"       → cadena normal.
 *   • "degradar" → el agente sigue pero sólo con modelos gratis / Haiku (lo aplica runConversation con la opción `degradado`). Alerta 1×/día.
 *   • "escalar"  → igual que degradar (sigue contestando), pero además, SÓLO si estamos en horario de atención, deja una alerta más para una persona.
 * Nunca lanza hacia arriba (notificarHumano y el resto se atajan). Las alertas son una por día.
 */
async function pasoElTopeDeGasto(
  phone: string, customer: { customer_id?: string | null; business_name?: string | null } | null, text: string,
): Promise<"ok" | "degradar" | "escalar"> {
  const e = await nivelGastoDiario();
  if (e.nivel === "ok") return "ok";
  const razon = customer?.business_name ?? null, cid = customer?.customer_id ?? null;
  if (e.nivel === "aviso") {
    // Una sola alerta por día, de cualquier número: el agente sigue con la cadena normal.
    if (!(await alertaGastoDeHoy("aviso", null))) {
      await notificarHumano({ tipo: "otro", phone, customerId: cid, contexto: contextoAlertaGasto("aviso", e.gasto, e.topes, text, razon) });
    }
    return "ok";
  }
  if (e.nivel === "degradar") {
    // Pasó el tope blando (Pablo, 14/10): el agente SIGUE pero sólo con modelos gratis (o Haiku si ninguno responde; el filtro de la cadena está en
    // bot-conversation.ts, opción `degradado`). No se corta ni se avisa al cliente: contesta normal. Una sola alerta por día, de cualquier número.
    if (!(await alertaGastoDeHoy("degradar", null))) {
      await notificarHumano({ tipo: "otro", phone, customerId: cid, contexto: contextoAlertaGasto("degradar", e.gasto, e.topes, text, razon) });
    }
    return "degradar";
  }
  // Escalar (Pablo, 14/10: «que no corte en 5, sino que dé un aviso a un humano si está dentro del horario de atención»): el agente NO se corta, sigue
  // degradado. Lo único que se agrega es una alerta para una persona, y SÓLO en horario de atención (fuera de horario nadie puede actuar). Una vez por día.
  if (await dentroDelHorarioDeAtencion()) {
    if (!(await alertaGastoDeHoy("escalar", null))) {
      await notificarHumano({ tipo: "otro", phone, customerId: cid, contexto: contextoAlertaGasto("escalar", e.gasto, e.topes, text, razon) });
    }
  }
  return "escalar";
}

/**
 * Medidor de PRESUPUESTO MENSUAL del pozo de IA (Pablo, 14/10: US$ 100/mes, avisos al 25/50/75/90/100%, "sólo avisa"). A diferencia del tope diario de
 * arriba, cuenta TODO el gasto del mes (no sólo clientes) porque el pozo de Anthropic se agota con todo, y NO corta nada: sólo deja una alerta para una
 * persona, una vez por umbral por mes. Detalle y por qué en _shared/presupuesto-ia.ts. Cacheado como el gasto diario (CACHE_GASTO_MS).
 */
let cacheGastoMes: { hasta: number; usd: number } | null = null;
async function gastoMesTotal(): Promise<number | null> {
  if (cacheGastoMes && cacheGastoMes.hasta > Date.now()) return cacheGastoMes.usd;
  const desde = new Date(inicioMesArgentina(Date.now())).toISOString();
  // Sólo las filas con costo (las del modelo gratis son US$ 0 y la mayoría): así la suma del mes se arma con pocas filas. TODOS los function_name.
  const { data, error } = await supabase.from("bot_token_usage").select("estimated_cost_usd").gt("estimated_cost_usd", 0).gte("created_at", desde).limit(50000);
  if (error) { console.error("[presupuesto] no pude leer el gasto del mes:", error.message); return null; }
  const usd = sumarGastoMes(data ?? []);
  cacheGastoMes = { hasta: Date.now() + CACHE_GASTO_MS, usd };
  return usd;
}

/** ¿Ya se avisó este mes por ESE umbral? (alerta `tope_gasto` nivel `presupuesto` con ese `umbral`, desde el inicio del mes ART). Ante un error dice que sí. */
async function avisoPresupuestoHecho(umbral: number): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("wa_alertas_humano").select("id")
      .eq("contexto->>motivo", "tope_gasto").eq("contexto->>nivel", "presupuesto").eq("contexto->>umbral", String(umbral))
      .gte("created_at", new Date(inicioMesArgentina(Date.now())).toISOString()).limit(1);
    if (error) { console.error("[presupuesto] no pude leer los avisos del mes:", error.message); return true; }
    return (data ?? []).length > 0;
  } catch (e) {
    console.error("[presupuesto] falló la lectura de los avisos del mes:", e instanceof Error ? e.message : e);
    return true;
  }
}

/**
 * Si el gasto del mes cruzó un umbral nuevo, deja UNA alerta para una persona (nivel `presupuesto`). Sólo avisa: no corta ni cambia la respuesta al
 * cliente. Nunca lanza hacia arriba (se llama sin bloquear el flujo). El presupuesto en 0 apaga todo: ni se lee el gasto.
 */
async function avisarPresupuesto(phone: string, customer: { customer_id?: string | null; business_name?: string | null } | null): Promise<void> {
  try {
    const presupuesto = presupuestoDeSettings(await getSetting("ia_presup_mensual_usd"));
    if (!(presupuesto > 0)) return; // apagado
    const gasto = await gastoMesTotal();
    if (gasto === null) return;
    const umbrales = umbralesDeSettings(await getSetting("ia_presup_umbrales"));
    const umbral = umbralCruzado(pctDelMes(gasto, presupuesto), umbrales);
    if (umbral === null) return; // todavía no se cruzó ningún umbral (lo normal casi todo el mes)
    if (await avisoPresupuestoHecho(umbral)) return; // ya se avisó por ese umbral este mes
    const pozo = pozoDeSettings(await getSetting("ia_presup_pozo_usd"));
    await notificarHumano({
      tipo: "otro", phone, customerId: customer?.customer_id ?? null,
      contexto: contextoAlertaPresupuesto(umbral, gasto, presupuesto, pozo),
    });
  } catch (e) {
    console.error("[presupuesto] falló el aviso de presupuesto, se sigue normal:", e instanceof Error ? e.message : e);
  }
}

/**
 * Tope de gasto de IA POR CLIENTE (Pablo, 14/10: US$ 2/día y US$ 5/semana por teléfono). A diferencia del tope diario global, frena SÓLO a ese cliente:
 * a los demás el agente les sigue contestando. Lo que gastó ese teléfono en la ventana (bot_token_usage del webhook). Detalle en _shared/tope-cliente.ts.
 */
async function gastoClienteVentana(phone: string, desdeMs: number): Promise<number | null> {
  const { data, error } = await supabase.from("bot_token_usage").select("estimated_cost_usd")
    .eq("function_name", FUNCION_CLIENTES).eq("phone", phone).gt("estimated_cost_usd", 0).gte("created_at", new Date(desdeMs).toISOString()).limit(10000);
  if (error) { console.error("[tope-cliente] no pude leer el gasto del cliente:", error.message); return null; }
  return sumarGasto(data ?? []);
}

/** ¿Ya hay hoy una alerta `tope_gasto` nivel `cliente` de ESTE teléfono? Una por día por cliente (como el tope diario). Ante un error dice que sí. */
async function alertaClienteDeHoy(phone: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("wa_alertas_humano").select("id")
      .eq("contexto->>motivo", "tope_gasto").eq("contexto->>nivel", "cliente").eq("phone", phone)
      .gte("created_at", new Date(inicioDiaArgentina(Date.now())).toISOString()).limit(1);
    if (error) { console.error("[tope-cliente] no pude leer las alertas de hoy:", error.message); return true; }
    return (data ?? []).length > 0;
  } catch (e) {
    console.error("[tope-cliente] falló la lectura de las alertas de hoy:", e instanceof Error ? e.message : e);
    return true;
  }
}

/**
 * Si ESTE cliente pasó su tope diario o semanal, no se llama al agente: recibe el aviso fijo (una vez por día) y se deja una alerta para una persona.
 * Devuelve "tope" para cortar. Ante un error al leer el gasto NO bloquea (como la blacklist y el tope diario). Nunca lanza hacia arriba.
 */
async function pasoElTopeCliente(
  cfg: Config, phone: string, customer: { customer_id?: string | null; business_name?: string | null } | null, text: string,
): Promise<"ok" | "tope"> {
  try {
    const topes = topesClienteDeSettings(await getSetting("ia_tope_cliente_dia_usd"), await getSetting("ia_tope_cliente_semana_usd"));
    if (!(topes.dia > 0) && !(topes.semana > 0)) return "ok"; // capa apagada
    const ahora = Date.now();
    const gastoDia = await gastoClienteVentana(phone, inicioDiaArgentina(ahora));
    const gastoSemana = topes.semana > 0 ? await gastoClienteVentana(phone, inicioSemanaArgentina(ahora)) : 0;
    if (gastoDia === null || gastoSemana === null) return "ok"; // ante un error de lectura no se corta
    const r = nivelClienteGasto(gastoDia, gastoSemana, topes);
    if (r.nivel === "ok") return "ok";
    if (!(await alertaClienteDeHoy(phone))) {
      const razon = customer?.business_name ?? null, cid = customer?.customer_id ?? null;
      await notificarHumano({ tipo: "otro", phone, customerId: cid, contexto: contextoAlertaCliente(r.limite!, gastoDia, gastoSemana, topes, text, razon) });
      await enviarTexto(cfg, phone, MSG_TOPE_CLIENTE);
      await saveMessage(phone, "assistant", MSG_TOPE_CLIENTE);
    }
    return "tope";
  } catch (e) {
    console.error("[tope-cliente] falló, se sigue sin tope:", e instanceof Error ? e.message : e);
    return "ok";
  }
}


/**
 * Envío de texto que NO tumba el webhook. Devuelve true si Meta lo aceptó.
 *
 * Hace falta desde que el webhook usa `_shared/wa-api.ts` (2026-09-08), cuyo `waPost` LANZA
 * cuando Meta rechaza — que es lo correcto, pero acá hay que atajarlo: si una excepción sube
 * hasta el handler, el webhook devuelve 500 y **Meta reintenta el mismo mensaje**, con lo cual
 * el cliente recibe la respuesta dos veces o entra en loop. Peor que el problema original.
 *
 * Además, devolver el resultado permite NO guardar en el historial una respuesta que el
 * cliente nunca recibió (eso es exactamente lo que pasaba antes, cuando `waPost` se tragaba
 * el error: quedaba escrito "el bot contestó X" y el cliente no había visto nada).
 */
async function enviarTexto(cfg: Config, phone: string, texto: string): Promise<boolean> {
  try {
    await sendText(cfg.waPhoneId, cfg.waToken, phone, texto);
    return true;
  } catch (e) {
    const code = e instanceof WaApiError ? ` (code ${e.code})` : "";
    console.error(`[enviarTexto] Meta rechazó el mensaje a ${phone}${code}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Toda la cadena de modelos falló o venció (Pablo, 13/10, P6.2): el cliente recibe RESPALDO_IA_CAIDA en vez de silencio. Una vez cada 30 min por
 * número: runConversation ya dejó la alerta llm_error / llm_timeout de ESTE turno, así que si hay otra de hace menos de 30 min ya se le avisó.
 * Si el cliente insiste, la cadena se vuelve a intentar en cada mensaje (puede haberse recuperado) y, si sigue caída, no se repite el aviso.
 * Nunca lanza: el aviso no puede tumbar el webhook.
 */
async function avisarIaCaida(cfg: Config, phone: string): Promise<void> {
  try {
    const desde = new Date(Date.now() - 30 * 60_000).toISOString();
    const { count } = await supabase.from("wa_alertas_humano").select("id", { count: "exact", head: true })
      .eq("phone", phone).in("tipo", ["llm_error", "llm_timeout"]).gte("created_at", desde);
    if ((count ?? 0) > 1) return;   // la de este turno cuenta 1
    if (await enviarTexto(cfg, phone, RESPALDO_IA_CAIDA)) await saveMessage(phone, "assistant", RESPALDO_IA_CAIDA);
  } catch (e) {
    console.error("[ia caída] no se pudo avisar al cliente:", e instanceof Error ? e.message : e);
  }
}

/**
 * Pausa del bot (Pablo, 13/10, plan de producción Fase 0 punto 5; ver _shared/pausa-bot.ts). `app_settings.wa_bot_pausa` prendida: el mensaje se guarda en la
 * conversación y deja UNA alerta `bot_pausa` por teléfono cada 30 min. NO contesta, NO marca leído, NO llama a la IA, a las respuestas fijas ni al lector de
 * archivos, NO transcribe audios y NO manda el aviso de fuera de horario: lo único que sale de acá es una fila en la base. Nunca lanza.
 */
async function atenderPausa(msg: WaMessage): Promise<void> {
  const phone = msg.from;
  try {
    // Meta reintenta el webhook si no ve el 200 a tiempo: el mismo candado de idempotencia que el camino normal (sql/057), para no guardar ni alertar dos veces.
    if (msg.msgId) {
      const { error: dup } = await supabase.from("wa_inbound_seen").insert({ wamid: msg.msgId, phone });
      if (dup?.code === "23505") { console.log(`[pausa] wamid repetido, se ignora: ${msg.msgId}`); return; }
    }
    await saveMessage(phone, "user", textoParaGuardar(msg));
    const desde = new Date(Date.now() - MINUTOS_ENTRE_AVISOS_PAUSA * 60_000).toISOString();
    const { count } = await supabase.from("wa_alertas_humano").select("id", { count: "exact", head: true })
      .eq("phone", phone).eq("contexto->>motivo", MOTIVO_PAUSA).gte("created_at", desde);
    if ((count ?? 0) > 0) return;   // ya quedó avisado hace menos de 30 min
    let cliente: CustomerContext | null = null;
    try { cliente = await getCustomerContext(phone); } catch { /* sin cliente: la alerta sale igual con el teléfono */ }
    await notificarHumano({ tipo: "otro", phone, customerId: cliente?.customer_id ?? null, contexto: contextoAlertaPausa(msg) });
  } catch (e) {
    console.error("[pausa] no se pudo registrar el mensaje:", e instanceof Error ? e.message : e);
  }
}

// ─── Reporte de gerencia a pedido (idea 6600) ───────────────────────
//
// El reporte "💰 HOY" (plata del día + mes a la fecha) ya existe y sale por Telegram todos
// los días a las 20:00 ART — cron 36 `reporte-hoy-plata-telegram` → `rep_enviar_hoy()` →
// `rep_texto_hoy(fecha)`. Esto le da la MISMA fuente por WhatsApp, sin duplicar el texto.

/** Fecha de hoy en Argentina (UTC-3 fijo), con corrimiento opcional en días. */
function fechaArgentina(offsetDias = 0): string {
  const ms = Date.now() - 3 * 60 * 60 * 1000 + offsetDias * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * ¿Este teléfono puede pedir el reporte? Sale de `app_settings.wa_gerencia_phones`, un array
 * JSON de teléfonos en el formato de Meta (`["5491162521635"]`).
 *
 * **Arranca vacío a propósito: sin esa clave cargada, NADIE puede.** Estar en la whitelist
 * (`wa_envio_contactos`) no alcanza — esa lista es para que el bot conteste y el día que se
 * abra a clientes los va a incluir. La plata de la empresa necesita su propia lista.
 */
async function esGerencia(phone: string): Promise<boolean> {
  try {
    const raw = await getSetting("wa_gerencia_phones");
    if (!raw) return false;
    const lista = JSON.parse(raw);
    if (!Array.isArray(lista)) return false;
    const d = phone.replace(/\D/g, "");
    return lista.some((p: unknown) => {
      const q = String(p).replace(/\D/g, "");
      // Comparación por los últimos 8 dígitos: evita que un 54/9/15 de más lo haga fallar.
      return q.length >= 8 && d.length >= 8 && q.slice(-8) === d.slice(-8);
    });
  } catch { return false; }
}

/** "hoy", "plata", "reporte", "ventas" — con o sin acentos, y "… de ayer". */
function esComandoReporteHoy(text: string): boolean {
  const t = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // saca acentos
    .toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  // La cabeza temporal ("hoy" / "ayer") va sola; el calificativo de día sólo cuelga de un
  // sustantivo ("reporte de ayer"). Así "hoy ayer" no matchea nada.
  return /^((plata|reporte|ventas|numeros)( de)?( hoy| ayer)?|hoy|ayer)$/.test(t);
}

// ─── Handler principal ──────────────────────────────────────────────

async function handleMessage(
  phone: string,
  text: string,
  msgId: string,
  contactName: string | undefined,
  cfg: Config,
  // `first_seen` de este wamid, tal como lo devolvió el insert del candado de idempotencia (handler). Lo usan el saludo
  // suelto y la ráfaga de pedido; si no vino (insert sin fila), se lee de la tabla como antes.
  firstSeen: string | null = null,
): Promise<void> {
  // 0. Kill switch: si el toggle está prendido, solo procesamos números
  //    de la whitelist (wa_envio_contactos). Cualquier otro se descarta
  //    silenciosamente — no marcamos leído para no confundir a Meta, no
  //    respondemos, no guardamos historial. Log en wa_alertas_humano
  //    para saber qué números intentaron.
  //
  // Auditoría 02/10: las cuatro lecturas de los pasos 0, 0b y 3 (llave de whitelist, whitelist, blacklist y cliente) son
  // sólo lecturas y no dependen entre sí: se piden juntas y se evalúan en el MISMO orden de siempre. Antes eran cuatro
  // viajes a la base en fila, en cada mensaje. El modo de la conversación (paso 2) queda AFUERA a propósito:
  // bot_conv_get_modo tiene efecto (vence el modo humano con un UPDATE) y no debe correr para un número que se descarta.
  const [raw, enWhitelist, bl, customer] = await Promise.all([
    getSetting("wa_bot_solo_whitelist"),
    estaEnWhitelist(phone),
    blacklistRow(phone),
    getCustomerContext(phone),
  ]);
  const soloWhitelist = Number(raw ?? "1") === 1;
  if (soloWhitelist && !enWhitelist) {
    console.warn(`[whitelist-gate] mensaje de ${phone} descartado (no está en wa_envio_contactos).`);
    await avisarDescartePorWhitelist(phone, {
      motivo: "whitelist_gate", texto_recibido: text.slice(0, 200), contact_name: lineaSegura(contactName, 80) || null,
    }, customer);
    return;
  }

  // 0b. Blacklist. Punto 10 de la auditoría del 07/09: `wa_blacklist` y
  //     `wa_check_rate_limit` (sql/012, con su setting `wa_rate_limit_enabled`) existían
  //     sólo en `lk_chat-test`, o sea en el simulador del Panel. En el webhook real —el
  //     que atiende a los clientes— no había ni un hit: un número blacklisteado seguía
  //     siendo atendido y no había tope de mensajes por número.
  //     Se descarta. Pedido del dueño (2026-09-09): al PRIMER mensaje después de entrar a
  //     la blacklist se le responde una vez y después, silencio. `avisado_at` marca ese
  //     "ya avisé". Queda la fila en `wa_alertas_humano` para saber que escribió.
  {
    if (bl) {
      console.warn(`[blacklist] mensaje de ${phone} descartado.`);
      if (!bl.avisado_at) {
        // Editable desde el Panel (app_settings.wa_blacklist_msg); fallback al default.
        const aviso = (await getSetting("wa_blacklist_msg"))?.trim() || `Estamos momentáneamente fuera de servicio.`;
        await enviarTexto(cfg, phone, aviso);
        await saveMessage(phone, "user", text);
        await saveMessage(phone, "assistant", aviso);
        await supabase.from("wa_blacklist")
          .update({ avisado_at: new Date().toISOString() }).eq("phone", phone);
      }
      await notificarHumano({
        tipo: "otro",
        phone,
        contexto: { motivo: "blacklist", texto_recibido: text.slice(0, 200) },
      });
      return;
    }
  }

  // 0c. Señal de ataque en la ENTRADA (riesgo 4, Pablo 13/10). Patrones de alta precisión (inyección /
  //     extracción de prompt / jailbreak) en el texto del cliente. NO corta la respuesta —la defensa real es el
  //     bloque de Seguridad, el canario y el filtro de salida—: sólo escala. A los 3 intentos en 24 h avisa a una
  //     persona; a los 5, el número pasa a wa_blacklist. Si el registro falla, no rompe el flujo.
  {
    const det = pareceAtaqueEntrada(text);
    if (det.hit) {
      try {
        const { data: r } = await supabase.rpc("bot_ataque_entrada", { p_phone: phone, p_patron: det.patron });
        const info = (r ?? {}) as { n?: number; alertar?: boolean; blacklistear?: boolean };
        console.warn(`[ataque-entrada] patrón "${det.patron}" de ${phone} (intento ${info.n ?? "?"}/24h)`);
        if (info.alertar) {
          await notificarHumano({ tipo: "otro", phone,
            contexto: { motivo: "ataque_entrada", patron: det.patron, intentos: info.n ?? null, texto_recibido: text.slice(0, 200) } });
        }
        if (info.blacklistear) {
          await supabase.from("wa_blacklist").upsert({ phone }, { onConflict: "phone", ignoreDuplicates: true });
          console.warn(`[ataque-entrada] ${phone} a wa_blacklist (${info.n} intentos en 24 h)`);
        }
      } catch (e) { console.warn("[ataque-entrada] no pude registrar:", e instanceof Error ? e.message : e); }
    }
  }

  // NOTA: el rate limit NO va acá. Cuenta SÓLO las consultas que llegan al agente (IA),
  // así que su gate vive en el paso 6, justo antes de `runConversation` (más abajo). Las
  // FAQ/AUTO y los flujos deterministas (alta, identificación) no gastan cupo.

  // 1. Marcar como leído (fire-and-forget)
  markRead(cfg.waPhoneId, cfg.waToken, msgId).catch(() => {});

  // 1b. Reporte de gerencia a pedido (idea 6600). Va ACÁ, antes del modo humano y del
  //     FAQ/LLM: es una consulta interna, no gasta tokens y no tiene que competir con
  //     ninguna FAQ.
  //
  //     Por qué "a pedido" y no un push a las 20:00 como el de Telegram: WhatsApp sólo
  //     deja mandar texto libre DENTRO de la ventana de 24 h que abre el propio usuario
  //     al escribir. Un mensaje que sale sin que nadie haya escrito necesita una PLANTILLA
  //     aprobada por Meta, y las 6 que hay (`wa_tpl_*`) son todas de pedidos. Así que el
  //     push queda esperando esa aprobación, pero esto ya funciona hoy: el dueño escribe
  //     "hoy" y le llega el mismo texto que manda el cron 36.
  if (await esGerencia(phone) && esComandoReporteHoy(text)) {
    const ayer = text.toLowerCase().includes("ayer");
    const { data: rep, error: repErr } = await supabase.rpc("rep_texto_hoy", {
      p_fecha: fechaArgentina(ayer ? -1 : 0),
    });
    const salida = repErr || !rep
      ? "No pude armar el reporte ahora. Probá en un rato."
      : String(rep);
    if (repErr) console.error("[gerencia] rep_texto_hoy falló:", repErr.message);
    await enviarTexto(cfg, phone, salida);
    return;
  }

  // 2. Modo humano → no procesamos, solo guardamos para trazabilidad. El bot
  //    retoma cuando el modo vuelve a "bot" (hoy: vencimiento fijo en
  //    lk_conversaciones, `auto_retomar_bot`).
  //    ── CABLE (sin enchufar) — cierre por inactividad ──────────────────────
  //    TODO: bajar el vencimiento de 8h a ~30-40 min de inactividad. Cuando el
  //    chat lleva ese tiempo sin mensajes, avisar al vendedor ("¿cerramos esta
  //    conversación?") o darle un botón "Cerrar chat" en el Panel; al cerrar,
  //    modo vuelve a "bot" y el bot retoma si el cliente reinicia contacto.
  //    Requiere: cron/edge de barrido (idle sweep) + acción de UI. NO conectado.
  const modo = await getConversationMode(phone);
  if (modo === "humano") {
    await saveMessage(phone, "user", text);
    return;
  }

  // 3. Identificar cliente por teléfono (`customer`: leído arriba, junto con los otros candados)

  // 3a. Cliente sólo de Chef (Pablo, 01/10, sql/115 + _shared/chef.ts). Sólo se busca si no es cliente de Loekemeyer.
  //     Las herramientas del bot buscan en Loekemeyer por número de cliente, y ese número es otro cliente en cada
  //     empresa: a un cliente de Chef se le contesta sólo saludo, facturas de Chef y datos de pago de Chef (por CUIT);
  //     lo demás va a una persona. Antes caía como no-cliente y el bot le arrancaba el alta.
  const chef = customer ? null : await cuentaChef(phone);

  // 3b. Alta en curso (no-cliente): si ya arrancó la toma de datos, cada
  //     mensaje es la respuesta al campo que toca. La interceptamos ACÁ, antes
  //     del FAQ, para que un saludo/keyword no le robe la respuesta al alta.
  if (!customer && !chef) {
    const lead = await getPendingLead(phone);
    if (lead) {
      await saveMessage(phone, "user", text);
      const send = async (reply: string): Promise<void> => {
        await enviarTexto(cfg, phone, reply);
        await saveMessage(phone, "assistant", reply);
      };
      await handleAltaStep(phone, text, lead, send);
      return;
    }
  }

  // 3b'. Cliente molesto (insultos, quejas fuertes, gritos) → a una persona, antes que cualquier
  //      respuesta automática. Alerta urgente (cliente_molesto → tarea en Planify). _shared/humor.ts
  {
    const replyMolesto = await atenderMalHumor(phone, text,
      customer ?? (chef ? { customer_id: null, business_name: chef.razon_social, empresa: "CH" } : null));
    if (replyMolesto) {
      await saveMessage(phone, "user", text);
      await enviarTexto(cfg, phone, replyMolesto);
      await saveMessage(phone, "assistant", replyMolesto);
      return;
    }
  }

  // 3b''. Sólo un saludo ("Hola", "Buen día"), Pablo 30/09: no se asume que sigue un tema anterior (antes, tras un aviso,
  //       respuesta-aviso lo tomaba como "gracias" y contestaba "¡Gracias a vos!"). Se esperan 5 s por si sigue
  //       escribiendo: si llegó otro mensaje, ése contesta (con el saludo en el historial) y éste no dice nada. Si no,
  //       va a la respuesta fija del saludo (FAQ #41 "¡Hola …! ¿En qué te puedo ayudar?", editable desde el dashboard).
  const soloSaludo = esSoloSaludo(text);
  // `first_seen` de ESTE mensaje: lo devolvió el insert del candado de idempotencia (handler); si no vino, se lee una vez.
  const miFirstSeen = async (): Promise<string | null> => {
    if (firstSeen) return firstSeen;
    const { data: yo } = await supabase.from("wa_inbound_seen").select("first_seen").eq("wamid", msgId).maybeSingle();
    firstSeen = yo?.first_seen ?? null;
    return firstSeen;
  };
  // Pedido por WhatsApp en curso: se consulta una sola vez por mensaje (lo miran la ráfaga de abajo y el paso 4).
  let enCursoP: Promise<boolean> | null = null;
  const enCursoLazy = (): Promise<boolean> => (enCursoP ??= pedidoEnCurso(phone));
  if (soloSaludo && msgId) {
    await new Promise((r) => setTimeout(r, 5000));
    const visto = await miFirstSeen();
    if (visto) {
      const { count } = await supabase.from("wa_inbound_seen").select("wamid", { count: "exact", head: true })
        .eq("phone", phone).gt("first_seen", visto);
      // No se guarda en el historial: quedaría DESPUÉS de la consulta (el otro mensaje ya se guardó) y no aporta.
      if ((count ?? 0) > 0) return;
    }
  }

  // 3a'. Cliente sólo de Chef: no sigue a avisos, FAQ ni agente (todos leen datos de Loekemeyer). Ver 3a.
  if (chef) {
    await saveMessage(phone, "user", text);
    const r = await atenderClienteChef(phone, text, chef);
    const reply = r.yaSaluda ? r.reply : await conSaludoSiCorresponde(r.reply, phone);
    await enviarTexto(cfg, phone, reply);
    await saveMessage(phone, "assistant", reply);
    // Fase 3: reenvío de la factura de Chef (PDF del bucket isis-ch). Mismo camino que el de LK más abajo.
    for (const d of r.documentos ?? []) {
      try {
        await sendDocument(cfg.waPhoneId, cfg.waToken, phone, d.url, d.filename);
        await saveMessage(phone, "assistant", `[Documento] ${d.filename}`);
      } catch (e) {
        console.error(`[chef documento] Meta rechazó ${d.filename} a ${phone}:`, e instanceof Error ? e.message : e);
      }
    }
    // Paso C (01/10): foto del producto de Chef (una por pedido; ya verificada en catalogo-chef.ts).
    if (r.imagenes?.length) {
      await sendMediaActions(r.imagenes.map((i) => ({ type: "image" as const, url: i.url, caption: i.caption })), phone, cfg);
      for (const i of r.imagenes) await saveMessage(phone, "assistant", `[Imagen] ${i.caption}`);
    }
    return;
  }

  // 3b-bis. Pedido en varios mensajes (Pablo, 30/09): "4 cajas del 501" / "y 6 del 504" / "sumale 2 del 506" mandados en
  //       ráfaga se procesaban cada uno por su lado y al mismo tiempo (2-3 respuestas cruzadas). Si hay un pedido por
  //       WhatsApp en curso, el mensaje trae cantidades o códigos, o llegó otro mensaje suyo hace menos de 6 s, se esperan
  //       5 s: si mientras tanto escribió otra cosa, éste se guarda en el historial SIN contestar y contesta el último
  //       (que ya lo ve). Se guarda acá porque si no, el último no lo vería.
  if (customer && !soloSaludo && msgId) {
    const RE_ITEMS = /(\b\d+\s*(cajas?|cj|bultos?|unidades|u)\b|\bdel\s+\d{3,5}[a-z]?\b|\bc[oó]d(igo)?\.?\s*\d{3,5})/i;
    const visto = await miFirstSeen();
    let rafaga = false;
    if (visto) {
      const { count: previos } = await supabase.from("wa_inbound_seen").select("wamid", { count: "exact", head: true })
        .eq("phone", phone).neq("wamid", msgId).lt("first_seen", visto)
        .gt("first_seen", new Date(new Date(visto).getTime() - 6000).toISOString());
      rafaga = (previos ?? 0) > 0;
    }
    // Pablo, 15/10 (tanda de pruebas, mensajes 2 y 3): «Tiene stock del 586?» y «Si quiero 30 cajas hay?» esperaban 5 s sin ser un pedido. Una pregunta de disponibilidad sin intención de
    // pedir (consulta-disponibilidad.ts) no espera por sí sola; sigue esperando si llegó otro mensaje hace menos de 6 s o hay un pedido en curso.
    if (visto && (rafaga || (RE_ITEMS.test(text) && !esConsultaDeDisponibilidad(text)) || await enCursoLazy())) {
      await new Promise((r) => setTimeout(r, 5000));
      const { count } = await supabase.from("wa_inbound_seen").select("wamid", { count: "exact", head: true })
        .eq("phone", phone).gt("first_seen", visto);
      if ((count ?? 0) > 0) {
        await saveMessage(phone, "user", text);
        return;
      }
    }
  }

  // 3c. Respuesta a un aviso automático (pedido recibido, programado, en viaje…): si lo último
  //     que le mandamos fue un aviso de las últimas 48 h, lo que escribe es la respuesta.
  //     Ramas deterministas (0 tokens): cambiar/cancelar → asesor; cuándo llega → estado real;
  //     gracias/ok → respuesta breve. Si no cae en ninguna, sigue el flujo normal y el agente
  //     ve el aviso en el historial con el texto real. Ver _shared/respuesta-aviso.ts.
  if (customer && !soloSaludo) {
    // 3d. Pedido de cambio de fecha / cancelación en cualquier momento (no sólo tras un aviso):
    //     antes caía en la FAQ de dirección del depósito ("puedo pasar") con la fecha vacía.
    const replyAviso = await responderAviso(phone, text, customer) ?? await pedidoDeCambio(phone, text, customer);
    if (replyAviso) {
      await saveMessage(phone, "user", text);
      await enviarTexto(cfg, phone, replyAviso);
      await saveMessage(phone, "assistant", replyAviso);
      return;
    }
  }

  // 4. FAQ pre-check (0 tokens). Bifurca cliente vs no-cliente. Corta
  //    acá si hay match "sólido" (AUTO / SEMIAUTO / HUMANO preestablecida).
  //    La conversación con el agente es el último recurso.
  const faqCustomer = customer ? {
    id: customer.customer_id,
    cod_cliente: customer.cod_cliente,
    business_name: customer.business_name,
    dto_vol: customer.dto_vol,
  } : null;
  // Pablo, 29/09: "Hola, quiero ser cliente" ganaba la respuesta fija del saludo y nunca arrancaba el alta (visto en el
  // Simulador › Número nuevo). Para un no-cliente que pide darse de alta, primero el registro.
  // Pablo, 29/09: el cliente contesta la lista de un pedido que mandó como archivo ("sí" o lo que quiere cambiar).
  if (customer) {
    const rpa = await respuestaPedidoArchivo(phone, text, await pedidosWaHabilitados());
    if (rpa) {
      await saveMessage(phone, "user", text);
      await enviarTexto(cfg, phone, rpa);
      await saveMessage(phone, "assistant", rpa);
      return;
    }
  }
  // Pedido por WhatsApp a medio armar: lo que conteste va al agente, no a una respuesta fija (pedidoEnCurso).
  const enCurso = customer ? await enCursoLazy() : false;
  // Pablo, 01/10 (D008): quien compra en Loekemeyer Y en Chef elige de qué marca es cada consulta (_shared/marca.ts). Se le
  // pregunta salvo saludo, cortesía y consultas de plata (esas ya separan las dos empresas); con Chef contesta lo que Chef
  // sabe o una persona; con Loekemeyer sigue el flujo de siempre, con la respuesta etiquetada. Si algo falla acá, sigue el
  // flujo de siempre: la puerta no puede tumbar la respuesta al cliente.
  let marcaLk = false;
  if (faqCustomer && !soloSaludo && !enCurso) {
    const g = await puertaMarca(phone, text, faqCustomer).catch((e) => {
      console.error("puertaMarca:", e instanceof Error ? e.message : e);
      return null;
    });
    if (g?.tipo === "responder") {
      await saveMessage(phone, "user", text);
      const reply = await conSaludoSiCorresponde(g.reply, phone);
      await enviarTexto(cfg, phone, reply);
      await saveMessage(phone, "assistant", reply);
      for (const d of g.documentos ?? []) {
        try {
          await sendDocument(cfg.waPhoneId, cfg.waToken, phone, d.url, d.filename);
          await saveMessage(phone, "assistant", `[Documento] ${d.filename}`);
        } catch (e) {
          console.error(`[marca documento] Meta rechazó ${d.filename} a ${phone}:`, e instanceof Error ? e.message : e);
        }
      }
      if (g.imagenes?.length) {
        await sendMediaActions(g.imagenes.map((i) => ({ type: "image" as const, url: i.url, caption: i.caption })), phone, cfg);
        for (const i of g.imagenes) await saveMessage(phone, "assistant", `[Imagen] ${i.caption}`);
      }
      return;
    }
    if (g?.tipo === "seguir") { text = g.texto; marcaLk = true; }
  }
  // Pablo, 05/10: además de pedirlo con palabras propias, un "sí" / "dale" a la oferta de registro del saludo arranca el alta
  // (antes caía en "pasame tu CUIT"). Se lee lo último que dijo el bot ANTES de guardar este mensaje.
  const quiereAlta = !customer && iniciaAlta(text, esAfirmacion(text) ? await ultimoMensajeDelBot(phone) : "");
  let faq = quiereAlta ? null
    : enCurso ? null
    : await handleFaq(text, faqCustomer);
  // Pablo, 08/10 (Chef 411): la respuesta fija no sale si repite un texto que el bot mandó hace menos de 30 min, y un mensaje con varios pedidos
  // no tiene respuesta fija. En los dos casos contesta el agente (lee el historial) con lo que la capa fija habría dicho como pista; los PDF de
  // factura de esas pistas salen después de su respuesta. Ver _shared/mensaje-compuesto.ts.
  let pistas: string[] = [];
  let documentosPistas: Array<{ url: string; filename: string }> = [];
  if (faqCustomer && !quiereAlta && !enCurso) {
    const d = await decidirCapaFija(text, faqCustomer, faq, faq ? respuestasRecientes(await loadHistory(phone, 10)) : []);
    faq = d.faq;
    pistas = d.pistas;
    documentosPistas = d.documentos;
  }
  if (faq) {
    await saveMessage(phone, "user", text);
    // Pablo y Thomy, 07/10: pide la clave de la web y el teléfono está agendado → su usuario y su PIN (customers.pin), sin
    // generar una clave nueva. El PIN se lee recién acá y en el historial queda tapado (_shared/clave-web.ts). Sin PIN cargado
    // lo resuelve una persona (motivo acceso_web).
    let textoFaq = faq.reply;
    let alertaFaq = faq.alerta;
    if (faq.conClave && customer) {
      const acceso = await datosDeAccesoWeb(customer.customer_id);
      if (acceso) {
        textoFaq = textoAccesoWeb(acceso.usuario, acceso.clave);
        console.log(`[clave_web] datos de acceso a ${phone.slice(0, 5)}… (cliente ${customer.cod_cliente})`);
      } else {
        textoFaq = TEXTO_CLAVE_A_PERSONA;
        alertaFaq = { motivo: "acceso_web", detalle: "Pide su clave de la web y no tiene PIN cargado (o no se pudo leer)" };
      }
    }
    // `faq.yaSaluda` = la respuesta ya arranca con "Hola…" (la FAQ del saludo inicial).
    // Sin ese chequeo el cliente recibía el saludo dos veces seguidas.
    const cuerpo = marcaLk ? conEtiqueta("lk", textoFaq) : textoFaq;
    const reply = customer && !faq.yaSaluda
      ? await conSaludoSiCorresponde(cuerpo, phone)
      : cuerpo;
    await enviarTexto(cfg, phone, reply);
    await saveMessage(phone, "assistant", faq.conClave ? taparClave(reply) : reply);
    // Pablo, 30/09: reenvío de factura. PDF suelto (el cliente acaba de escribir: dentro de las 24 h). Pasa por wa-guard.
    for (const d of faq.documentos ?? []) {
      try {
        await sendDocument(cfg.waPhoneId, cfg.waToken, phone, d.url, d.filename);
        await saveMessage(phone, "assistant", `[Documento] ${d.filename}`);
      } catch (e) {
        console.error(`[faq documento] Meta rechazó ${d.filename} a ${phone}:`, e instanceof Error ? e.message : e);
      }
    }
    // Punto 21 de la auditoría del 07/09: las FAQ `needs_human` le prometen al cliente
    // que "te va a contactar un asesor a la brevedad" y NADIE se enteraba — el aviso
    // estaba escrito como comentario y sin conectar. Era una promesa falsa en producción.
    // Va después de responder, y con `await` sin `try`: `notificarHumano` nunca lanza.
    if (alertaFaq) {
      await notificarHumano({
        tipo: "otro",
        phone,
        customerId: customer?.customer_id ?? null,
        contexto: {
          motivo: alertaFaq.motivo,
          ...(alertaFaq.urgente !== undefined ? { urgente: alertaFaq.urgente } : {}),
          ...(alertaFaq.pedidos?.length ? { pedido: alertaFaq.pedidos[0], pedidos: alertaFaq.pedidos } : {}),
          detalle: alertaFaq.detalle ?? null,
          texto_recibido: text.slice(0, 200),
          razon_social: customer?.business_name ?? null,
        },
      });
    } else if (faq.automation_level === "needs_human") {
      await notificarHumano({
        tipo: "escalation",
        phone,
        customerId: customer?.customer_id ?? null,
        contexto: {
          faq_id: faq.faq_id ?? null,
          tema: faq.topic ?? null,
          texto_recibido: text.slice(0, 200),
          razon_social: customer?.business_name ?? null,
        },
      });
    }
    return;
  }

  // 5. Sin cliente y sin FAQ → flujo de identificación (CUIT)
  if (!customer) {
    await handleRegistration(phone, text, contactName, cfg, quiereAlta);
    return;
  }

  // 6. Cliente identificado, FAQ no matcheó → agente conversacional
  await saveMessage(phone, "user", text);

  // 6a. Rate limit (SÓLO consultas al agente/IA, cualquier modelo). El contador de
  //     `wa_rate_limit` sólo se incrementa acá, así que el tope `wa_rate_limit_per_hour`
  //     es "N consultas de IA por hora por número". Si lo pasó, no llamamos al agente
  //     (ahorra tokens) y se avisa UNA vez por hora (ver `pasoElTope`).
  const rateLimited = await pasoElTope(phone);
  if (rateLimited) {
    if (rateLimited.avisar) {
      // Editable desde el Panel (app_settings.wa_rate_limit_msg, con {{limite}}, {{espera}} y {{hora}}). Sin texto guardado sale el de
      // _shared/tope-ia.ts, que dice cuánto esperar: el contador se reinicia a la hora en punto y puede haber sido un error del cliente.
      const aviso = mensajeTope(await getSetting("wa_rate_limit_msg"), rateLimited.limite, new Date());
      await enviarTexto(cfg, phone, aviso);
      await saveMessage(phone, "assistant", aviso);
      // Una persona mira el chat (motivo `tope_ia`, Configuración › Derivaciones): sin esto el cliente quedaba en silencio hasta la hora
      // en punto y nadie lo veía, y puede haber sido un error suyo o una consulta real. Una sola vez por hora y número, como el aviso;
      // `notificarHumano` nunca lanza.
      await notificarHumano({
        tipo: "otro",
        phone,
        customerId: customer?.customer_id ?? null,
        contexto: contextoAlertaTope(rateLimited.limite, text, customer?.business_name ?? null, new Date()),
      });
    }
    return;
  }

  // 6a2. Tope de gasto global diario de IA (Pablo, 14/10: «degradá, pero no cortes del todo» y «que no corte en 5, sino que dé un aviso a un humano si está
  //      dentro del horario»). NINGÚN nivel corta al agente: con `degradar` (US$ 3) y `escalar` (US$ 5) el agente SIGUE pero sólo con modelos gratis / Haiku
  //      (el filtro vive en runConversation, opción `degradado`); `escalar` sólo agrega una alerta para una persona si estamos en horario de atención.
  const nivelGasto = await pasoElTopeDeGasto(phone, customer, text);
  const degradado = nivelGasto !== "ok";

  // 6a2b. Tope de gasto POR CLIENTE (Pablo, 14/10: US$ 2/día y US$ 5/semana por teléfono). Frena SÓLO a ese cliente (los demás siguen); mismo aviso fijo
  //       y una alerta por día por cliente. Detalle en _shared/tope-cliente.ts.
  if ((await pasoElTopeCliente(cfg, phone, customer, text)) === "tope") return;

  // 6a3. Medidor de presupuesto MENSUAL del pozo de IA (Pablo, 14/10: US$ 100/mes, avisos al 25/50/75/90/100%, "sólo avisa"). No corta nada: sólo deja
  //      una alerta para una persona si el mes cruzó un umbral nuevo. Cuenta TODO el gasto del mes (no sólo clientes). No bloquea el flujo.
  await avisarPresupuesto(phone, customer);

  iaEmpieza(phone); // tiempo de la IA dentro del turno (sql/136)
  const result = await runConversation(
    text,
    phone,
    customer.business_name,
    customer.cod_cliente,
    customer.dto_vol,
    cfg.anthropicKey,
    "lk_whatsapp-webhook",
    { pistas, degradado },
  ).finally(() => iaTermina(phone));

  // 6b. Si el LLM se cayó (timeout / error irrecuperable), NO enviamos
  // nada al cliente. `runConversation` ya avisó a un humano vía
  // `wa_alertas_humano`; el vendedor toma la conversación desde ahí.
  if (result.timeout || result.llmError) {
    console.warn(`[webhook] LLM ${result.timeout ? "timeout" : "error"} — el cliente ${phone} recibe el texto de IA caída (si no lo recibió hace menos de 30 min). Alerta encolada.`);
    // Pablo, 13/10 (plan de los 8 puntos, P6.2): antes acá se cortaba y el cliente quedaba en silencio hasta que una persona viera la alerta.
    await avisarIaCaida(cfg, phone);
    return;
  }

  // 7. Enviar media (fotos, catálogo) antes del texto
  if (result.media.length) {
    await sendMediaActions(result.media, phone, cfg);
  }

  // 8. Enviar respuesta de texto (con saludo si es primer contacto)
  const reply = await conSaludoSiCorresponde(marcaLk ? conEtiqueta("lk", result.reply) : result.reply, phone);
  // Pablo, 16/10: si el mensaje traía varias preguntas, el agente contesta cada una en un mensaje aparte (marca con [[corte]]).
  // Sin marcador es un solo mensaje, como siempre (partir-respuesta.ts). El historial y el puntaje guardan el texto limpio y unido.
  const partesReply = partirRespuesta(reply);
  for (const parte of partesReply) await enviarTexto(cfg, phone, parte);
  const replyGuardar = partesReply.join("\n\n") || reply;

  // 9. Guardar respuesta en historial.
  // 10. Puntaje de la IA (Pablo, 29/09): la respuesta queda para que Haiku la evalúe en segundo plano (cron
  //     lk_ia-puntaje, sql/101). No frena al cliente; si el insert falla, sólo se pierde el puntaje.
  // Son dos inserts independientes: van juntos (auditoría 02/10; antes, en fila). PostgrestBuilder no rechaza ante un
  // error de la base (lo devuelve en `error`), así que se mira el resultado además de atajar la excepción de red.
  await Promise.all([
    saveMessage(phone, "assistant", replyGuardar),
    supabase.from("wa_ia_puntajes").insert({
      phone, customer_id: customer.customer_id, pregunta: text.slice(0, 2000), respuesta: replyGuardar.slice(0, 4000),
      herramientas: result.herramientas ?? [], modelo_respuesta: result.modelo ?? null,
    }).then(
      ({ error }) => { if (error) console.error("[puntaje] no se pudo encolar:", error.message); },
      (e) => console.error("[puntaje] no se pudo encolar:", e),
    ),
  ]);
  // 11. PDF de factura que la capa fija habría mandado en una parte de un mensaje compuesto (Pablo, 08/10): el agente no puede mandarlos.
  //     Van después del texto, como en la respuesta fija.
  for (const d of documentosPistas) {
    try {
      await sendDocument(cfg.waPhoneId, cfg.waToken, phone, d.url, d.filename);
      await saveMessage(phone, "assistant", `[Documento] ${d.filename}`);
    } catch (e) {
      console.error(`[pistas documento] Meta rechazó ${d.filename} a ${phone}:`, e instanceof Error ? e.message : e);
    }
  }
}

// Fuera del horario de atención, si el turno dejó una alerta que espera a una persona, se le avisa al cliente cuándo se le responde
// (Pablo, 06/10). Dentro de horario no hace nada ni consulta la base. Ver _shared/fuera-de-horario.ts.
async function conAvisoFueraDeHorario(phone: string, cfg: Config, trabajo: () => Promise<void>): Promise<void> {
  const desde = new Date();
  await trabajo();
  await avisarFueraDeHorario(phone, desde, async (texto) => {
    await enviarTexto(cfg, phone, texto);
    await saveMessage(phone, "assistant", texto);
  });
}

// ─── Edge Function entry point ──────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ── GET: Verificación Meta ──
  // Meta manda hub.mode + hub.verify_token + hub.challenge. Solo necesitamos
  // el verify_token; no hace falta que estén las otras env vars (útil cuando
  // se está dando de alta un número nuevo antes de setear LK_WA_TOKEN etc.).
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && challenge) {
      // Punto 16 de la auditoría del 07/09: acá se leía SÓLO la env var, mientras
      // `loadConfig` (:48) prioriza `app_settings`. O sea que rotar el verify token
      // desde el Panel dejaba la verificación de Meta devolviendo 403 sin más síntoma
      // que este log. Se usa el mismo orden que loadConfig.
      const expected = (await getSetting("LK_WA_VERIFY_TOKEN")) ?? Deno.env.get("LK_WA_VERIFY_TOKEN") ?? "";
      if (expected && token === expected) {
        return new Response(challenge, { status: 200 });
      }
      console.warn(`[verify] token mismatch. Got: ${token?.slice(0, 8)}…  Configurado: ${!!expected}`);
      return new Response("Forbidden", { status: 403 });
    }

    return new Response("OK", { status: 200 });
  }

  // ── POST: Mensaje entrante o acción interna ──
  if (req.method === "POST") {
    // Tiempo de punta a punta (sql/136): se abre un turno recién cuando el mensaje ganó el candado de idempotencia y se
    // guarda en el `finally`, después de contestar. Un reintento de Meta no abre turno.
    const recibidoMs = Date.now();
    let turno: Turno | null = null;
    let errorTurno: string | null = null;
    try {
      // El cuerpo se lee CRUDO: la firma de Meta es un HMAC del texto exacto que llegó, así
      // que parsear y re-serializar rompería la verificación (cambia espacios y orden).
      const rawBody = await req.text();

      // deno-lint-ignore no-explicit-any
      let body: any;
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        console.warn("[webhook] body no es JSON válido");
        return new Response("OK", { status: 200 });
      }

      // TODO POST tiene que venir firmado por Meta (X-Hub-Signature-256). La vieja "acción
      // interna" `{"action":"flush"}` con `LK_INTERNAL_SECRET` se RETIRÓ (2026-09-10): era código
      // muerto — el flush del outbox lo hace el cron `wa_outbox_flush` → edge `lk_outbox-flush`,
      // no este webhook (verificado: 0 crons/repos la llamaban). Dejarla abierta era una puerta
      // pública sin uso. Ahora un POST que no sea un webhook legítimo de Meta se corta acá.
      const firma = await verificarFirmaMeta(rawBody, req.headers.get("x-hub-signature-256"));
      if (!firma.ok) {
        // Payload que dice ser de Meta y no lo es. Se corta acá, sin procesar.
        console.warn(`[firma] POST rechazado: ${firma.motivo}`);
        return new Response("Forbidden", { status: 403 });
      }
      if (firma.modo === "sin_secreto") {
        // Falta cargar META_APP_SECRET (ver webhook-firma.ts). Hoy YA está cargado.
        console.warn("[firma] META_APP_SECRET sin cargar — el POST NO se está verificando.");
      }

      // ── Statuses de Meta (delivery: sent/delivered/read/failed) ──
      // Cloud API v20+ los rutea junto al campo `messages`, dentro de
      // entry[].changes[].value.statuses[]. Los loggeamos en wa_message_status
      // para poder debuggear entregas silenciosas y saber si un template
      // fue delivered/read/failed post-envío.
      await ingestStatuses(body).catch((e) =>
        console.error("[statuses] falló:", e instanceof Error ? e.message : e),
      );

      // ── Webhook de Meta: mensaje entrante ──
      const msg = extractMessage(body);
      if (!msg) {
        return new Response("OK", { status: 200 });
      }

      // Un solo viaje trae toda app_settings a memoria (15 s): loadConfig y los candados de abajo ya no van a la base
      // por cada clave (auditoría 02/10).
      await primeSettings();
      const cfg = await loadConfig();

      // ── Pausa del bot (Pablo, 13/10): app_settings.wa_bot_pausa. Va ANTES de cualquier otra cosa que conteste, gaste o marque leído (adjuntos, audio, texto). Un
      // número que la whitelist iba a descartar igual sigue su camino de siempre. Cualquier valor que no sea 0, false, off, no o vacío pausa (_shared/pausa-bot.ts).
      if (botEnPausa(await getSetting(CLAVE_PAUSA)) && atiendeLaPausa(msg)) {
        const soloWhitelist = Number((await getSetting("wa_bot_solo_whitelist")) ?? "1") === 1;
        const enWhitelist = soloWhitelist ? await estaEnWhitelist(msg.from) : true;
        if (!sigueElCaminoNormal({ pausa: true, soloWhitelist, enWhitelist })) {
          await atenderPausa(msg);
          return new Response("OK", { status: 200 });
        }
      }

      // Adjuntos (imagen, documento, audio, video, sticker): se guardan y se pasan a una
      // persona (ver handleAdjunto).
      const TIPOS_ADJUNTO = ["image", "document", "audio", "video", "sticker"];
      if (TIPOS_ADJUNTO.includes(msg.type)) {
        // Candado de idempotencia (sql/057) también para adjuntos: leer un pedido por archivo con la IA puede tardar y
        // Meta reintenta; sin esto la tarea salía dos veces (29/09). Devuelve `first_seen` para el audio transcripto.
        let firstSeenAdj: string | null = null;
        if (msg.msgId) {
          const { data: vistoA, error: dupA } = await supabase.from("wa_inbound_seen")
            .insert({ wamid: msg.msgId, phone: msg.from }).select("first_seen").maybeSingle();
          firstSeenAdj = vistoA?.first_seen ?? null;
          if (dupA?.code === "23505") { console.log(`[idem] adjunto repetido, se ignora: ${msg.msgId}`); return new Response("OK", { status: 200 }); }
          turno = abrirTurno({ wamid: msg.msgId, phone: msg.from, tipo: msg.type, metaTimestamp: msg.timestamp, recibidoMs });
        }
        if (msg.type === "audio") {
          const a = await textoDeAudio(msg, cfg);
          if (a.texto) {
            // Eco de lo que se entendió, antes de contestar (queda en la conversación: se ve que fue un audio y qué escuchó el bot).
            if (await audioEco()) {
              try {
                const eco = textoEco(a.texto);
                await enviarTexto(cfg, msg.from, eco);
                await saveMessage(msg.from, "assistant", eco);
              } catch (e) { console.error("[audio] eco falló:", e instanceof Error ? e.message : e); }
            }
            await conAvisoFueraDeHorario(msg.from, cfg, () => handleMessage(msg.from, a.texto!, msg.msgId, msg.name, cfg, firstSeenAdj));
            return new Response("OK", { status: 200 });
          }
          await conAvisoFueraDeHorario(msg.from, cfg, () => handleAdjunto(msg, cfg, a.intentado ? MSG_AUDIO_NO_ENTENDIDO : undefined));
          return new Response("OK", { status: 200 });
        }
        await conAvisoFueraDeHorario(msg.from, cfg, () => handleAdjunto(msg, cfg));
        return new Response("OK", { status: 200 });
      }

      // Solo procesar mensajes de texto por ahora
      if (msg.type !== "text" || !msg.text.trim()) {
        return new Response("OK", { status: 200 });
      }

      // ── Candado de idempotencia (sql/057) ──
      // Meta REINTENTA el webhook si no ve el 200 a tiempo. Sin esto el mismo mensaje se
      // contesta dos veces y, si era la confirmación de un pedido, el pedido se duplica.
      // El insert es atómico: si la fila ya estaba, es un reintento y se corta acá.
      // Devuelve `first_seen`: handleMessage lo usa para el saludo suelto y la ráfaga de pedido (antes lo volvía a leer).
      let firstSeen: string | null = null;
      if (msg.msgId) {
        const { data: visto, error: dup } = await supabase
          .from("wa_inbound_seen")
          .insert({ wamid: msg.msgId, phone: msg.from })
          .select("first_seen")
          .maybeSingle();
        firstSeen = visto?.first_seen ?? null;
        if (dup) {
          // 23505 = unique_violation → ya lo procesamos. Cualquier otro error NO frena el
          // mensaje: preferimos contestar dos veces antes que no contestar nunca.
          if (dup.code === "23505") {
            console.log(`[idem] wamid repetido, se ignora: ${msg.msgId}`);
            return new Response("OK", { status: 200 });
          }
          console.error("[idem] no se pudo registrar el wamid, se sigue igual:", dup.message);
        }
        turno = abrirTurno({ wamid: msg.msgId, phone: msg.from, tipo: msg.type, metaTimestamp: msg.timestamp, recibidoMs });
      }

      // Procesar (Meta tolera hasta 20s de respuesta)
      await conAvisoFueraDeHorario(msg.from, cfg, () => handleMessage(msg.from, msg.text, msg.msgId, msg.name, cfg, firstSeen));
    } catch (e) {
      console.error("Error procesando mensaje:", e);
      errorTurno = e instanceof Error ? e.message : String(e);
    } finally {
      if (turno) await guardarTurno(supabase, turno, errorTurno);
    }

    // Siempre responder 200 a Meta (no perder webhook)
    return new Response("OK", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
});
