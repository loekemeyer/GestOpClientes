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
  // Pablo, 08/10: lo que pasó en TODA la simulación (alertas y herramientas se vacían en cada paso), con la hora, para el bloque
  // "Hechos de esta charla" (hechos-charla.ts). Lo vacía empezarCharlaSim al arrancar cada simulación y lo llena guardarPasoSim.
  charla: {
    alertas: [] as Array<{ tipo: string; estado: string; motivo: string | null; created_at: string }>,
    acciones: [] as Array<{ nombre: string; parametros: Record<string, unknown> | null; resultado: null; creado_en: string }>,
  },
};

export function empezarCharlaSim(): void {
  SIM.charla = { alertas: [], acciones: [] };
}

/** Pasa las alertas y herramientas del paso que terminó a SIM.charla (antes de que el paso siguiente las vacíe). */
export function guardarPasoSim(ahora = new Date().toISOString()): void {
  for (const a of SIM.alertas) {
    SIM.charla.alertas.push({ tipo: String(a.tipo ?? "otro"), estado: "pendiente", motivo: a.motivo ? String(a.motivo) : null, created_at: ahora });
  }
  for (const h of SIM.herramientas) {
    const p = h.input && typeof h.input === "object" ? h.input as Record<string, unknown> : null;
    SIM.charla.acciones.push({ nombre: h.nombre, parametros: p, resultado: null, creado_en: ahora });
  }
}

export const HERRAMIENTAS_CON_EFECTO = new Set([
  "enviar_pedido", "enviar_catalogo", "enviar_fotos_producto", "anotar_duda",
  "kb_agregar", "kb_eliminar", "inbox_send", "inbox_set_modo", "auto_pausa_humano", "auto_retomar_bot",
]);
