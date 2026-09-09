// Claude API — Tool-use conversacional para bot WhatsApp Loekemeyer
// Usa RPCs bot_* existentes como herramientas de Claude

import { supabase } from "./supabase.ts";
import { notificarHumano } from "./alertas.ts";
import { getAgenteConfig } from "./agente.ts";
import { REGLAS_OPERATIVAS, bloqueSeguridad } from "./agente-fijos.ts";
import {
  callModel,
  esCulpaDelRequest,
  logUsage,
  markModelDown,
  type NormMsg,
  type ResolvedModel,
  resolveChain,
} from "./bot-llm.ts";

// ─── Tool definitions (mapean a RPCs bot_*) ────────────────────────

// deno-lint-ignore no-explicit-any
type ToolDef = { name: string; description: string; input_schema: any };

const BOT_TOOLS: ToolDef[] = [
  {
    name: "consultar_mis_pedidos",
    description:
      "Consulta los pedidos recientes del cliente. Muestra IDs (NP-xxx), fechas, totales, método de pago, cantidad de ítems y cajas.",
    input_schema: {
      type: "object",
      properties: {
        limite: {
          type: "integer",
          description: "Cantidad de pedidos a mostrar (default 5, máx 10)",
        },
      },
    },
  },
  {
    name: "consultar_detalle_pedido",
    description:
      "Muestra el detalle de un pedido: ítems, códigos, cantidades (cajas), precios por línea y total. Usar order_id si se conoce el NP, o indice para referencia relativa (1 = más reciente).",
    input_schema: {
      type: "object",
      properties: {
        order_id: {
          type: "integer",
          description: "ID numérico del pedido (el número después de NP-)",
        },
        indice: {
          type: "integer",
          description:
            "Posición en la lista de pedidos (1 = más reciente). Usar cuando el cliente dice 'el último', 'el primero', 'el de arriba', etc.",
        },
      },
    },
  },
  {
    name: "consultar_mi_entrega",
    description:
      "Estado de entregas del cliente: pedidos programados, recibidos, a programar, y entregados recientemente (últimos 2 meses). Incluye fecha de entrega cuando existe.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "consultar_mis_descuentos",
    description:
      "Muestra los descuentos del cliente: descuento por volumen personal, descuento web, y rangos de descuento por cantidad de cajas.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "buscar_productos",
    description:
      "Busca productos en el catálogo por nombre, código o categoría. Devuelve código, descripción, precio de lista, unidades por bulto (uxb) y si tiene imagen.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Término de búsqueda" },
        limite: {
          type: "integer",
          description: "Cantidad de resultados (default 10, máx 20)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "consultar_novedades",
    description: "Lista productos nuevos (badge NUEVO) y en liquidación (badge LIQUIDACIÓN).",
    input_schema: {
      type: "object",
      properties: {
        limite: {
          type: "integer",
          description: "Cantidad de productos (default 10, máx 30)",
        },
      },
    },
  },
  {
    name: "consultar_mis_top_productos",
    description:
      "Productos más comprados por este cliente en los últimos 12 meses, con total de cajas. Útil para repetir pedidos habituales.",
    input_schema: {
      type: "object",
      properties: {
        limite: {
          type: "integer",
          description: "Cantidad de productos (default 5, máx 20)",
        },
      },
    },
  },
  {
    name: "enviar_catalogo",
    description: "Envía el catálogo PDF completo de productos al cliente por WhatsApp.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "enviar_fotos_producto",
    description:
      "Envía las fotos de un producto específico al cliente por WhatsApp. Necesita el código del producto.",
    input_schema: {
      type: "object",
      properties: {
        cod: { type: "string", description: "Código del producto (ej: '505')" },
      },
      required: ["cod"],
    },
  },
  {
    name: "consultar_kb",
    description:
      "Busca en la base de conocimiento del negocio: preguntas frecuentes, políticas, horarios, condiciones comerciales. Usar cuando el cliente pregunta algo que no cubren las otras herramientas.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Consulta a buscar" },
      },
      required: ["query"],
    },
  },
  {
    name: "enviar_pedido",
    description:
      "Envía/confirma un pedido del cliente. SOLO usar después de que el cliente confirmó explícitamente los productos y cantidades. Primero buscar productos con buscar_productos para obtener los códigos, mostrar resumen al cliente, y recién cuando confirme usar esta herramienta.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Lista de productos a pedir",
          items: {
            type: "object",
            properties: {
              cod: { type: "string", description: "Código del producto (ej: '505')" },
              cajas: { type: "integer", description: "Cantidad de cajas" },
            },
            required: ["cod", "cajas"],
          },
        },
        metodo_pago: {
          type: "string",
          enum: ["transferencia", "debito", "efectivo", "cheque"],
          description: "Método de pago (default: transferencia)",
        },
      },
      required: ["items"],
    },
  },
];

