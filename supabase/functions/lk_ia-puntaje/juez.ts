// Lo que ve el juez de lk_ia-puntaje (puntaje de las respuestas de la IA). Funciones puras, sin red: tests/puntaje-juez.test.ts.
//
// Problemas 818 y 819 de la auditoría (Pablo Olejavetzky, 15/10/2026):
//  · 818: el juez recibía siempre REGLAS_OPERATIVAS (la línea «por ahora NO se toman pedidos por WhatsApp»), pero con
//    app_settings.wa_pedidos_config.activo = true el agente usa REGLA_PEDIDOS_WA. Toda respuesta que tomaba un pedido salía marcada.
//    Ahora el juez recibe las mismas reglas que el agente (reglasOperativas) y su criterio «reglas» lo dice según el caso.
//  · 819: la charla previa se leía de wa_conversations, sin filas desde el 05/10 (el historial real está en bot_historial_chat),
//    así que el juez puntuaba sin ver la charla («sin charla previa» en sus comentarios).
import { reglasOperativas } from "../_shared/agente-fijos.ts";

/** Prompt del sistema del juez. `pedidosWa` = el agente toma pedidos por WhatsApp (misma condición que lk_whatsapp-webhook). */
export const sistema = (pedidosWa: boolean): string => `Sos un evaluador de calidad de un bot de WhatsApp de Loekemeyer Hnos (mayorista de artículos de cocina y bazar).
Te paso la charla previa, el último mensaje del cliente, las herramientas que usó el bot con lo que devolvieron, y la respuesta del bot.
Puntuá la RESPUESTA DEL BOT de 1 (muy mal) a 5 (perfecta) en 5 criterios:
- correcta: los datos que da (fechas, importes, estados, stock, precios) coinciden con lo que devolvieron las herramientas; no inventa nada. Si no da datos, 5.
- resolvio: contesta lo que el cliente preguntó o pidió (no otra cosa, no lo deja sin respuesta).
- derivo: derivó a una persona cuando hacía falta (reclamo, pago que no coincide, cambio que no puede resolver, pidió una persona) y NO derivó lo que podía resolver solo. Si no hacía falta derivar y no derivó, 5.
- reglas: respeta las reglas del bot que están abajo (no pide ni da número de pedido ni CUIT, ${pedidosWa ? "toma pedidos por WhatsApp sólo como dicen las reglas de abajo" : "no toma pedidos por WhatsApp"}, no manda a otro mail o teléfono, stock sin números, formato WhatsApp, etc.).
- tono: breve, amable, claro, en español argentino, sin repetirse.
Respondé SOLO un JSON: {"correcta":n,"resolvio":n,"derivo":n,"reglas":n,"tono":n,"comentario":"una frase: qué estuvo mal, o 'bien' si todo 4 o más"}

Reglas del bot:
${reglasOperativas(pedidosWa)}`;

/**
 * ¿El agente tomaba pedidos por WhatsApp al contestar? Misma condición que `pedidosWaHabilitados()` (_shared/bot-conversation.ts):
 * `activo`, o (sólo en el Simulador) `simulador` distinto de false. `cfg` es lo que devuelve la RPC wa_pedidos_cfg.
 */
// deno-lint-ignore no-explicit-any
export function pedidosWaParaFila(cfg: any, esPrueba: boolean): boolean {
  return cfg?.activo === true || (esPrueba && cfg?.simulador !== false);
}

export interface FilaHistorial { rol: string; contenido: string | null; creado_en: string }

const norm = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim();
const LARGO_CLAVE = 120;   // cuántos caracteres de la pregunta se comparan para ubicar el turno evaluado

/**
 * Charla previa que ve el juez: los `max` mensajes anteriores al turno evaluado, del más viejo al más nuevo.
 * `filas` viene de bot_historial_chat (hasta unos segundos después de la respuesta). El turno evaluado se ubica por su pregunta
 * (el mensaje del cliente más nuevo que empieza igual) y se corta ahí: lo que sigue es el propio turno. Si la pregunta no se
 * encuentra (adjuntos, mensajes unidos), se usa lo anterior a un minuto antes del puntaje, como antes.
 */
export function armarCharlaPrevia(filas: FilaHistorial[], pregunta: string, creadoIso: string, max = 6): string {
  const orden = [...filas].sort((a, b) => Date.parse(a.creado_en) - Date.parse(b.creado_en));   // viejo → nuevo
  const clave = norm(pregunta).slice(0, LARGO_CLAVE);
  let corte = -1;
  if (clave) {
    for (let i = orden.length - 1; i >= 0; i--) {
      if (orden[i].rol === "user" && norm(orden[i].contenido).startsWith(clave)) { corte = i; break; }
    }
  }
  const previas = corte >= 0
    ? orden.slice(0, corte)
    : orden.filter((f) => Date.parse(f.creado_en) < Date.parse(creadoIso) - 60_000);
  return previas.slice(-max)
    .map((m) => `${m.rol === "user" ? "Cliente" : "Bot"}: ${String(m.contenido ?? "").slice(0, 500)}`).join("\n") || "(sin charla previa)";
}
