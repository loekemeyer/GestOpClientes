// Pausa del bot (Pablo Olejavetzky, 13/10/2026, plan de producción, Fase 0 punto 5 "Pausa ensayada").
//
// Antes no había forma de callar al bot sin borrar filas: `wa_bot_solo_whitelist` hace lo CONTRARIO de lo que su nombre sugiere
// (en 0 el bot contesta a TODOS los clientes), y la única pausa era vaciar `wa_envio_contactos`, un DELETE que pide el "sí" de Pablo
// cada vez. Principio del dueño (Luis, 25/09): cortes quirúrgicos, no apagar veinte cosas. Esto es UNO:
//
//   update app_settings set value = '1' where key = 'wa_bot_pausa';   -- pausa
//   update app_settings set value = '0' where key = 'wa_bot_pausa';   -- vuelve (o borrar la fila)
//
// Con la pausa prendida el webhook NO contesta a nadie de los que el bot atiende: no corre la IA, ni las respuestas fijas, ni el alta, ni
// la lectura de cotizadores o audios (no gasta), ni marca leído, ni manda el aviso de fuera de horario. Lo que sí hace, por cada mensaje:
// lo guarda en la conversación (para que la persona que atiende lo vea en Conversaciones) y deja UNA alerta `bot_pausa` por teléfono cada
// 30 minutos, que va a Planify. Lo que no toca: la atención manual desde el panel, los estados de Meta (wa_message_status), el Simulador y
// el Chat de prueba, y los avisos automáticos de pedidos y facturas (esos se cortan con `wa_envio_automatico = 0`).
// Un número que la whitelist ya descartaría sigue su camino de siempre (descarte silencioso): la pausa no le llena la cola a nadie.
//
// Módulo PURO (sin red ni base): se prueba en tests/pausa-bot.test.ts.
import { lineaSegura } from "./dato-externo.ts";

export const CLAVE_PAUSA = "wa_bot_pausa";
/** Motivo de la alerta (contexto.motivo): está registrado en alertas-vencimiento.ts, derivaciones.ts, semaforo.ts y los nombres del panel. */
export const MOTIVO_PAUSA = "bot_pausa";
/** Una alerta por teléfono cada tanto: un cliente que escribe diez veces seguidas no abre diez tareas. */
export const MINUTOS_ENTRE_AVISOS_PAUSA = 30;
/** Los tipos de mensaje que el bot atiende hoy (texto) o recibe y pasa a una persona (adjuntos). Lo demás (ubicación, reacción…) ya se ignora sin pausa. */
export const TIPOS_ADJUNTO = ["image", "document", "audio", "video", "sticker"];

// Falla del lado seguro: cualquier valor que NO sea claramente "apagado" pausa. "1", "si", "true", "pausa", un espacio con letras… pausan; vacío, "0", "false",
// "off" y "no" no. Así un error de tipeo en la llave calla al bot en vez de dejarlo contestando.
const APAGADO = new Set(["", "0", "false", "off", "no"]);

/** ¿Está prendida la pausa? `valor` es `app_settings.wa_bot_pausa` (sin fila = null = no hay pausa). */
export function botEnPausa(valor: string | null | undefined): boolean {
  return !APAGADO.has(String(valor ?? "").trim().toLowerCase());
}

/** ¿El mensaje sigue el camino de siempre? Sí si no hay pausa, o si hay pausa pero la whitelist lo iba a descartar igual (no es del piloto). */
export function sigueElCaminoNormal(e: { pausa: boolean; soloWhitelist: boolean; enWhitelist: boolean }): boolean {
  return !e.pausa || (e.soloWhitelist && !e.enWhitelist);
}

/** ¿Es un mensaje que la pausa atiende (guardar + alerta)? Texto con contenido, o un adjunto. */
export function atiendeLaPausa(m: { type: string; text?: string }): boolean {
  return TIPOS_ADJUNTO.includes(m.type) || (m.type === "text" && String(m.text ?? "").trim().length > 0);
}

/** Lo que queda en la conversación: el texto tal cual, o la misma etiqueta que usa el camino de adjuntos (`[ADJUNTO IMAGE] pie de foto`). */
export function textoParaGuardar(m: { type: string; text?: string; caption?: string }): string {
  if (!TIPOS_ADJUNTO.includes(m.type)) return String(m.text ?? "");
  const cap = String(m.caption ?? "").trim();
  return cap ? `[ADJUNTO ${m.type.toUpperCase()}] ${cap}` : `[ADJUNTO ${m.type.toUpperCase()}]`;
}

/** El contexto de la alerta. El texto y el nombre los escribe un tercero: van en UNA línea, sin enlaces ni corchetes (dato-externo.ts). */
export function contextoAlertaPausa(m: { type: string; text?: string; caption?: string; name?: string; msgId?: string }): Record<string, unknown> {
  return {
    motivo: MOTIVO_PAUSA,
    origen: "webhook",
    texto_recibido: lineaSegura(m.type === "text" ? m.text : (m.caption ?? ""), 200),
    tipo_mensaje: m.type,
    contact_name: lineaSegura(m.name, 80) || null,
    wamid: m.msgId ?? null,
  };
}