// ─── System prompt ─────────────────────────────────────────────────

async function buildSystemPrompt(
  customerName: string,
  codCliente: number,
  dtoVol: number,
): Promise<string> {
  const dtoText =
    dtoVol > 0
      ? `${(dtoVol * 100).toFixed(0)}%`
      : "sin descuento por volumen asignado";

  // Documento rector EDITABLE desde el Panel ("Configuración del agente" →
  // wa_agente_config). Define Objetivo / Limitaciones / Permisos del agente y
  // se inyecta como una sección más. Las reglas operativas y de Seguridad de
  // abajo quedan FIJAS en código (no editables) y tienen prioridad sobre él.
  let rector = "";
  try {
    rector = (await getAgenteConfig()).trim();
  } catch { /* si falla, seguimos sin doc rector */ }
  const rectorBloque = rector
    ? `\nDocumento rector (definido por Loekemeyer desde el Panel — respetalo salvo que contradiga la Seguridad de más abajo):\n---\n${rector}\n---\n`
    : "";

  return `Sos el asistente WhatsApp de Loekemeyer Hnos S.R.L., fábrica de cubiertos y artículos de cuchillería.
Atendés a clientes mayoristas. Sos amable, conciso y profesional.

Cliente actual: ${customerName} (código: ${codCliente})
Descuento por volumen: ${dtoText}

Información del negocio:
- Venta exclusivamente mayorista (no minorista)
- Pedido mínimo: $500.000
- Retiro mínimo en fábrica: $300.000
- Descuento por pago web: 2%
- Contacto ventas: ventas@loekemeyer.com / WhatsApp 1131181021
- Cobranzas: +54 11 6557-4113
- Web: loekemeyer.com
${rectorBloque}
${REGLAS_OPERATIVAS}

${bloqueSeguridad(customerName, codCliente)}`;
}

// ─── Tool execution (despacho a RPCs bot_*) ────────────────────────

export interface MediaAction {
  type: "image" | "document";
  url: string;
  caption?: string;
  filename?: string;
}

interface ToolExecResult {
  // deno-lint-ignore no-explicit-any
  data: any;
  media?: MediaAction[];
}

