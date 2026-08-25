// Claude API — Tool-use conversacional para bot WhatsApp Loekemeyer
// Usa RPCs bot_* existentes como herramientas de Claude

import { supabase } from "./supabase.ts";

const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

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
];

// ─── System prompt ─────────────────────────────────────────────────

function buildSystemPrompt(
  customerName: string,
  codCliente: number,
  dtoVol: number,
): string {
  const dtoText =
    dtoVol > 0
      ? `${(dtoVol * 100).toFixed(0)}%`
      : "sin descuento por volumen asignado";

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

Reglas:
- Respondé siempre en español argentino
- Sé breve (máximo 3-4 párrafos, es WhatsApp)
- Si no sabés algo, derivá a ventas
- Nunca inventes información de productos o precios — usá las herramientas
- Usá emojis con moderación
- Cuando muestres pedidos, formateá legible para WhatsApp (listas con emoji, sin tablas)
- Los precios son en ARS (pesos argentinos), formateá con punto de miles
- "cajas" es la unidad de venta mayorista, cada caja tiene N unidades (uxb = unidades por bulto)
- Si el cliente quiere hacer un pedido nuevo, explicale que por ahora puede hacerlo por la web (loekemeyer.com) o contactando a ventas`;
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
      // La RPC devuelve un text escalar
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

    default:
      return { data: { error: `Herramienta desconocida: ${name}` } };
  }
}

// ─── Auditoría de tools ────────────────────────────────────────────

// Tools auditables (validadas por bot_auditar_tool)
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

/** Lee historial reciente (devuelve más recientes primero) */
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

/** Guarda un mensaje al historial */
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
}

/**
 * Ejecuta una conversación completa con Claude usando tool-use.
 * Carga historial, ejecuta tools según necesite Claude, y devuelve
 * la respuesta final + media a enviar.
 */
export async function runConversation(
  userText: string,
  phone: string,
  customerName: string,
  codCliente: number,
  dtoVol: number,
  apiKey: string,
): Promise<ConversationResult> {
  const systemPrompt = buildSystemPrompt(customerName, codCliente, dtoVol);

  // Cargar historial (viene más reciente primero, lo invertimos)
  const rawHistory = await loadHistory(phone, 16);
  // deno-lint-ignore no-explicit-any
  const messages: Array<{ role: string; content: any }> = [];

  for (let i = rawHistory.length - 1; i >= 0; i--) {
    const h = rawHistory[i];
    messages.push({
      role: h.rol === "user" ? "user" : "assistant",
      content: h.contenido,
    });
  }

  // Agregar mensaje actual
  messages.push({ role: "user", content: userText });

  const allMedia: MediaAction[] = [];

  // Loop tool-use (máx 5 iteraciones)
  for (let iter = 0; iter < 5; iter++) {
    const resp = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        tools: BOT_TOOLS,
        messages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Claude API ${resp.status}: ${errText}`);
      return {
        reply: "Disculpá, estoy teniendo un problema técnico. Intentá de nuevo en unos minutos. 🙏",
        media: [],
      };
    }

    const data = await resp.json();
    // deno-lint-ignore no-explicit-any
    const content: any[] = data.content ?? [];
    const stopReason: string = data.stop_reason;

    // Si no hay tool_use, extraer texto y terminar
    if (stopReason !== "tool_use") {
      // deno-lint-ignore no-explicit-any
      const textBlock = content.find((b: any) => b.type === "text");
      return {
        reply: textBlock?.text ?? "¿En qué más te puedo ayudar?",
        media: allMedia,
      };
    }

    // Hay tool_use — ejecutar cada herramienta
    messages.push({ role: "assistant", content });

    // deno-lint-ignore no-explicit-any
    const toolResults: any[] = [];

    for (const block of content) {
      if (block.type !== "tool_use") continue;

      const result = await executeTool(block.name, block.input ?? {}, phone);

      // Acumular media (imágenes/documentos a enviar)
      if (result.media) allMedia.push(...result.media);

      // Auditar (async, no bloquea)
      auditTool(
        phone,
        block.name,
        block.input ?? {},
        JSON.stringify(result.data).slice(0, 500),
      ).catch(() => {});

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result.data),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Si llegamos acá, se agotaron las iteraciones
  return {
    reply: "Disculpá, no pude completar tu consulta. ¿Podés reformular tu pregunta?",
    media: allMedia,
  };
}
