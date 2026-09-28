// simulacion — estado del simulador del bot (lk_bot-simular). Pedido de Pablo Olejavetzky (28/09):
// probar respuestas antes de pedírselo a Thomy.
//
// Sólo lo prende lk_bot-simular (cada edge corre en su propio isolate, así que el webhook real nunca
// lo ve activo). Con SIM.activo:
//   - notificarHumano NO inserta: junta las alertas que habría creado en SIM.alertas.
//   - el historial sale de SIM.historial (en memoria), no de bot_historial_chat.
//   - las herramientas que escriben o envían (pedido, catálogo, fotos, KB, inbox) no se ejecutan.
//   - no se audita ni se cargan dudas en la cola de Consultas.
// Lo que SÍ se hace de verdad: lecturas (pedidos, stock, FAQ) y la llamada al modelo (se registra el costo).

export interface FilaHistorial { rol: "user" | "assistant"; contenido: string; creado_en: string }

export const SIM = {
  activo: false,
  alertas: [] as Array<Record<string, unknown>>,
  historial: [] as FilaHistorial[],
  herramientas: [] as Array<{ nombre: string; input: unknown; ejecutada: boolean }>,
};

export const HERRAMIENTAS_CON_EFECTO = new Set([
  "enviar_pedido", "enviar_catalogo", "enviar_fotos_producto",
  "kb_agregar", "kb_eliminar", "inbox_send", "inbox_set_modo", "auto_pausa_humano", "auto_retomar_bot",
]);