async function executeTool(
  name: string,
  // deno-lint-ignore no-explicit-any
  input: Record<string, any>,
  phone: string,
): Promise<ToolExecResult> {
  switch (name) {
    case "consultar_mis_pedidos": {
      const { data, error } = await supabase.rpc("bot_mis_pedidos", {
        p_telefono: phone,
        p_limit: input.limite ?? 5,
      });
      if (error) return { data: { error: error.message } };
      if (!data?.length) return { data: { mensaje: "No tenés pedidos registrados." } };
      return { data };
    }

    case "consultar_detalle_pedido": {
      if (input.indice) {
        const { data, error } = await supabase.rpc("bot_detalle_por_indice", {
          p_telefono: phone,
          p_indice: input.indice,
        });
        if (error) return { data: { error: error.message } };
        if (!data?.length) return { data: { mensaje: "No se encontró un pedido en esa posición." } };
        return { data };
      }
      if (input.order_id) {
        const { data, error } = await supabase.rpc("bot_detalle_pedido", {
          p_telefono: phone,
          p_order_id: input.order_id,
        });
        if (error) return { data: { error: error.message } };
        if (!data?.length) return { data: { mensaje: "No se encontró ese pedido o no te pertenece." } };
        return { data };
      }
      return { data: { error: "Necesito order_id o indice para buscar el detalle." } };
    }

    case "consultar_mi_entrega": {
      const { data, error } = await supabase.rpc("bot_mi_entrega", {
        p_telefono: phone,
      });
      if (error) return { data: { error: error.message } };
      if (!data?.length) return { data: { mensaje: "No hay entregas recientes ni programadas." } };
      return { data };
    }

    case "consultar_mis_descuentos": {
      const { data, error } = await supabase.rpc("bot_mis_descuentos", {
        p_telefono: phone,
      });
      if (error) return { data: { error: error.message } };
      if (!data?.length) return { data: { mensaje: "No se pudieron obtener los descuentos." } };
      return { data };
    }

    case "buscar_productos": {
      const { data, error } = await supabase.rpc("bot_buscar_productos", {
        p_query: input.query,
        p_limit: input.limite ?? 10,
      });
      if (error) return { data: { error: error.message } };
      if (!data?.length) return { data: { mensaje: `No encontré productos para "${input.query}".` } };
      return { data };
    }

    case "consultar_novedades": {
      const { data, error } = await supabase.rpc("bot_productos_novedades", {
        p_limit: input.limite ?? 10,
      });
      if (error) return { data: { error: error.message } };
      if (!data?.length) return { data: { mensaje: "No hay novedades ni liquidaciones en este momento." } };
      return { data };
    }

    case "consultar_mis_top_productos": {
      const { data, error } = await supabase.rpc("bot_mis_top_productos", {
        p_telefono: phone,
        p_limit: input.limite ?? 5,
      });
      if (error) return { data: { error: error.message } };
      if (!data?.length) return { data: { mensaje: "No hay historial de compras para este cliente." } };
      return { data };
    }

    case "enviar_catalogo": {
      const { data } = await supabase.rpc("bot_obtener_catalogo_url");
      const url = typeof data === "string"
        ? data
        : Array.isArray(data)
          ? data[0]?.bot_obtener_catalogo_url ?? data[0]
          : String(data);
      return {
        data: { enviado: true, url },
        media: [{
          type: "document",
          url: String(url),
          filename: "Catalogo_Loekemeyer.pdf",
          caption: "Catálogo de productos Loekemeyer",
        }],
      };
    }

    case "enviar_fotos_producto": {
      const { data, error } = await supabase.rpc("bot_obtener_imagenes_producto", {
        p_cod: input.cod,
      });
      if (error || !data?.length) {
        return { data: { error: "Producto no encontrado o sin imágenes disponibles." } };
      }
      const product = data[0];
      const images: string[] = product.image_urls ?? [];
      if (!images.length) {
        return { data: { error: `El producto ${product.cod} no tiene fotos cargadas.` } };
      }
      return {
        data: {
          cod: product.cod,
          description: product.description,
          cantidad_fotos: images.length,
        },
        media: images.map((url: string) => ({
          type: "image" as const,
          url,
          caption: `${product.cod} — ${product.description}`,
        })),
      };
    }

    case "consultar_kb": {
      const { data, error } = await supabase.rpc("bot_kb_consultar", {
        p_query: input.query,
        p_limit: 5,
      });
      if (error) return { data: { error: error.message } };
      if (!data?.length) {
        return { data: { mensaje: "No encontré información sobre eso en la base de conocimiento." } };
      }
      return { data };
    }

    case "enviar_pedido": {
      const items = input.items;
      if (!Array.isArray(items) || !items.length) {
        return { data: { error: "Se necesita al menos un item con cod y cajas." } };
      }

      const jsonItems = items.map((it: { cod: string; cajas: number }) => ({
        cod: String(it.cod),
        cajas: Number(it.cajas),
      }));

      const { data, error } = await supabase.rpc("bot_submit_order", {
        p_telefono: phone,
        p_items: jsonItems,
        p_payment_method: input.metodo_pago ?? "transferencia",
      });

      if (error) {
        console.error("Error en bot_submit_order:", error.message);
        if (error.message.includes("no encontrado")) {
          return { data: { error: `Producto no encontrado: ${error.message}` } };
        }
        if (error.message.includes("no identificado")) {
          return { data: { error: "No se pudo identificar al cliente." } };
        }
        return { data: { error: `Error al enviar el pedido: ${error.message}` } };
      }

      if (!data?.length) {
        return { data: { error: "No se obtuvo respuesta del sistema de pedidos." } };
      }

      const result = data[0];
      return {
        data: {
          pedido_enviado: true,
          order_id: result.order_id,
          subtotal: result.subtotal,
          total: result.total,
          items_count: result.items_count,
          metodo_pago: input.metodo_pago ?? "transferencia",
        },
      };
    }

    default:
      return { data: { error: `Herramienta desconocida: ${name}` } };
  }
}

// ─── Auditoría de tools ────────────────────────────────────────────

const AUDITABLE_TOOLS = new Set([
  "buscar_productos", "enviar_catalogo", "enviar_fotos_producto",
  "consultar_kb", "kb_agregar", "kb_eliminar", "kb_listar",
  "inbox_send", "inbox_set_modo", "auto_pausa_humano", "auto_retomar_bot",
  "consultar_mi_historial", "consultar_mis_pedidos", "consultar_detalle_pedido",
  "consultar_mis_descuentos", "consultar_novedades",
]);

async function auditTool(
  phone: string,
  tool: string,
  // deno-lint-ignore no-explicit-any
  params: Record<string, any>,
  resumen: string,
): Promise<void> {
  if (!AUDITABLE_TOOLS.has(tool)) return;
  try {
    await supabase.rpc("bot_auditar_tool", {
      p_telefono: phone,
      p_tool: tool,
      p_params: params,
      p_resumen: resumen.slice(0, 500),
    });
  } catch {
    // Auditoría no debe romper el flujo
  }
}

// ─── Historial de conversación ─────────────────────────────────────

export async function loadHistory(
  phone: string,
  limit = 20,
  // deno-lint-ignore no-explicit-any
): Promise<Array<{ rol: string; contenido: string; creado_en: string }>> {
  const { data, error } = await supabase.rpc("bot_leer_historial", {
    p_telefono: phone,
    p_limit: limit,
  });
  if (error || !data) return [];
  return data;
}

export async function saveMessage(
  phone: string,
  rol: "user" | "assistant",
  contenido: string,
): Promise<void> {
  try {
    await supabase.rpc("bot_guardar_mensaje", {
      p_telefono: phone,
      p_rol: rol,
      p_contenido: contenido.slice(0, 10000),
    });
  } catch (e) {
    console.error("Error guardando mensaje:", e);
  }
}

// ─── Conversation runner (loop tool-use) ───────────────────────────

export interface ConversationResult {
  reply: string;
  media: MediaAction[];
  /**
   * true = el LLM no respondió a tiempo (o el fetch falló irrecuperable).
   * El call-site NO debe enviar `reply` al cliente: la política actual es
   * quedarnos callados y avisar a un humano vía `wa_alertas_humano`.
   * `reply` viene con un texto informativo solo para que la UI de test
   * pueda mostrarlo como alerta interna.
   */
  timeout?: boolean;
  /** true = falla del LLM que no es timeout (HTTP 4xx/5xx). Misma política que timeout. */
  llmError?: boolean;
}

export async function runConversation(
  userText: string,
  phone: string,
  customerName: string,
  codCliente: number,
  dtoVol: number,
  apiKey: string,
  fuente = "lk_whatsapp-webhook",
): Promise<ConversationResult> {
  const systemPrompt = await buildSystemPrompt(customerName, codCliente, dtoVol);

  const rawHistory = await loadHistory(phone, 16);
  // Historial NORMALIZADO (agnóstico de proveedor). Cada adaptador de `bot-llm`
  // lo traduce entero en cada llamada, así el failover puede cambiar de proveedor
  // en cualquier iteración sin romper el formato.
  const history: NormMsg[] = [];
  for (let i = rawHistory.length - 1; i >= 0; i--) {
    const h = rawHistory[i];
    if (h.rol === "user") history.push({ role: "user", text: h.contenido });
    else history.push({ role: "assistant", text: h.contenido, toolCalls: [] });
  }

  // El primer mensaje tiene que ser `user` (lo exigen Anthropic y Gemini). La
  // ventana de 16 filas puede arrancar con `assistant` → se recorta hasta el
  // primer `user`.
  while (history.length && history[0].role !== "user") history.shift();

  // El turno actual puede estar YA en el historial: el webhook hace
  // `saveMessage(phone, "user", text)` antes de llamar acá, así que pushearlo de
  // nuevo lo duplica. `lk_chat-test` NO guarda antes — por eso se chequea.
  const last = history[history.length - 1];
  if (!(last && last.role === "user" && last.text === userText)) {
    history.push({ role: "user", text: userText });
  }

  // Cadena de modelos (prioridad ASC) + fallback duro al env ANTHROPIC_API_KEY con
  // Sonnet, para que el bot siga contestando aunque la cadena esté vacía o toda caída.
  const candidates: ResolvedModel[] = await resolveChain();
  if (apiKey) {
    candidates.push({ id: 0, provider: "anthropic", model: "claude-sonnet-4-6", key: apiKey, isFreeTier: false });
  }
  if (!candidates.length) {
    await notificarHumano({ tipo: "llm_error", phone, contexto: { userText, error: "Sin modelos en la cadena ni ANTHROPIC_API_KEY" } });
    return { reply: "⚠️ [LLM_ERROR] No hay modelos configurados. Se avisó a un humano.", media: [], llmError: true };
  }

  const allMedia: MediaAction[] = [];
  const downThisTurn = new Set<number>(); // modelos que ya fallaron en este turno

  for (let iter = 0; iter < 5; iter++) {
    let res = null as Awaited<ReturnType<typeof callModel>> | null;
    let used: ResolvedModel | null = null;
    let lastErr = "";
    let lastStatus: number | undefined;

    // Failover: probamos la cadena en orden hasta que un modelo responda.
    for (const cand of candidates) {
      if (downThisTurn.has(cand.id)) continue;
      try {
        res = await callModel(cand, systemPrompt, BOT_TOOLS, history, 30_000);
        used = cand;
        break;
      } catch (e) {
        const emsg = e instanceof Error ? e.message : String(e);
        // deno-lint-ignore no-explicit-any
        lastStatus = (e as any)?.status as number | undefined;
        lastErr = emsg;
        console.error(`[runConversation] ${cand.provider}/${cand.model} falló: ${emsg}`);

        // Con cadena multi-proveedor, SIEMPRE probamos el próximo candidato: un 400 puede
        // ser un schema que ESE proveedor no acepta (y otro sí), no un error universal.
        // Lo saltamos este turno igual (reintentar el mismo da el mismo error).
        downThisTurn.add(cand.id);

        // Sólo penalizamos con cooldown persistente si la culpa es del modelo
        // (401/403/404/429/5xx/timeout). Un 400/413/422 es del request → no cooldown,
        // así no dejamos caído un modelo bueno por un payload puntual.
        if (!esCulpaDelRequest(lastStatus)) {
          markModelDown(cand.id, emsg).catch(() => {});
        }
      }
    }

    if (!res || !used) {
      // Toda la cadena cayó (incluido el fallback de env).
      const isTimeout = /timeout|abort/i.test(lastErr);
      await notificarHumano({ tipo: isTimeout ? "llm_timeout" : "llm_error", phone, contexto: { userText, iter, error: lastErr.slice(0, 500) } });
      return {
        reply: isTimeout
          ? "⏳ [TIMEOUT] El LLM no respondió a tiempo. Se avisó a un humano; el cliente no recibió mensaje."
          : `⚠️ [LLM_ERROR] ${lastErr}. Se avisó a un humano; el cliente no recibió mensaje.`,
        media: allMedia,
        timeout: isTimeout,
        llmError: !isTimeout,
      };
    }

    // Log de tokens/costo (alimenta el panel "IA — gastos y uso").
    logUsage(res, used.isFreeTier, phone, fuente);

    if (!res.toolCalls.length) {
      return { reply: res.text || "¿En qué más te puedo ayudar?", media: allMedia };
    }

    // El modelo pidió herramientas: las ejecutamos y devolvemos los resultados.
    history.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });

    const results: { id: string; name: string; content: string }[] = [];
    for (const tc of res.toolCalls) {
      const result = await executeTool(tc.name, tc.input ?? {}, phone);
      if (result.media) allMedia.push(...result.media);
      auditTool(phone, tc.name, tc.input ?? {}, JSON.stringify(result.data).slice(0, 500)).catch(() => {});
      results.push({ id: tc.id, name: tc.name, content: JSON.stringify(result.data) });
    }
    history.push({ role: "tool", results });
  }

  return {
    reply: "Disculpá, no pude completar tu consulta. ¿Podés reformular tu pregunta?",
    media: allMedia,
  };
}
