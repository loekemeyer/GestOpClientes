// Claude API — Tool-use conversacional para bot WhatsApp Loekemeyer
// Usa RPCs bot_* existentes como herramientas de Claude

import { cacheSettingsTtl, getGestionClient, getSetting, supabase } from "./supabase.ts";
import { derivaciones, motivosIA } from "./derivaciones.ts";
import { notificarHumano } from "./alertas.ts";
import { ingresoEstimado, proximosIngresos, stockArticulo, stockNecesitaHumano, textoIngreso, textoStock } from "./stock.ts";
import { HERRAMIENTAS_CON_EFECTO, SIM } from "./simulacion.ts";
import { getAgenteConfig } from "./agente.ts";
import { bloqueSeguridad, reglasOperativas } from "./agente-fijos.ts";
import { sinCierreGenerico } from "./cierre.ts";
import { textoDeRespaldo } from "./respaldo-texto.ts";
import { estadoRetiroParaIA } from "./fecha-retiro.ts";
import { timeoutDeModelo } from "./timeouts.ts";
import { idModeloPrueba, listaModelosPrueba } from "./modelos-prueba.ts";
import { type AlertaAbierta, casoDeAgregado, textoClienteEnArmado, textoClienteEntregado, textoTareaEnArmado, yaHayAlertaIgual } from "./agregado-armado.ts";
import { candidatosDePedido, esTurnoDePedido, HERRAMIENTAS_DE_PEDIDO, modeloFijoDePedidos, RE_BOT_EN_PEDIDO } from "./pedido-turno.ts";
import { evaluarConfirmacion, type FilaHistorial, REGLA_BLOQUEO } from "./pedido-gate.ts";
import { mailEscritoPorElCliente, mailYaPedidoEnLaCharla, REGLA_MAIL_NO_ESCRITO, textoPedidoMail, textoYaPedidoMail, VIGENCIA_MAIL_MS } from "./mail-gate.ts";
import { decidirSalida, type Hallazgo, modoDelFiltro, redactarSecretos, revisarSalida, TEXTO_SALIDA_BLOQUEADA } from "./filtro-salida.ts";
import { derivarCanario, lineaCanario, taparCanario } from "./canario.ts";
import { lineaSegura } from "./dato-externo.ts";
import { bloqueEjemplos, type EjemploAprobado, elegirEjemplos, lectorConTope } from "./ejemplos-aprobados.ts";
import { hechosDeLaCharla } from "./hechos-charla.ts";
import { bloquePistas } from "./mensaje-compuesto.ts";
import { filasDeLaVentana, VENTANA_MIN, VENTANA_PASO } from "./ventana-historial.ts";
import { estadoPedidos, sinAnulados } from "./pedidos-anulados.ts";
import { CODIGOS_FORMA_DE_PAGO, formasDePago } from "./formas-pago.ts";
import { datosCobranzas, datosEmpresas, deudaChefPorCuit, textoDatosPago } from "./empresas.ts";
import { fmtMinimo, minimoCliente } from "./minimo.ts";
import { palabraDeBusqueda, raizDeBusqueda } from "./articulo-nombre.ts";
import {
  callModel,
  esCulpaDelRequest,
  logIntento,
  cooldownParaError,
  logUsage,
  markModelDown,
  type NormMsg,
  type ResolvedModel,
  resolveChain,
  resolveModelById,
} from "./bot-llm.ts";

// ─── Tool definitions (mapean a RPCs bot_*) ────────────────────────

// deno-lint-ignore no-explicit-any
type ToolDef = { name: string; description: string; input_schema: any };

// Pedidos por WhatsApp (Pablo, 30/09): los prende app_settings.wa_pedidos_config.activo (Configuración del agente).
// Apagados, el agente no tiene las herramientas de pedido y la regla le dice que mande a la web. `simulador` (default
// true) los deja probar en el Simulador aunque estén apagados. La vieja enviar_pedido (bot_submit_order) quedó sin
// uso: no mandaba el pedido a Gestión ni usaba las formas de pago de la web.
export const PEDIDOS_POR_WHATSAPP = false;
const HERRAMIENTAS_PEDIDO = new Set(["opciones_de_pedido", "armar_pedido", "confirmar_pedido"]);
// Se lee hasta 6 veces por mensaje (ráfaga, pedido por archivo, pedido en curso, prompt, herramientas, tools). Con la caché
// de settings prendida (webhook, _shared/supabase.ts) se memoiza el mismo tiempo; sin ella (Simulador, chat de prueba) va a
// la base en cada lectura, como siempre.
// deno-lint-ignore no-explicit-any
let cfgPedidosMemo: { hasta: number; cfg: any } | null = null;
// deno-lint-ignore no-explicit-any
export async function configPedidosWa(): Promise<any> {
  const ttl = cacheSettingsTtl();
  if (ttl && cfgPedidosMemo && cfgPedidosMemo.hasta > Date.now()) return cfgPedidosMemo.cfg;
  const { data } = await supabase.rpc("wa_pedidos_cfg");
  // Sólo se memoiza una lectura real. Si el RPC falló (data null) se devuelve el default de siempre pero NO se guarda:
  // si no, una falla transitoria dejaba 15 s al bot creyendo que los pedidos por WhatsApp están apagados (revisión 02/10).
  if (data == null) return { activo: false, modo: "precarga" };
  if (ttl) cfgPedidosMemo = { hasta: Date.now() + ttl, cfg: data };
  return data;
}
/**
 * Pedido por WhatsApp a medio armar (Pablo, 30/09, Simulador): si lo último que dijo el bot en los últimos 60 min es parte
 * de la toma de un pedido (formas de pago, entrega, resumen), lo que conteste el cliente ("contado", "sí", "a la de
 * Venado Tuerto") va al agente y NO a las respuestas fijas: "Pago contado" caía en la FAQ de medios de pago.
 */
export async function pedidoEnCurso(phone: string): Promise<boolean> {
  if (!(await pedidosWaHabilitados())) return false;
  const { data } = SIM.activo
    ? { data: SIM.historial.filter((h) => h.rol === "assistant").slice(-1).map((h) => ({ contenido: h.contenido, creado_en: h.creado_en })) }
    : await supabase.from("bot_historial_chat").select("contenido, creado_en").eq("telefono", phone).eq("rol", "assistant")
      .order("creado_en", { ascending: false }).limit(1);
  const ult = data?.[0];
  if (!ult || Date.now() - new Date(ult.creado_en).getTime() > 60 * 60_000) return false;
  return RE_BOT_EN_PEDIDO.test(String(ult.contenido ?? ""));   // el mismo criterio que usa pedido-turno.ts para elegir el modelo
}

export async function pedidosWaHabilitados(): Promise<boolean> {
  try {
    const cfg = await configPedidosWa();
    return cfg?.activo === true || (SIM.activo && cfg?.simulador !== false);
  } catch { return false; }
}

// ── Productos discontinuados y foto (Pablo, 30/09, fila 2.5) ──
const REGLA_DISCONTINUADO = "Decile que ese código está discontinuado (nombrándolo con su descripción), nunca que no lo encontraste ni que revise el código, y ofrecele el más parecido de parecidos_activos con el link de su foto si lo tiene, para que confirme.";
const sinTildes = (x: string) => x.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
async function fotoProducto(cod: string): Promise<string | null> {
  const url = `${Deno.env.get("SUPABASE_URL") ?? ""}/storage/v1/object/public/products-images/${encodeURIComponent(cod)}.webp`;
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2000) });
    return r.ok ? url : null;
  } catch { return null; }
}
async function codigosDiscontinuados(query: string) {
  const codigos = [...new Set((query.match(/\b\d{2,4}[a-z]?\b/gi) ?? []).map((c) => c.toUpperCase()))];
  if (!codigos.length) return [];
  const { data: inact } = await supabase.from("products").select("cod, description, category").in("cod", codigos).eq("active", false);
  return await conParecidos((inact ?? []) as Array<{ cod: string; description: string; category: string }>);
}
// Pablo, 06/10 (m72): "el precio de lista del automate" → "Automate" (cód. 597) está inactivo y la búsqueda de activos devolvía otra cosa
// ("Bombilla Autolimpiante"). Si el cliente NOMBRÓ un artículo inactivo y ningún activo lleva esa palabra, es un discontinuado (como con el código).
async function discontinuadosPorNombre(query: string, activos: Array<{ description?: string }>) {
  const palabra = (() => { const w = palabraDeBusqueda(query); return w ? raizDeBusqueda(w) : null; })();
  if (!palabra || /\b\d{2,4}[a-z]?\b/i.test(query)) return []; // con un código ya lo resolvió codigosDiscontinuados
  if (activos.some((a) => sinTildes(String(a.description ?? "")).includes(sinTildes(palabra)))) return [];
  const { data: inact } = await supabase.from("products").select("cod, description, category").eq("active", false).ilike("description", `%${palabra}%`).limit(3);
  return await conParecidos((inact ?? []) as Array<{ cod: string; description: string; category: string }>);
}
async function conParecidos(inact: Array<{ cod: string; description: string; category: string }>) {
  const out = [];
  for (const p of inact) {
    const raiz = (w: string) => w.replace(/s$/, "");
    const palabras = new Set(sinTildes(p.description).split(/\s+/).filter((w) => w.length > 3).map(raiz));
    const { data: mismos } = await supabase.from("products").select("cod, description, uxb").eq("active", true).eq("category", p.category).limit(60);
    const top = ((mismos ?? []) as Array<{ cod: string; description: string; uxb: number }>)
      .map((m) => ({ m, n: sinTildes(m.description).split(/\s+/).map(raiz).filter((w) => palabras.has(w)).length }))
      .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
    const parecidos_activos = await Promise.all(top.map(async ({ m }) => ({ cod: m.cod, descripcion: m.description,
      unidades_por_caja: m.uxb, ...(await fotoProducto(m.cod).then((f) => f ? { foto: f } : {})) })));
    out.push({ cod: p.cod, descripcion: p.description, discontinuado: true, parecidos_activos });
  }
  return out;
}

const BOT_TOOLS: ToolDef[] = [
  {
    // 29/09 (estudio de cobertura): la IA no tenía cómo pasar la charla a una persona y "derivaba" dando mails y
    // otros WhatsApp. Esta herramienta crea la alerta (Centro de mensajes › Tareas + cartel de Planify).
    name: "derivar_a_persona",
    description:
      "Pasa la conversación a una persona del equipo: queda como alerta en el Centro de mensajes y le llega a quien atiende. Usala SIEMPRE que haga falta alguien: reclamos (nota de crédito, faltante, mercadería rota, factura mal o duplicada, descuento que no se aplicó), pagos o importes que no coinciden, cambios o cancelaciones de pedido, un pedido que el cliente dice haber hecho y no aparece, alta de cliente, problemas con la web que no podés resolver, o cuando el cliente pide hablar con alguien. Después de usarla decile al cliente que una persona del equipo le escribe por acá. Nunca le des mails ni otros números para que se arregle solo; la única excepción son los datos de Cobranzas que devuelve esta misma herramienta con el motivo pago (datos_cobranzas).",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          enum: ["reclamo", "pago", "cambio_pedido", "anulacion_pedido", "pedido_no_encontrado", "entrega", "excepcion_minimo", "alta_cliente", "escalation"],
          description: "reclamo = NC/faltante/rotura/factura; pago = importes, pagos, comprobantes; cambio_pedido = sacar o cambiar artículos; anulacion_pedido = anular un pedido entero (antes decile en qué estado está); pedido_no_encontrado = dice que pidió y no está; entrega = necesita fecha y el pedido no la tiene, no le llegó, o la fecha no coincide con la que le dijeron; excepcion_minimo = pide comprar por debajo de su pedido mínimo o una excepción al mínimo; alta_cliente = quiere ser cliente; escalation = cualquier otra cosa o pidió una persona.",
        },
        resumen: { type: "string", description: "Qué pide el cliente en una o dos frases, con los datos que dio (fechas, códigos, cantidades)." },
        urgente: { type: "boolean", description: "true si está molesto, apurado o menciona un problema grave." },
      },
      required: ["motivo", "resumen"],
    },
  },
  {
    // Pablo, 29/09: el cliente pide SUMAR artículos o cajas a un pedido ya hecho. La IA confirma primero modelo y cajas;
    // esto chequea que el pedido no esté en armado y el stock, y deja la tarea con botón "Aplicar" (sql/099).
    name: "solicitar_agregado_pedido",
    description:
      "Deja pedido un AGREGADO a un pedido que el cliente ya hizo (sumar artículos o subir cajas), para que una persona lo apruebe y se aplique. Sólo sirve para AGREGAR: para sacar, bajar cantidades o anular usá derivar_a_persona (motivo cambio_pedido). ANTES de usarla: (1) buscá cada artículo con buscar_productos; si hay más de uno posible, preguntale cuál; (2) confirmale con el cliente el código, la descripción y las cajas de cada uno y el pedido (por su fecha), por ejemplo \"¿Confirmo agregar 3 cajas de Pelador X (cód. 505) a tu pedido del 25/09?\"; (3) recién cuando diga que sí, llamala. Si devuelve sin_stock, pasale al cliente el texto y preguntale si igual lo quiere agregar; si insiste, volvé a llamarla con insiste=true. Si el pedido ya está en armado o facturado, ella misma lo deriva a Ventas (no lo apliques ni derives de nuevo). Pasale al cliente el texto_para_el_cliente que devuelve, tal cual.",
    input_schema: {
      type: "object",
      properties: {
        indice: { type: "integer", description: "Pedido al que se agrega (1 = el más reciente, el mismo índice de consultar_mis_pedidos)." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { cod: { type: "string", description: "Código confirmado con el cliente" }, cajas: { type: "integer", description: "Cajas a SUMAR" } },
            required: ["cod", "cajas"],
          },
        },
        insiste: { type: "boolean", description: "true si el cliente ya sabe que algún artículo no tiene stock y lo quiere agregar igual." },
      },
      required: ["indice", "items"],
    },
  },
  {
    // Pablo, 29/09: el cliente pide cambiar o agregar su dirección de entrega. Cada pedido web elige su sucursal, así que
    // una dirección nueva se AGREGA como sucursal (no reemplaza ninguna) y la elige en su próximo pedido. Una persona
    // aprueba desde Tareas (lk_alertas sucursal_agregar).
    name: "solicitar_nueva_sucursal",
    description:
      "Pide agregar una dirección de entrega nueva (sucursal) a la cuenta del cliente, para que una persona la apruebe. Úsala cuando dice que cambió de dirección, que se mudó o que quiere recibir en otro lugar. ANTES: pedile calle y número, localidad, provincia y código postal, y si recibe por expreso, el nombre del expreso; después confirmale la dirección completa (\"¿Agrego San Martín 1234, Villa María, Córdoba (CP 5900), por expreso Cruz del Sur?\") y recién con su sí, llamala. No reemplaza ninguna dirección: la nueva la va a poder elegir en su próximo pedido en la web. Si lo que quiere es cambiar la dirección de un pedido ya hecho, usá derivar_a_persona (motivo cambio_pedido).",
    input_schema: {
      type: "object",
      properties: {
        calle_altura: { type: "string", description: "Calle y número" },
        localidad: { type: "string" },
        provincia: { type: "string" },
        cp: { type: "string", description: "Código postal" },
        expreso: { type: "string", description: "Nombre del expreso, si recibe por expreso (interior). Vacío si es reparto." },
        observaciones: { type: "string", description: "Horario, entre calles u otra aclaración que dio el cliente." },
      },
      required: ["calle_altura", "localidad", "provincia"],
    },
  },
  {
    // Pablo, 29/09: cambio de mail con aprobación de una persona (lk_alertas mail_cambiar).
    name: "solicitar_cambio_mail",
    description: "Pide cambiar el mail de la cuenta del cliente; una persona lo aprueba. El mail lo tiene que haber ESCRITO el cliente: si no te lo dio, pedíselo; nunca lo armes ni lo deduzcas. Confirmale el mail nuevo (\"¿Cambio tu mail a nombre@dominio.com?\") y recién con su sí, llamala: no en el mismo mensaje en que te lo dio. Llamala UNA sola vez por mail: si ya le dijiste \"pedí que cambien tu mail\", no la repitas.",
    input_schema: { type: "object", properties: { mail: { type: "string", description: "Mail nuevo, tal cual lo escribió el cliente y confirmado con él" } }, required: ["mail"] },
  },
  {
    name: "consultar_mis_pedidos",
    description:
      "Consulta los pedidos recientes del cliente: índice (1 = más reciente), fecha del pedido, estado (recibido/programado/en preparación/facturado/entregado), fecha de salida si la tiene, total, método de pago, ítems y cajas. No trae número de pedido: nombralos por la fecha (\"tu pedido del 28/09\").",
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
      "Muestra el detalle de un pedido: ítems, códigos, cantidades (cajas), precios por línea y total. Se busca por indice (1 = más reciente, el mismo de consultar_mis_pedidos).",
    input_schema: {
      type: "object",
      properties: {
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
    // Pablo, 29/09 (incidencia "pagos", 101 consultas): el bot da el importe y el estado de cada factura
    // impaga y avisa a Cobranzas. Fuente: GV_Cobranza_Deuda_Viva (Gestión, la recalcula Cobranzas).
    name: "consultar_mis_facturas",
    description:
      "Facturas impagas del cliente con importe, condición de pago, estado (a pagar hasta tal fecha / vencida) y, si corresponde, el importe con el descuento de su condición pagando hasta la fecha. También da el saldo total. Usala cuando pregunte cuánto debe, el importe a pagar, el importe con el descuento de contado, o el estado de sus facturas. Al usarla se avisa solo a Cobranzas: decile al cliente que Cobranzas quedó al tanto.",
    input_schema: { type: "object", properties: {} },
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
      "Busca productos en el catálogo por nombre, código o categoría. Devuelve código, descripción, unidades por caja, precio de lista por UNIDAD y por CAJA (sin descuentos), el precio DEL CLIENTE por caja (con su descuento por volumen, si tiene) y si tiene imagen. Si le decís un precio al cliente, usá precio_cliente_por_caja cuando venga (es el suyo, antes del descuento de la forma de pago); si no viene, el de lista. No confundas los precios.",
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
    // Pablo, 29/09 (causa "stock", 27 consultas): "¿cuándo ingresan los artículos nuevos?" sin decir cuál.
    name: "consultar_proximos_ingresos",
    description:
      "Lista los artículos de la web que ingresan a depósito en los próximos días, con fecha ESTIMADA. Usala cuando pregunta en general cuándo ingresan los artículos nuevos o qué viene. Si pregunta por un artículo puntual, usá consultar_stock. Decile siempre que son fechas estimadas y pueden cambiar.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "consultar_stock",
    description:
      "Disponibilidad real de UN artículo (stock en depósito menos pedidos ya hechos). Devuelve un texto listo para el cliente (hay / stock limitado / sin stock, sin números). Usala SIEMPRE antes de decir que hay o no hay stock. Si el cliente pregunta en general (\"¿tienen todo el stock?\"), pedile qué artículos le interesan.",
    input_schema: {
      type: "object",
      properties: {
        cod: { type: "string", description: "Código del producto (ej: '506'). Si no lo tenés, buscalo antes con buscar_productos." },
        cajas: { type: "integer", description: "Cajas que quiere el cliente, si las dijo." },
      },
      required: ["cod"],
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
  {
    name: "opciones_de_pedido",
    description: "Pedidos por WhatsApp: devuelve las formas de pago que puede elegir el cliente (numeradas con `opcion` 1, 2, 3… para mostrarlas; el `condicion_code` es interno, sólo para armar_pedido: NUNCA se lo muestres al cliente) y sus direcciones de entrega (con su número de slot; las de tipo 'retiro' son retirar en el depósito), más la fecha mínima de retiro. Usala antes de preguntar forma de pago y entrega.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "armar_pedido",
    description: "Pedidos por WhatsApp: arma el pedido con la misma cuenta que la web (precio del cliente, 2% web y descuento de la forma de pago) y devuelve el resumen para mostrar, errores a resolver y pedidos parecidos (posible doble pedido). NO guarda nada.",
    input_schema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Artículos confirmados", items: { type: "object",
          properties: { cod: { type: "string", description: "Código (ej. '501')" }, cajas: { type: "integer", description: "Cantidad de cajas" } },
          required: ["cod", "cajas"] } },
        condicion_code: { type: "integer", enum: [...CODIGOS_FORMA_DE_PAGO], description: "El condicion_code (interno) de la forma de pago que eligió el cliente, de opciones_de_pedido; no el número de opción" },
        slot: { type: "integer", description: "Dirección de entrega elegida (slot de opciones_de_pedido)" },
        retiro_fecha: { type: "string", description: "Sólo si retira: día elegido, YYYY-MM-DD" },
        retiro_franja: { type: "string", enum: ["9:00 a 12:00", "13:00 a 16:30"], description: "Sólo si retira" },
        observaciones: { type: "string", description: "Aclaración del cliente para el pedido (opcional)" },
        origen: { type: "string", enum: ["WhatsApp", "Cotizador"], description: "'Cotizador' si los artículos salen del cotizador que mandó el cliente (el bot le contestó 'Recibimos tu cotizador'): lleva el 2% web. Si no, 'WhatsApp' (sin 2%)." },
      },
      required: ["items", "condicion_code", "slot"],
    },
  },
  {
    name: "confirmar_pedido",
    description: "Pedidos por WhatsApp: SOLO después de que el cliente vio el resumen de armar_pedido y dijo que sí. Mismos datos que armar_pedido. Deja el pedido cargado para que el equipo lo pase a preparación. El sistema sólo la acepta si tu mensaje anterior fue ese resumen (tal cual, con el mismo total) y el cliente contestó un sí a secas; si no, devuelve no_cargado: seguí lo que dice regla.",
    input_schema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object",
          properties: { cod: { type: "string" }, cajas: { type: "integer" } }, required: ["cod", "cajas"] } },
        condicion_code: { type: "integer", enum: [...CODIGOS_FORMA_DE_PAGO] },
        slot: { type: "integer" },
        retiro_fecha: { type: "string" },
        retiro_franja: { type: "string", enum: ["9:00 a 12:00", "13:00 a 16:30"] },
        observaciones: { type: "string" },
        origen: { type: "string", enum: ["WhatsApp", "Cotizador"] },
      },
      required: ["items", "condicion_code", "slot"],
    },
  },
];

// ─── System prompt ─────────────────────────────────────────────────

async function buildSystemPrompt(
  customerName: string,
  codCliente: number,
  dtoVol: number,
  canario: string | null = null,
): Promise<string> {
  const dtoText =
    dtoVol > 0
      ? `${(dtoVol * 100).toFixed(0)}%`
      : "sin descuento por volumen asignado";

  // Documento rector EDITABLE desde el Panel ("Configuración del agente" →
  // wa_agente_config). Define Objetivo / Limitaciones / Permisos del agente y
  // se inyecta como una sección más. Las reglas operativas y de Seguridad de
  // abajo quedan FIJAS en código (no editables) y tienen prioridad sobre él.
  // Auditoría 02/10: documento rector, config de pedidos y mínimo del cliente no dependen entre sí: se piden juntos
  // (antes eran cuatro viajes en fila en cada turno del agente).
  const [rector, pedidosOn, min] = await Promise.all([
    getAgenteConfig().then((r) => r.trim()).catch(() => ""),   // si falla, seguimos sin doc rector
    // Pablo, 30/09: con pedidos por WhatsApp prendidos, los mínimos y el 2% web salen de wa_pedidos_config (por WhatsApp no
    // va el 2%; mínimo vacío = no se controla). Antes estaban fijos acá y el agente frenaba el pedido con un mínimo que la
    // configuración no pedía (Simulador, 30/09).
    pedidosWaHabilitados(),
    // Pablo, 01/10 (sql/120): el mínimo que se informa es el del cliente (su excepción o el general); una excepción nueva la
    // decide un vendedor. Antes estaba fijo acá ($500.000 / $300.000).
    minimoCliente({ cod: codCliente }).catch(() => null),
  ]);
  const rectorBloque = rector
    ? `\nDocumento rector (definido por Loekemeyer desde el Panel — respetalo salvo que contradiga la Seguridad de más abajo):\n---\n${rector}\n---\n`
    : "";
  const lineaMinimo = min
    ? `- Pedido mínimo de este cliente${min.excepcion ? " (tiene uno propio)" : ""}: con envío ${fmtMinimo(min.envio)}, si retira en el depósito ${fmtMinimo(min.retiro)}. Es un dato informativo si lo pregunta: no frena ni condiciona un pedido. Si pide comprar por debajo o una excepción al mínimo, no la prometas ni la niegues: derivá con derivar_a_persona (motivo excepcion_minimo).\n`
    : "";
  let infoPedidos = lineaMinimo + "- Descuento por pago web: 2%\n";
  if (pedidosOn) {
    const cfg = await configPedidosWa().catch(() => ({}));
    const $ = (n: unknown) => "$" + Math.round(Number(n)).toLocaleString("es-AR");
    infoPedidos = lineaMinimo
      + (cfg?.minimo_envio != null ? `- Pedido mínimo con envío: ${$(cfg.minimo_envio)} (sólo avisarlo si armar_pedido lo marca)\n` : "")
      + (cfg?.minimo_retiro != null ? `- Retiro mínimo en fábrica: ${$(cfg.minimo_retiro)} (sólo avisarlo si armar_pedido lo marca)\n` : "")
      + "- Descuento web 2%: sólo en pedidos hechos en la web. Por WhatsApp no aplica.\n"
      + "- En pedidos por WhatsApp no inventes mínimos ni condiciones: lo único que frena un pedido son los errores de armar_pedido.\n";
  }
  return `Sos el asistente WhatsApp de Loekemeyer Hnos S.R.L., mayorista de artículos de cocina y bazar (peladores, abrelatas, sacacorchos, coladores, ralladores y más).
Atendés a clientes mayoristas. Sos amable, conciso y profesional.

Cliente actual: ${customerName} (código: ${codCliente})
Descuento por volumen: ${dtoText}

Información del negocio:
- Venta exclusivamente mayorista (no minorista)
${infoPedidos}- Descuentos por forma de pago (contado, 30/60/90 días, e-cheq): existen y dependen del cliente. Consultalos con consultar_mis_descuentos; nunca digas que no existen.
- Web: loekemeyer.com
${rectorBloque}
${reglasOperativas(pedidosOn)}

${bloqueSeguridad(customerName, codCliente)}${canario ? `\n\n${lineaCanario(canario)}` : ""}`;
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

const HERRAMIENTAS = BOT_TOOLS.filter((t) => PEDIDOS_POR_WHATSAPP || t.name !== "enviar_pedido");

// Los motivos de derivar_a_persona salen de Configuración › Derivaciones: se sacan los que "responde el bot" y
// se suman los agregados desde el panel. Si la config no se puede leer, quedan los de siempre.
async function herramientasDelTurno(): Promise<ToolDef[]> {
  // Config de pedidos y de derivaciones no dependen entre sí: en paralelo.
  const [conPedidos, mot] = await Promise.all([
    pedidosWaHabilitados(),
    motivosIA().catch((e) => { console.error("herramientasDelTurno: sin config de derivaciones", e); return null; }),
  ]);
  const base = HERRAMIENTAS.filter((t) => conPedidos || !HERRAMIENTAS_PEDIDO.has(t.name));
  if (!mot) return base;
  try {
    return base.map((t) => {
      if (t.name !== "derivar_a_persona") return t;
      const enumM = [...mot.map((m) => m.clave), "alta_cliente", "escalation"];
      const desc = [...mot.map((m) => `${m.clave} = ${m.cuando}`), "alta_cliente = quiere ser cliente",
        "escalation = cualquier otra cosa o pidió una persona"].join("; ") + ".";
      // deno-lint-ignore no-explicit-any
      const sch = t.input_schema as any;
      return { ...t, input_schema: { ...sch, properties: { ...sch.properties, motivo: { type: "string", enum: enumM, description: desc } } } };
    });
  } catch (e) {
    console.error("herramientasDelTurno: sin config de derivaciones", e);
    return base;
  }
}

/** Cómo recibe el cliente un pedido, según la zona de entrega de v_pedidos_web (la usan consultar_mis_pedidos y consultar_mi_entrega). */
// deno-lint-ignore no-explicit-any
function modoDeEntrega(m: any): { entrega: string; expreso?: string } {
  if (/^retira/i.test(String(m?.zona_expreso ?? ""))) return { entrega: "retira en el depósito" };
  if (String(m?.nombre_expreso ?? "").trim()) return { entrega: "por expreso", expreso: String(m.nombre_expreso).trim() };
  return { entrega: "reparto propio" };
}

async function executeTool(
  name: string,
  // deno-lint-ignore no-explicit-any
  input: Record<string, any>,
  phone: string,
  // Lo que la compuerta de confirmar_pedido necesita para no fiarse del modelo (pedido-gate.ts): el mensaje de ahora y el historial.
  ctx: { userText: string; historial: FilaHistorial[] } = { userText: "", historial: [] },
): Promise<ToolExecResult> {
  if (SIM.activo) {
    const efecto = HERRAMIENTAS_CON_EFECTO.has(name);
    SIM.herramientas.push({ nombre: name, input, ejecutada: !efecto });
    if (efecto) return { data: { ok: true, simulado: true, mensaje: "Hecho." } };
  }
  switch (name) {
    case "derivar_a_persona": {
      const motivo = String(input.motivo ?? "escalation");
      // Configuración › Derivaciones: un motivo en "lo responde el bot" no se deriva (salvo urgencia).
      const regla = (await derivaciones(true)).motivos[motivo];
      if (regla?.destino === "bot" && input.urgente !== true) {
        return { data: { error: "Este tema lo responde el bot: no lo derives. Resolvelo con las herramientas de consulta y la información que tenés." } };
      }
      const { data: cli } = await supabase.rpc("wa_identify_customer", { p_phone: phone });
      await notificarHumano({
        tipo: motivo === "alta_cliente" ? "alta_cliente_nuevo" : "escalation", phone,
        customerId: cli?.[0]?.customer_id ?? null,
        contexto: {
          motivo, texto: String(input.resumen ?? "").slice(0, 500), origen: "agente_ia",
          razon_social: cli?.[0]?.customer_name ?? null,
          ...(typeof input.urgente === "boolean" ? { urgente: input.urgente } : {}),
        },
      });
      // Pablo, 01/10: una consulta de pago que va a Cobranzas lleva también cómo comunicarse con ellos (ficha Empresas).
      // Es la única excepción a "nunca des mails ni otros números": el dato lo pone esta herramienta, no la IA.
      if (motivo === "pago") {
        try {
          const datos = datosCobranzas(await datosEmpresas(), { lk: true, chef: false });
          if (datos) {
            return { data: { ok: true, mensaje: "Listo: quedó derivado a Cobranzas. Decile al cliente que Cobranzas le escribe por acá y, para consultas sobre sus pagos, pasale estos datos de Cobranzas tal cual (no agregues otros).",
              datos_cobranzas: datos } };
          }
        } catch (e) { console.warn("derivar_a_persona: datos de Cobranzas:", e instanceof Error ? e.message : e); }
      }
      return { data: { ok: true, mensaje: "Listo: quedó derivado. Decile al cliente que una persona del equipo le escribe por acá." } };
    }

    case "solicitar_cambio_mail": {
      const mail = String(input.mail ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { data: { error: "Ese mail no parece válido: pedíselo de nuevo." } };
      // Compuerta de servidor (Pablo, 06/10): el mail tiene que figurar en lo que escribió el cliente; el modelo no puede inventarlo
      // (Gemini lo armó con la razón social en 2 de 2 corridas del caso 9.4). Ver mail-gate.ts. No se loguea el mail, sólo el teléfono.
      if (!mailEscritoPorElCliente({ mail, textoCliente: ctx.userText, historial: ctx.historial })) {
        console.warn(`[gate-mail] solicitar_cambio_mail bloqueado (mail no escrito por el cliente) …${phone.slice(-4)}`);
        return { data: { ok: false, no_cargado: true, regla: REGLA_MAIL_NO_ESCRITO } };
      }
      // No repetir (Pablo, 07/10): el modelo la llamó en el mensaje con el mail y otra vez tras el "sí" del cliente, y salían 2 tareas
      // cambio_datos iguales. Si ese mail ya se pidió no se crea otra: lo dice la charla (también en el Simulador) o, en producción,
      // hay una alerta abierta del mismo teléfono con ese mail_nuevo de las últimas 12 h. Si la consulta falla, sigue y la crea.
      let yaPedido = mailYaPedidoEnLaCharla({ mail, historial: ctx.historial });
      if (!yaPedido && !SIM.activo) {
        try {
          const { data: abiertas } = await supabase.from("wa_alertas_humano").select("id").eq("phone", phone).eq("tipo", "escalation")
            .in("estado", ["pendiente", "notificado"]).eq("contexto->>mail_nuevo", mail)
            .gte("created_at", new Date(Date.now() - VIGENCIA_MAIL_MS).toISOString()).limit(1);
          yaPedido = (abiertas?.length ?? 0) > 0;
        } catch (e) { console.warn("[gate-mail] no pude buscar un pedido igual:", e instanceof Error ? e.message : e); }
      }
      if (yaPedido) {
        console.warn(`[gate-mail] solicitar_cambio_mail repetido, no se crea otra tarea …${phone.slice(-4)}`);
        return { data: { ok: true, ya_pedido: true, texto_para_el_cliente: textoYaPedidoMail(mail), regla: "Pasale este texto tal cual." } };
      }
      const { data: cli } = await supabase.rpc("wa_identify_customer", { p_phone: phone });
      if (!cli?.[0]?.customer_id) return { data: { error: "No identifiqué la cuenta de este número. Derivá con derivar_a_persona." } };
      await notificarHumano({
        tipo: "escalation", phone, customerId: cli[0].customer_id,
        contexto: { motivo: "cambio_datos", origen: "agente_ia", mail_nuevo: mail, texto: `Cambiar el mail a ${mail}`,
          razon_social: cli[0].customer_name ?? null, urgente: false },
      });
      return { data: { ok: true, texto_para_el_cliente: textoPedidoMail(mail), regla: "Pasale este texto tal cual." } };
    }

    case "solicitar_nueva_sucursal": {
      // Estos campos los escribe el cliente y alguien los APLICA a su cuenta (dirección de entrega): una línea, sin invisibles ni etiquetas (dato-externo.ts).
      const limpio = (v: unknown) => lineaSegura(v, 120);
      const suc = { calle_altura: limpio(input.calle_altura), localidad: limpio(input.localidad), provincia: limpio(input.provincia),
        cp: limpio(input.cp) || null, expreso: limpio(input.expreso) || null, observaciones: limpio(input.observaciones) || null };
      if (!suc.calle_altura || !suc.localidad || !suc.provincia) return { data: { error: "Faltan calle y número, localidad o provincia: pedíselos." } };
      const { data: cli } = await supabase.rpc("wa_identify_customer", { p_phone: phone });
      if (!cli?.[0]?.customer_id) return { data: { error: "No identifiqué la cuenta de este número. Derivá con derivar_a_persona." } };
      const texto = `${suc.calle_altura}, ${suc.localidad}, ${suc.provincia}${suc.cp ? ` (CP ${suc.cp})` : ""}${suc.expreso ? `, por expreso ${suc.expreso}` : ""}`;
      await notificarHumano({
        tipo: "escalation", phone, customerId: cli[0].customer_id,
        contexto: { motivo: "cambio_datos", origen: "agente_ia", sucursal: suc, texto: `Agregar dirección de entrega: ${texto}`,
          razon_social: cli[0].customer_name ?? null, urgente: false },
      });
      return { data: { ok: true, texto_para_el_cliente: `Listo, pedí que agreguen la dirección ${texto}. Una persona la revisa y te confirmamos por acá; después la vas a poder elegir en tu próximo pedido en la web.`,
        regla: "Pasale este texto tal cual." } };
    }

    case "solicitar_agregado_pedido": {
      const { data: lista } = await supabase.rpc("bot_mis_pedidos", { p_telefono: phone, p_limit: 20 });
      const vivos = await sinAnulados((lista ?? []) as Record<string, unknown>[], "order_id");
      const elegido = vivos[Number(input.indice ?? 1) - 1];
      if (!elegido) return { data: { error: "No encontré ese pedido. Preguntale de qué fecha es." } };
      const pedido = Number(elegido.order_id);
      const [{ data: ord }, { data: est }] = await Promise.all([
        supabase.from("orders").select("id, created_at, enviado_a_compras_at, customer_id").eq("id", pedido).maybeSingle(),
        estadoPedidos([pedido]),
      ]);
      if (!ord) return { data: { error: "No encontré ese pedido." } };
      const del = (() => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(ord.created_at)); return `${p.slice(8, 10)}/${p.slice(5, 7)}`; })();
      const estado = String(est?.[0]?.status ?? "recibido");
      // Pablo, 29/09: se puede agregar hasta que el pedido entra en armado. Pablo, 06/10: después NO se le dice "no se puede": se
      // deriva a Ventas (alerta cambio_pedido, sin botón Aplicar; antes decía logística, 06/10) y al cliente se le dice que se está consultando. Entregado: pedido nuevo.
      const caso = casoDeAgregado(estado, !!ord.enviado_a_compras_at);
      if (caso === "entregado") {
        return { data: { texto_para_el_cliente: textoClienteEntregado(del), regla: "Pasale este texto tal cual. No derives." } };
      }
      const pedidos = (Array.isArray(input.items) ? input.items : []) as Array<{ cod: string; cajas: number }>;
      if (!pedidos.length) return { data: { error: "Faltan los artículos a agregar (código y cajas)." } };
      const agregar: Array<Record<string, unknown>> = [];
      const sinStock: string[] = [];
      for (const it of pedidos) {
        const cod = String(it.cod ?? "").trim();
        const cajas = Math.floor(Number(it.cajas));
        if (!cod || !(cajas > 0)) return { data: { error: `Cantidad o código inválido (${cod}).` } };
        const { data: p } = await supabase.from("products").select("id, cod, description, uxb, list_price, active, badge_status")
          .eq("cod", cod).maybeSingle();
        if (!p || !p.active) return { data: { error: `No encontré el código ${cod} activo en la web. Buscalo con buscar_productos.` } };
        // En armado el stock lo mira Ventas al contestar: no se le dice nada al cliente ni se arma la fila "Aplicar".
        let st = null, ing = null, falta = false;
        if (caso === "normal") {
          try { st = await stockArticulo(p.cod); } catch (e) { console.error("agregado stock:", e); }
          falta = !st || st.disponible < cajas;
          if (falta) {
            try { ing = await ingresoEstimado(p.cod); } catch (e) { console.error("agregado ingreso:", e); }
            sinStock.push(st ? textoStock(p.description, p.cod, st, cajas).replace(/ Le paso tu consulta[^.]*\./, "") + textoIngreso(ing)
              : `No pude confirmar el stock de *${p.description}* (cód. ${p.cod}).`);
          }
        }
        agregar.push({ product_id: p.id, cod: p.cod, descripcion: p.description, cajas, uxb: p.uxb, sin_stock: falta,
          ingreso_estimado: ing?.fecha ?? null });
      }
      if (caso === "en_armado") {
        const items = agregar.map((a) => ({ cajas: Number(a.cajas), descripcion: String(a.descripcion), cod: String(a.cod) }));
        // Pablo, 06/10: una sola alerta abierta por pedido y artículos (la IA suele llamar a la herramienta dos veces: antes y después del "sí").
        let repetida = false;
        if (!SIM.activo) {
          try {
            const { data: abiertas } = await supabase.from("wa_alertas_humano").select("contexto")
              .eq("phone", phone).in("estado", ["pendiente", "notificado"]).eq("contexto->>motivo", "cambio_pedido")
              .eq("contexto->>pedido", String(pedido)).limit(10);
            repetida = yaHayAlertaIgual((abiertas ?? []) as AlertaAbierta[], pedido, items);
          } catch (e) { console.warn("agregado en armado: no pude mirar alertas abiertas:", e instanceof Error ? e.message : e); }
        }
        if (!repetida) {
          const { data: cli } = await supabase.rpc("wa_identify_customer", { p_phone: phone });
          await notificarHumano({
            tipo: "escalation", phone, customerId: cli?.[0]?.customer_id ?? ord.customer_id ?? null,
            // Sin `agregar` ni `aplicable`: la tarea sale como consulta común (cita de lo que pidió), no con el botón de sumar al pedido.
            // `items` (código y cajas) es lo que compara yaHayAlertaIgual para no repetir la alerta.
            contexto: { motivo: "cambio_pedido", origen: "agente_ia", pedido, en_armado: true, estado_pedido: estado,
              items: items.map((i) => ({ cod: i.cod, cajas: i.cajas })),
              texto: textoTareaEnArmado(del, estado, items), razon_social: cli?.[0]?.customer_name ?? null, urgente: true },
          });
        }
        return { data: { ok: true, derivado: true, texto_para_el_cliente: textoClienteEnArmado(del, estado, items),
          regla: "Pasale este texto tal cual. Ya quedó derivado a Ventas: no derives de nuevo ni prometas que se va a poder." } };
      }
      if (sinStock.length && input.insiste !== true) {
        return { data: { sin_stock: true, texto_para_el_cliente: sinStock.join("\n") +
          "\n¿Lo querés agregar igual? Si es así, una persona lo revisa y lo carga cuando haya stock.",
          regla: "Pasale este texto y esperá su respuesta. Todavía NO quedó pedido nada." } };
      }
      const cj = (n: unknown) => `${n} ${Number(n) === 1 ? "caja" : "cajas"}`;
      const detalle = agregar.map((a) => `${cj(a.cajas)} de ${a.descripcion} (cód. ${a.cod})${a.sin_stock ? " — sin stock" : ""}`).join("; ");
      const { data: cli } = await supabase.rpc("wa_identify_customer", { p_phone: phone });
      await notificarHumano({
        tipo: "escalation", phone, customerId: cli?.[0]?.customer_id ?? ord.customer_id ?? null,
        contexto: { motivo: "cambio_pedido", origen: "agente_ia", pedido, agregar, aplicable: sinStock.length === 0,
          texto: `Agregar al pedido del ${del}: ${detalle}${sinStock.length ? " (tiene artículos sin stock: cargar a mano)" : ""}`,
          razon_social: cli?.[0]?.customer_name ?? null, urgente: true },
      });
      return { data: { ok: true, texto_para_el_cliente: `Listo, dejé pedido el agregado a tu pedido del ${del}:\n` +
        agregar.map((a) => `• ${cj(a.cajas)} de ${a.descripcion} (cód. ${a.cod})`).join("\n") +
        `\nUna persona lo aprueba y te confirmamos por acá con el total nuevo.`, regla: "Pasale este texto tal cual." } };
    }

    case "consultar_mis_pedidos": {
      const pedir = Math.min(10, Number(input.limite ?? 5) || 5);
      const { data: crudos, error } = await supabase.rpc("bot_mis_pedidos", {
        p_telefono: phone,
        p_limit: pedir + 10,
      });
      if (error) return { data: { error: error.message } };
      // Anulados o borrados en Gestión: para el bot no existen (pedidos-anulados.ts).
      const data = (await sinAnulados((crudos ?? []) as Record<string, unknown>[], "order_id")).slice(0, pedir);
      if (!data?.length) return { data: { mensaje: "No tenés pedidos registrados." } };
      // Pablo, 28/09: el número de pedido no se le muestra al cliente → no se lo pasamos al modelo. En su lugar:
      // índice, estado real (Gestión, bot_estado_pedidos_gv) y fecha de salida.
      // deno-lint-ignore no-explicit-any
      const filas = data as any[];
      const [{ data: est }, { data: modos }] = await Promise.all([
        estadoPedidos(filas.map((r) => r.order_id)),
        supabase.from("v_pedidos_web").select("order_id, zona_expreso, nombre_expreso")
          .in("order_id", filas.map((r) => r.order_id)).eq("linea_rn", 1),
      ]);
      // deno-lint-ignore no-explicit-any
      const porId = new Map((est ?? []).map((e: any) => [String(e.order_id), e]));
      // deno-lint-ignore no-explicit-any
      const modoPor = new Map((modos ?? []).map((m: any) => [String(m.order_id), modoDeEntrega(m)]));
      return { data: filas.map((r, i) => {
        // deno-lint-ignore no-explicit-any
        const e: any = porId.get(String(r.order_id));
        const { order_id: _id, ...resto } = r;
        const modo = modoPor.get(String(r.order_id)) ?? { entrega: "reparto propio" };
        const estado = e?.status ?? "recibido";
        // Pablo, 07/10 (m1, m23): un pedido de RETIRO no "sale": el estado va ya redactado ("facturado y listo para retirar desde el martes 06/10", "retirado el martes 06/10") y sin
        // `fecha_salida`, que el agente traducía como "salió".
        if (modo.entrega === "retira en el depósito") return { indice: i + 1, ...resto, estado, estado_para_el_cliente: estadoRetiroParaIA(estado, e?.fecha_entrega ?? null), ...modo };
        return { indice: i + 1, ...resto, estado, fecha_salida: e?.fecha_entrega ?? null, ...modo };
      }) };
    }

    case "consultar_detalle_pedido": {
      if (input.indice) {
        // El índice es el de consultar_mis_pedidos, que ya saca los anulados: se resuelve sobre esa misma lista
        // y se pide el detalle por id (bot_detalle_por_indice contaría también los anulados).
        const { data: lista } = await supabase.rpc("bot_mis_pedidos", { p_telefono: phone, p_limit: 20 });
        const vivos = await sinAnulados((lista ?? []) as Record<string, unknown>[], "order_id");
        const elegido = vivos[Number(input.indice) - 1];
        if (!elegido) return { data: { mensaje: "No se encontró un pedido en esa posición." } };
        const { data, error } = await supabase.rpc("bot_detalle_pedido", {
          p_telefono: phone,
          p_order_id: Number(elegido.order_id),
        });
        if (error) return { data: { error: error.message } };
        if (!data?.length) return { data: { mensaje: "No se encontró un pedido en esa posición." } };
        // deno-lint-ignore no-explicit-any
        return { data: (data as any[]).map(({ order_id: _id, ...resto }) => resto) };
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
      return { data: { error: "Necesito el índice del pedido (1 = el más reciente)." } };
    }

    case "consultar_mi_entrega": {
      const { data, error } = await supabase.rpc("bot_mi_entrega", {
        p_telefono: phone,
      });
      if (error) return { data: { error: error.message } };
      const entregas = await sinAnulados((data ?? []) as Record<string, unknown>[], "np_number");
      if (!entregas.length) return { data: { mensaje: "No hay entregas recientes ni programadas." } };
      // Pablo, 07/10 (m23, visto en el Simulador): esta herramienta tampoco sabía si el pedido se retira: decía "programado para entregarse mañana". Mismo trato que
      // consultar_mis_pedidos: el modo de entrega, y para un retiro el estado ya redactado y sin `fecha_entrega`.
      const { data: modos } = await supabase.from("v_pedidos_web").select("order_id, zona_expreso, nombre_expreso")
        .in("order_id", entregas.map((e) => Number(e.np_number)).filter((n) => Number.isFinite(n))).eq("linea_rn", 1);
      // deno-lint-ignore no-explicit-any
      const modoPor = new Map((modos ?? []).map((m: any) => [String(m.order_id), modoDeEntrega(m)]));
      return { data: entregas.map(({ np_number, ...resto }) => {
        const modo = modoPor.get(String(np_number)) ?? { entrega: "reparto propio" };
        if (modo.entrega === "retira en el depósito") {
          const { fecha_entrega, ...sinFecha } = resto as Record<string, unknown>;
          return { ...sinFecha, estado_para_el_cliente: estadoRetiroParaIA(String(resto.status ?? ""), (fecha_entrega as string | null) ?? null), ...modo };
        }
        return { ...resto, ...modo };
      }) };
    }

    case "consultar_mis_facturas": {
      const { data: cli } = await supabase.rpc("bot_cliente_por_whatsapp", { p_telefono: phone });
      const c = cli?.[0];
      if (!c?.cod_cliente) return { data: { mensaje: "No encontré la cuenta de este número." } };
      const pesos = (n: number) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR", { maximumFractionDigits: 0 });
      const ddmm = (f: string | null) => (f ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : "");
      const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
      let rows: Array<Record<string, unknown>> = [];
      try {
        const g = await getGestionClient("public");
        const r = await Promise.race([
          g.from("GV_Cobranza_Deuda_Viva").select("comprobante, fecha, vence, condicion, dto_cond, lista, pendiente")
            .eq("empresa", "lk").eq("cod_cliente", String(c.cod_cliente)).gt("pendiente", 0).order("fecha", { ascending: true }).limit(30),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
        ]);
        if (r.error) throw new Error(r.error.message);
        rows = ((r.data ?? []) as Array<Record<string, unknown>>).map((x) => ({ ...x, empresa: "lk" }));
        // Pablo, 01/10: también las facturas de Chef, cruzadas por CUIT (el código de cliente es otro en cada empresa).
        const { data: cu } = await supabase.from("customers").select("cuit").eq("id", c.customer_id).maybeSingle();
        const chef = await deudaChefPorCuit(cu?.cuit);
        if (chef === null) throw new Error("Chef no respondió");
        rows = ([...rows, ...chef.map((x) => ({ ...x, empresa: "chef" }))] as Array<Record<string, unknown>>)
          .sort((a, b) => String(a.fecha ?? "").localeCompare(String(b.fecha ?? "")));
      } catch (e) {
        console.error("consultar_mis_facturas: Gestión no respondió", e);
        return { data: { error: "No pude consultar las facturas ahora. Derivá a Cobranzas con derivar_a_persona (motivo pago)." } };
      }
      const hayChef = rows.some((r) => r.empresa === "chef");
      // Descuento de la condición (dto_cond) pagando hasta `vence`, sólo si la factura no tiene pagos parciales
      // (pendiente = lista). Vencida o con pagos: el importe pendiente, y el final lo confirma Cobranzas.
      const facturas = rows.map((r) => {
        const pend = Number(r.pendiente || 0), lista = Number(r.lista || 0), dto = Number(r.dto_cond || 0);
        const vence = String(r.vence ?? "") || null;
        const vencida = !!vence && vence < hoy;
        const sinPagos = Math.abs(pend - lista) < 1;
        return {
          ...(hayChef ? { empresa: r.empresa === "chef" ? "Chef" : "Loekemeyer" } : {}),
          factura: r.comprobante, fecha: ddmm(String(r.fecha ?? "")), condicion: r.condicion, importe: pesos(pend),
          estado: vencida ? `vencida el ${ddmm(vence)}` : vence ? `a pagar hasta el ${ddmm(vence)}` : "impaga",
          ...(!vencida && sinPagos && dto > 0 && vence
            ? { con_descuento: `${pesos(pend * (1 - dto))} (${Math.round(dto * 100)}% dto pagando hasta el ${ddmm(vence)})` } : {}),
          ...(sinPagos ? {} : { pago_parcial: true }),
        };
      });
      const saldo = rows.reduce((a, r) => a + Number(r.pendiente || 0), 0);
      // Aviso a Cobranzas (una alerta abierta por número alcanza).
      const { data: abierta } = SIM.activo ? { data: [] } : await supabase.from("wa_alertas_humano").select("id")
        .eq("phone", phone).in("estado", ["pendiente", "notificado"]).eq("contexto->>motivo", "pago").limit(1);
      if (!abierta?.length) {
        await notificarHumano({
          tipo: "escalation", phone, customerId: c.customer_id ?? null,
          contexto: {
            motivo: "pago", origen: "agente_ia", razon_social: c.business_name ?? null, urgente: false,
            texto: rows.length ? `Consultó su saldo por WhatsApp: ${rows.length} factura(s) impaga(s), ${pesos(saldo)}.` : "Consultó su saldo por WhatsApp: no tiene facturas impagas.",
          },
        });
      }
      if (!rows.length) return { data: { mensaje: "No tiene facturas impagas. Cobranzas quedó avisada de la consulta." } };
      // Pablo, 30/09 (6.1): "pasame el importe con el 25% de contado" → el total CON descuento lo suma el código, no el modelo.
      const conDto = rows.reduce((a, r) => {
        const pend = Number(r.pendiente || 0), lista = Number(r.lista || 0), dto = Number(r.dto_cond || 0);
        const vence = String(r.vence ?? "") || null;
        const aplica = !!vence && vence >= hoy && Math.abs(pend - lista) < 1 && dto > 0;
        return a + (aplica ? pend * (1 - dto) : pend);
      }, 0);
      // Datos para transferir de CADA empresa con facturas (Chef sin alias cargado: no se le da el de LK).
      const emp = await datosEmpresas();
      const datos_para_pagar = (["lk", "chef"] as const).filter((k) => rows.some((r) => r.empresa === k)).map((k) =>
        textoDatosPago(emp[k], hayChef) ?? `Para las facturas de ${emp[k].nombre}, Cobranzas te pasa los datos de pago por acá.`);
      return { data: { saldo_total: pesos(saldo),
        ...(Math.round(conDto) < Math.round(saldo) ? { total_con_descuento: `${pesos(conDto)} (pagando cada factura hasta su fecha de descuento)` } : {}),
        facturas, datos_para_pagar, nota: "Importes con IVA, redondeados a pesos. Cobranzas quedó avisada de la consulta.",
        // Thommy, 30/09: en toda respuesta de importes, pedir el comprobante.
        regla: hayChef
          ? "Tiene facturas de Loekemeyer y de Chef: separalas por empresa y, si da datos para pagar, los de cada empresa tal cual datos_para_pagar (nunca el alias de una para las facturas de la otra). Cerrá pidiéndole que, cuando pague, mande el comprobante por acá."
          : "Cerrá pidiéndole que, cuando pague, mande el comprobante por acá." } };
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
      // Pablo, 30/09 (2.5): un código que existe pero está inactivo es "discontinuado", no "no encontré". Se le ofrecen los
      // activos más parecidos de su categoría, con el link de la foto para que el cliente confirme.
      let discontinuados = await codigosDiscontinuados(String(input.query ?? ""));
      if (!discontinuados.length) {
        // Por NOMBRE (m72): si el cliente nombró un artículo inactivo y ningún activo lo lleva, se contesta sólo el discontinuado (no lo parecido por trigramas).
        discontinuados = await discontinuadosPorNombre(String(input.query ?? ""), (data ?? []) as Array<{ description?: string }>);
        if (discontinuados.length) return { data: { discontinuados, regla: REGLA_DISCONTINUADO } };
      }
      if (!data?.length) {
        if (discontinuados.length) return { data: { discontinuados, regla: REGLA_DISCONTINUADO } };
        return { data: { mensaje: `No encontré productos para "${input.query}".` } };
      }
      // Link de la foto (bucket público products-images/<cod>.webp) cuando son pocos resultados: para que el cliente
      // confirme el artículo que el bot supone.
      const fotos = data.length <= 5 ? await Promise.all((data as Array<{ cod: string }>).map((p) => fotoProducto(p.cod))) : [];
      // Pablo, 29/09: list_price es por UNIDAD. El bot decía "$5.520 por caja" y la caja de 6 sale $33.120.
      // Se le pasan los dos precios con nombre explícito, de lista (sin descuentos).
      // Pablo, 30/09: además el precio DEL CLIENTE (lista − su descuento por volumen, como la web). En el Simulador el bot
      // mostró "$33.120 por caja" (lista) a Farimar, que tiene 8%: en un pedido se muestra el suyo.
      const { data: cli } = await supabase.rpc("bot_cliente_por_whatsapp", { p_telefono: phone });
      const dto = Number(cli?.[0]?.cod_cliente) === 5000 ? 0 : Number(cli?.[0]?.dto_vol ?? 0);
      // deno-lint-ignore no-explicit-any
      const res = (data as any[]).map(({ list_price, uxb, ...r }, i) => ({ ...r, unidades_por_caja: uxb, ...(fotos[i] ? { foto: fotos[i] } : {}),
        precio_lista_por_unidad: Math.round(Number(list_price || 0)),
        precio_lista_por_caja: Math.round(Number(list_price || 0) * Number(uxb || 0)),
        ...(dto > 0 ? { precio_cliente_por_caja: Math.round(Number(list_price || 0) * Number(uxb || 0) * (1 - dto)),
          descuento_volumen_cliente: `${Math.round(dto * 1000) / 10}%` } : {}) }));
      return { data: discontinuados.length ? { productos: res, discontinuados, regla: REGLA_DISCONTINUADO } : res };
    }

    case "consultar_stock": {
      const cod = String(input.cod ?? "").trim();
      const { data: prods } = await supabase.from("products").select("id, cod, description").eq("cod", cod).limit(1);
      const p = prods?.[0];
      if (!p) return { data: { mensaje: `No encontré el código ${cod}. Buscalo con buscar_productos.` } };
      try {
        const cajas = Number(input.cajas) > 0 ? Number(input.cajas) : null;
        const st = await stockArticulo(p.cod);
        if (!st) return { data: { mensaje: "No pude consultar el stock. Ofrecé derivar a ventas." } };
        if (stockNecesitaHumano(st, cajas)) {
          const { data: cli } = await supabase.rpc("wa_identify_customer", { p_phone: phone });
          await notificarHumano({
            tipo: "escalation", phone, customerId: cli?.[0]?.customer_id ?? null,
            contexto: { motivo: "consulta_stock", texto: `Consulta de stock: ${p.description} (${p.cod})${cajas ? `, ${cajas} cajas` : ""}`,
              razon_social: cli?.[0]?.customer_name ?? null },
          });
        }
        // Sin stock o limitado: fecha estimada de ingreso si hay un lote en curso (Gestión › Importados).
        let ing = null;
        if (st.nivel !== "hay" || (cajas && st.disponible < cajas)) {
          try { ing = await ingresoEstimado(p.cod); } catch (e) { console.error("ingresoEstimado:", e); }
        }
        return { data: { texto_para_el_cliente: textoStock(p.description, p.cod, st, cajas) + textoIngreso(ing),
          regla: "Pasale este texto tal cual; no agregues cantidades ni otras fechas. La fecha de ingreso siempre es estimada." } };
      } catch (e) {
        console.error("consultar_stock:", e);
        return { data: { mensaje: "No pude consultar el stock ahora. Decile que un asesor le confirma y ofrecé derivar." } };
      }
    }

    case "consultar_proximos_ingresos": {
      try {
        const lista = await proximosIngresos(45, 8);
        if (!lista.length) return { data: { mensaje: "No tengo fechas de ingreso para los próximos días. Ofrecé que un asesor se lo confirme." } };
        return { data: { articulos: lista, nota: "Fechas estimadas: pueden cambiar. No des cantidades." } };
      } catch (e) {
        console.error("consultar_proximos_ingresos:", e);
        return { data: { mensaje: "No pude consultar los ingresos ahora. Decile que un asesor le confirma." } };
      }
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

    // ── Pedidos por WhatsApp (Pablo, 30/09; sql/112) ──
    case "opciones_de_pedido": {
      if (!(await pedidosWaHabilitados())) return { data: { error: "Los pedidos no se toman por WhatsApp: indicale que lo haga en loekemeyer.com." } };
      const { data: cli } = await supabase.rpc("bot_cliente_por_whatsapp", { p_telefono: phone });
      const c = cli?.[0];
      if (!c?.customer_id) return { data: { error: "Este número no está vinculado a una cuenta: no se pueden tomar pedidos. Derivá con derivar_a_persona (alta o vinculación)." } };
      const [{ data: cust }, { data: dirs }, { data: desde }] = await Promise.all([
        supabase.from("customers").select("escala_activa, cod_cliente").eq("id", c.customer_id).maybeSingle(),
        supabase.from("customer_delivery_addresses").select("slot, label, zona_expreso, nombre_expreso").eq("customer_id", c.customer_id).order("slot"),
        supabase.rpc("entrega_sumar_habiles", { p_desde: new Date().toISOString().slice(0, 10), p_n: 3 }),
      ]);
      const soloContado = cust?.escala_activa === true || Number(cust?.cod_cliente) === 5000;
      // Pablo, 07/10 (m12): numeradas 1, 2, 3… para el cliente (los códigos internos 8, 9, 10… ya no se muestran) y sin "Prefiero no decidir ahora" (formas-pago.ts).
      const formas = formasDePago(soloContado);
      const entregas = (dirs ?? []).map((d: { slot: number; label: string; zona_expreso: string | null; nombre_expreso: string | null }) => {
        const retiro = /^retira$/i.test(String(d.zona_expreso ?? "").trim());
        return { slot: d.slot, direccion: d.label, tipo: retiro ? "retiro en el depósito (Virgilio 2788)" : d.nombre_expreso ? `por expreso ${d.nombre_expreso}` : "reparto propio" };
      });
      const ddmm = typeof desde === "string" ? `${desde.slice(8, 10)}/${desde.slice(5, 7)}` : null;
      return { data: { formas_de_pago: formas, entregas,
        ...(entregas.some((e: { tipo: string }) => e.tipo.startsWith("retiro")) ? { retiro_desde: ddmm, franjas: ["9:00 a 12:00", "13:00 a 16:30"] } : {}),
        ...(soloContado ? { nota: "Esta cuenta sólo puede pedir con pago Contado." } : {}),
        ...(!entregas.length ? { nota_entrega: "No tiene direcciones cargadas: pedile la dirección y usá solicitar_nueva_sucursal; el pedido se puede cargar cuando esté agregada." } : {}) } };
    }

    case "armar_pedido":
    case "confirmar_pedido": {
      if (!(await pedidosWaHabilitados())) return { data: { error: "Los pedidos no se toman por WhatsApp: indicale que lo haga en loekemeyer.com." } };
      const confirmar = name === "confirmar_pedido";   // en el Simulador nunca se guarda (más abajo)
      const items = (Array.isArray(input.items) ? input.items : []).map((it: { cod: string; cajas: number }) =>
        ({ cod: String(it.cod ?? "").trim(), cajas: Number(it.cajas) }));
      const armar = (p_guardar: boolean) => supabase.rpc("bot_pedido_armar", {
        p_telefono: phone, p_items: items, p_condicion_code: Number(input.condicion_code), p_slot: Number(input.slot),
        p_retiro_fecha: input.retiro_fecha || null, p_retiro_franja: input.retiro_franja || null,
        p_observaciones: input.observaciones || null, p_guardar,
        p_origen: input.origen === "Cotizador" ? "Cotizador" : "WhatsApp",
      });
      // Al confirmar también se arma primero SIN guardar: la compuerta (pedido-gate.ts) decide con el resultado y recién ahí se guarda.
      const primero = await armar(false);
      const error = primero.error;
      let r = primero.data;
      if (error) { console.error("bot_pedido_armar:", error.message); return { data: { error: "No pude armar el pedido. Derivá con derivar_a_persona (motivo escalation)." } }; }
      const pesos = (n: number) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");
      const EXPLICA: Record<string, string> = {
        cliente_no_identificado: "este número no está vinculado a una cuenta (no se puede pedir por WhatsApp)",
        forma_de_pago_invalida: "falta la forma de pago", sin_articulos: "no hay artículos", falta_entrega: "falta elegir la dirección de entrega",
        sucursal_invalida: "esa dirección no es de la cuenta", falta_fecha_o_franja_de_retiro: "si retira, falta el día y la franja",
        franja_invalida: "la franja tiene que ser 9:00 a 12:00 o 13:00 a 16:30",
      };
      const errores = ((r?.errores ?? []) as string[]).map((e) => {
        const [k, v] = e.split(":");
        if (k === "articulo_no_encontrado") return `no existe el artículo ${v}`;
        if (k === "sin_stock") return `sin stock: ${v} (sacalos o cambialos)`;
        if (k === "fecha_retiro_invalida") return `el día de retiro tiene que ser hábil y desde el ${v?.replace("minimo ", "")}`;
        return EXPLICA[k] ?? e;
      });
      const ent = r?.entrega;
      const entrega = ent ? (/^retira$/i.test(String(ent.zona_expreso ?? "").trim())
        ? `retira en Virgilio 2788 el ${String(ent.retiro_fecha ?? "").split("-").reverse().slice(0, 2).join("/")} de ${ent.retiro_franja}`
        : `${ent.label}${ent.nombre_expreso ? ` (por expreso ${ent.nombre_expreso})` : ""}`) : null;
      // Pablo, 30/09 (2.12): "el pedido me salió a nombre de mi otra razón social". En el resumen va a nombre de quién se
      // carga (razón social y CUIT) para que el cliente lo confirme con el "sí".
      let aNombre = "";
      if (r?.ok) {
        const { data: cli } = await supabase.rpc("bot_cliente_por_whatsapp", { p_telefono: phone });
        const c0 = cli?.[0];
        if (c0?.business_name) {
          const { data: cu } = await supabase.from("customers").select("cuit").eq("id", c0.customer_id).maybeSingle();
          aNombre = ` a nombre de *${c0.business_name}*${cu?.cuit ? ` (CUIT ${cu.cuit})` : ""}`;
        }
      }
      const resumen = r?.ok ? [
        `Tu pedido${aNombre}:`,
        ...((r.items ?? []) as Array<{ cajas: number; descripcion: string; cod_art: string; line_total: number }>)
          .map((x) => `• ${x.cajas} ${x.cajas === 1 ? "caja" : "cajas"} ${x.descripcion} (${x.cod_art}) — ${pesos(x.line_total)}`),
        `Subtotal: ${pesos(r.subtotal)}`,
        Number(r.dto_web) > 0 ? `Descuento web ${Math.round(r.dto_web * 100)}% y forma de pago ${r.condicion}` : `Forma de pago: ${r.condicion}`,
        `*Total: ${pesos(r.total)} + IVA*`,
        `Entrega: ${entrega}`,
      ].join("\n") : null;
      const parecidos = (r?.parecidos ?? []) as Array<{ tipo: string; fecha: string; comunes: number; de: number }>;

      if (!confirmar) {
        return { data: { ok: r?.ok === true, errores, avisos: r?.avisos ?? [], resumen_para_el_cliente: resumen,
          ...(parecidos.length ? { parecidos: parecidos.map((p) => `pedido ${p.tipo === "web" ? "por la web" : "por WhatsApp"} del ${p.fecha} con ${p.comunes} de ${p.de} artículos iguales`),
            regla_parecidos: "Antes del resumen preguntale si es un pedido nuevo o el mismo que ese. Si es el mismo, no sigas." } : {}),
          regla: r?.ok ? "Mostrale el resumen tal cual (incluida la razón social a nombre de la que va) y pedile que confirme con un sí." : "Resolvé los errores con el cliente y volvé a armar." } };
      }
      if (!r?.ok) return { data: { ok: false, errores, regla: "No se cargó: resolvé los errores y volvé a armar el pedido." } };
      // Compuerta de servidor (medida 1 de seguridad, Pablo 06/10): el modelo ya no decide solo que el cliente confirmó. Hace falta un
      // sí a secas del cliente sobre el resumen exacto que vio (mismos artículos y total, de hace menos de 1 hora). Ver pedido-gate.ts.
      const veredicto = evaluarConfirmacion({
        textoCliente: ctx.userText, historial: ctx.historial,
        cods: ((r.items ?? []) as Array<{ cod_art: string }>).map((x) => x.cod_art), totalTexto: pesos(r.total),
      });
      if (!veredicto.ok) {
        console.warn(`[gate-pedido] confirmar_pedido bloqueado (${veredicto.motivo}) …${phone.slice(-4)}`);
        return { data: { ok: false, no_cargado: true, regla: REGLA_BLOQUEO[veredicto.motivo] } };
      }
      if (SIM.activo) {
        return { data: { ok: true, simulado: true, texto_para_el_cliente: "¡Listo! Recibimos tu pedido. Lo revisamos y te llega la confirmación por acá. 🙌" } };
      }
      // Pasó la compuerta: ahora sí se guarda. Si entre los dos armados cambió el total (precio o stock), no se carga lo que el cliente no vio.
      const g = await armar(true);
      if (g.error || !g.data?.ok || Math.round(Number(g.data.total)) !== Math.round(Number(r.total))) {
        if (g.error) console.error("bot_pedido_armar (guardar):", g.error.message);
        return { data: { ok: false, no_cargado: true, regla: REGLA_BLOQUEO.resumen_distinto } };
      }
      r = g.data;
      // Precarga guardada. Modo directo: se confirma en el acto (salvo posible doble pedido, que queda para una persona).
      const cfg = await configPedidosWa();
      let directo: { ok: boolean; order_id?: number; error?: string } | null = null;
      if (cfg?.modo === "directo" && r.precarga_id) {
        const { data: c2 } = await supabase.rpc("bot_pedido_confirmar", { p_precarga_id: r.precarga_id, p_por: "bot (modo directo)", p_forzar: false });
        directo = c2 ?? null;
      }
      const { data: cli } = await supabase.rpc("bot_cliente_por_whatsapp", { p_telefono: phone });
      // Si venía de un archivo (cotizador o Excel), la tarea "Pedido por archivo" se cierra: ya está en esta precarga y
      // nadie tiene que cargarlo a mano (evita el doble pedido).
      const { data: arch } = await supabase.from("wa_alertas_humano").select("id, contexto").eq("phone", phone)
        .eq("contexto->>motivo", "pedido_archivo").in("estado", ["pendiente", "notificado"])
        .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString());
      for (const a of arch ?? []) {
        await supabase.from("wa_alertas_humano").update({ estado: "atendido", atendido_por: "bot (pasó a pedido por WhatsApp)",
          atendido_at: new Date().toISOString(), contexto: { ...a.contexto, paso_a_precarga: r.precarga_id } }).eq("id", a.id);
      }
      await notificarHumano({
        tipo: "otro", phone, customerId: cli?.[0]?.customer_id ?? null,
        contexto: {
          motivo: "pedido_whatsapp", origen: "agente_ia", urgente: false, razon_social: r.cliente ?? null,
          texto: `Pedido por WhatsApp: ${pesos(r.total)} + IVA · ${r.condicion} · ${entrega}`,
          precarga: { id: r.precarga_id, origen: r.origen ?? "WhatsApp", dto_web: r.dto_web, total: r.total, subtotal: r.subtotal, condicion: r.condicion, entrega,
            items: (r.items ?? []).map((x: { cod_art: string; descripcion: string; cajas: number; line_total: number }) =>
              ({ cod: x.cod_art, descripcion: x.descripcion, cajas: x.cajas, importe: x.line_total })),
            parecidos, confirmado: directo?.ok === true, order_id: directo?.order_id ?? null, observaciones: input.observaciones || null },
        },
      });
      return { data: { ok: true, texto_para_el_cliente: directo?.ok
        ? "¡Listo! Tu pedido quedó cargado. Te llega la confirmación por acá. 🙌"
        : "¡Listo! Recibimos tu pedido. Lo revisamos y te llega la confirmación por acá. 🙌",
        regla: "Pasale este texto tal cual. No le digas número de pedido." } };
    }

    case "enviar_pedido": {
      if (!PEDIDOS_POR_WHATSAPP) {
        return { data: { error: "Los pedidos no se toman por WhatsApp: indicale que lo haga en loekemeyer.com." } };
      }
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
  "consultar_mis_descuentos", "consultar_mis_facturas", "consultar_novedades", "consultar_stock", "consultar_proximos_ingresos",
  "solicitar_agregado_pedido", "solicitar_nueva_sucursal", "solicitar_cambio_mail",
]);

async function auditTool(
  phone: string,
  tool: string,
  // deno-lint-ignore no-explicit-any
  params: Record<string, any>,
  resumen: string,
): Promise<void> {
  if (!AUDITABLE_TOOLS.has(tool) || SIM.activo) return;
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
  // Simulador: historial en memoria, más nuevo primero (mismo orden que bot_leer_historial).
  if (SIM.activo) return [...SIM.historial].reverse().slice(0, limit);
  const { data, error } = await supabase.rpc("bot_leer_historial", {
    p_telefono: phone,
    p_limit: limit,
  });
  if (error || !data) return [];
  return data;
}

/** Cuántos mensajes guardados tiene el teléfono (los mismos que lee bot_leer_historial). null si no se pudo contar. */
async function contarHistorial(phone: string): Promise<number | null> {
  if (SIM.activo) return SIM.historial.length;
  const { count, error } = await supabase.from("bot_historial_chat").select("telefono", { count: "exact", head: true })
    .eq("telefono", phone).in("rol", ["user", "assistant"]);
  return error || count == null ? null : count;
}

/** Historial para el modelo con la ventana de inicio fijo (ventana-historial.ts), del más nuevo al más viejo. Lectura y conteo van juntos;
 *  si el conteo falla, quedan los últimos 16 como antes. */
async function loadHistoryAnclada(phone: string): Promise<Array<{ rol: string; contenido: string; creado_en: string }>> {
  const [filas, total] = await Promise.all([loadHistory(phone, VENTANA_MIN + VENTANA_PASO - 1), contarHistorial(phone)]);
  return filasDeLaVentana(filas, total);
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
  /** El filtro de salida (filtro-salida.ts) encontró algo que no podía salir en la respuesta. En modo "bloquear" `reply` ya es el texto fijo;
   *  en modo "log" `reply` es la original y sólo se avisó a una persona. */
  bloqueada?: Hallazgo[];
  /** Herramientas que usó en el turno, con su resultado recortado. Lo usa el puntaje de la IA (sql/101). */
  herramientas?: Array<{ nombre: string; input: unknown; resultado: string }>;
  /** Modelo que contestó. */
  modelo?: string;
}

// Pablo, 29/09 (tablero de gasto por motivo): para qué consultó el cliente, deducido de las herramientas que usó la IA
// en el turno. Si derivó, manda el motivo de la derivación. Sin herramientas = conversación general.
const MOTIVO_HERRAMIENTA: Record<string, string> = {
  consultar_mis_facturas: "pago", consultar_mis_descuentos: "pago",
  consultar_mis_pedidos: "entrega", consultar_detalle_pedido: "entrega", consultar_mi_entrega: "entrega",
  solicitar_agregado_pedido: "cambio_pedido", solicitar_nueva_sucursal: "cambio_datos", solicitar_cambio_mail: "cambio_datos",
  consultar_stock: "stock", consultar_proximos_ingresos: "stock", buscar_productos: "productos",
  consultar_novedades: "productos", consultar_mis_top_productos: "productos", enviar_catalogo: "productos",
  enviar_fotos_producto: "productos", consultar_kb: "consulta_general",
};
function motivoDelTurno(usadas: Array<{ nombre: string; input: unknown }>): string {
  // deno-lint-ignore no-explicit-any
  const der = usadas.find((u) => u.nombre === "derivar_a_persona")?.input as any;
  if (der?.motivo) return String(der.motivo);
  for (const u of usadas) if (MOTIVO_HERRAMIENTA[u.nombre]) return MOTIVO_HERRAMIENTA[u.nombre];
  return "consulta_general";
}

// Pablo, 30/09: la IA recibía el historial sin fechas y, si el cliente escribía un mes después, seguía el tema viejo
// como si fuera la misma charla. Le decimos qué día es, cuánto pasó desde el mensaje anterior y que no asuma el tema.
const HORAS_CHARLA_NUEVA = 12;
function fechaHoraAR(d: Date): string {
  return d.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", weekday: "long", day: "2-digit",
    month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function hace(ms: number): string {
  const h = ms / 3600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} minutos`;
  if (h < 48) return `${Math.round(h)} horas`;
  return `${Math.round(h / 24)} días`;
}
export function notaDeTiempo(rawHistory: Array<{ rol: string; contenido: string; creado_en: string }>, userText: string): string {
  const ahora = new Date();
  // rawHistory viene del más nuevo al más viejo; el primero puede ser el mensaje actual (el webhook lo guarda antes).
  const anterior = rawHistory.find((h, i) => !(i === 0 && h.rol === "user" && h.contenido === userText));
  const lineas = [`## Momento de la charla`, `Hoy es ${fechaHoraAR(ahora)} (hora de Argentina).`];
  const t = anterior?.creado_en ? new Date(anterior.creado_en) : null;
  if (!t || isNaN(t.getTime())) {
    lineas.push("Es el primer mensaje de esta charla.");
  } else {
    const ms = ahora.getTime() - t.getTime();
    lineas.push(`El mensaje anterior de la charla es del ${fechaHoraAR(t)} (hace ${hace(ms)}).`);
    if (ms > HORAS_CHARLA_NUEVA * 3600_000) {
      lineas.push(`Pasaron más de ${HORAS_CHARLA_NUEVA} horas: es una charla NUEVA. Lo anterior es sólo referencia; no ` +
        `asumas que el cliente sigue con ese tema ni lo retomes por tu cuenta.`);
    } else {
      // Pablo, 30/09: dentro de las 12 h, un problema o consulta sin decir de qué pedido es por el último del que se habló.
      lineas.push(`Es la misma charla (menos de ${HORAS_CHARLA_NUEVA} horas). Si plantea un problema o una consulta sin ` +
        `decir de qué pedido, asumí que es por el último pedido del que se habló en la charla (o su pedido más reciente) ` +
        `y nombralo por su fecha para que lo confirme.`);
    }
  }
  lineas.push("Si el tema del mensaje no queda claro (por ejemplo, sólo saluda), preguntale en qué lo podés ayudar " +
    "antes de usar herramientas o de hablar de un pedido.");
  return lineas.join("\n");
}

// Pablo, 05/10: lo que el dueño corrigió y APROBÓ (wa_agente_evals.estado = 'aplicada') llega al agente como guía cuando entra una
// consulta parecida: ver _shared/ejemplos-aprobados.ts. Se lee una vez cada 5 minutos por instancia (una aprobación nueva tarda
// hasta ese tiempo en notarse) y NUNCA frena ni rompe el turno (Pablo, 06/10): la lectura espera como mucho 2,5 s; si falla o no
// llega, el agente sigue con los últimos ejemplos leídos (o sin ninguno) y no se reintenta por 60 s (lectorConTope).
const ejemplosAprobados = lectorConTope<EjemploAprobado[]>(async () => {
  const { data, error } = await supabase.from("wa_agente_evals")
    .select("clave, pregunta, respuesta_corregida, nota_esperada").eq("estado", "aplicada").eq("activo", true).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { clave: string | null; pregunta: string | null; respuesta_corregida: string | null; nota_esperada: string | null }) =>
    ({ clave: String(r.clave ?? ""), pregunta: String(r.pregunta ?? ""), respuesta: r.respuesta_corregida, nota: r.nota_esperada }));
}, { topeMs: 2500, vigenciaMs: 5 * 60_000, vigenciaFallaMs: 60_000 }, [],
(e) => console.error("[ejemplosAprobados]", e instanceof Error ? e.message : e));

// ─── Filtro de salida (medida 3 de seguridad, Pablo Olejavetzky 06/10/2026) ───────────────────────────────────────────────────
// Revisa EN CÓDIGO la respuesta del agente antes de que llegue al cliente: claves, nombres de herramientas o tablas, SQL, un volcado del
// bloque de Seguridad o un número / mail que no figura en nada de lo que el modelo vio. Si algo salta, sale un texto fijo y una persona
// recibe la alerta. Las reglas y su calibración contra las respuestas reales: _shared/filtro-salida.ts. Todas las salidas del agente pasan
// por acá (webhook, Simulador y Chat de prueba llaman a runConversation).
// `app_settings.wa_filtro_salida`: sin fila o "1" = bloquea y avisa; "log" = sólo avisa (para mirar falsos positivos sin cortarle nada a un
// cliente); "0" = apagado. Si el filtro mismo falla, la respuesta sale sin filtrar: un bug acá no puede dejar al bot mudo.

// Canario del prompt (medida 4 de seguridad, Pablo 07/10/2026): un código derivado por HMAC de una clave del servidor, que va al final del prompt del
// agente con la orden de no escribirlo. Si aparece en una respuesta (tal cual, en base64, en hex, al revés…), el modelo copió el prompt: el filtro de
// salida la bloquea y avisa. Se calcula una vez por instancia. Sin clave no hay canario y el prompt sale como siempre. Ver _shared/canario.ts.
let _canario: Promise<string | null> | null = null;
function canarioDelServidor(): Promise<string | null> {
  return _canario ??= derivarCanario(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").then((t) => {
    if (!t) console.warn("[canario] no hay SUPABASE_SERVICE_ROLE_KEY: el prompt va sin canario");
    return t;
  }).catch((e) => { console.error("[canario] no se pudo derivar:", e instanceof Error ? e.message : e); return null; });
}

/** Todo lo que el modelo vio en este turno: prompt, mensajes de la charla y resultados de herramientas. Lo que no está acá no está respaldado. */
function corpusDelTurno(systemPrompt: string, history: NormMsg[]): string[] {
  const out = [systemPrompt];
  for (const m of history) {
    if (m.role === "tool") for (const r of m.results) out.push(r.content);
    else out.push(m.text);
  }
  return out;
}

async function filtrarSalida(reply: string, c: {
  phone: string; userText: string; customerName: string; codCliente: number; systemPrompt: string; history: NormMsg[]; herramientas: ToolDef[];
  canario: string | null;
}): Promise<{ reply: string; bloqueada?: Hallazgo[] }> {
  try {
    const modo = modoDelFiltro(await getSetting("wa_filtro_salida"));
    if (modo === "apagado") return { reply };
    const v = revisarSalida({
      reply, corpus: corpusDelTurno(c.systemPrompt, c.history), herramientas: c.herramientas.map((t) => t.name),
      bloqueSeguridad: bloqueSeguridad(c.customerName, c.codCliente), canario: c.canario,
    });
    if (v.ok) return { reply };
    const queSalto = v.hallazgos.map((h) => h.que);
    // Un canario en la respuesta es la señal más fuerte (el modelo copió el prompt): alerta propia y urgente, y bloquea aunque el modo sea "log".
    // El recorte de la respuesta NO se guarda en ese caso: tendría el código. Ver decidirSalida (filtro-salida.ts).
    const { bloquea, hayCanario, origen, urgente } = decidirSalida(modo, v.hallazgos);
    console.warn(`[filtro-salida] ${bloquea ? "bloqueada" : "detectada (sale igual)"}: ${v.hallazgos.map((h) => h.categoria).join(", ")} …${c.phone.slice(-4)}`);
    // Una alerta por número y por hora: un atacante con 20 consultas/h no puede inundar al equipo (pendiente "Topes por acción").
    let yaAvisado = false;
    if (!SIM.activo) {
      const { data } = await supabase.from("wa_alertas_humano").select("id").eq("phone", c.phone).eq("contexto->>origen", origen)
        .gte("created_at", new Date(Date.now() - 3600_000).toISOString()).limit(1);
      yaAvisado = (data ?? []).length > 0;
    }
    if (!yaAvisado) {
      const { data: cli } = await supabase.rpc("wa_identify_customer", { p_phone: c.phone });
      await notificarHumano({
        tipo: "escalation", phone: c.phone, customerId: cli?.[0]?.customer_id ?? null,
        contexto: {
          motivo: "escalation", origen, urgente, razon_social: c.customerName,
          texto: `${bloquea ? "Se bloqueó" : "Se detectó"} una respuesta del asistente antes de enviarla (${queSalto.join("; ")}). `
            + (hayCanario
              ? "⚠ El modelo copió el código de control del prompt: un intento de extraer las instrucciones del bot funcionó, al menos en parte. Mirá el chat y, si hace falta, rotá el código (VERSION_CANARIO en _shared/canario.ts)."
              : "Puede ser un intento de sacarle datos o instrucciones al bot, o un falso positivo del filtro: mirá el chat."),
          texto_recibido: c.userText.slice(0, 200), bloqueo_salida: { modo, hallazgos: v.hallazgos },
          respuesta_bloqueada: hayCanario ? "[omitida: contiene el código de control del prompt]" : taparCanario(redactarSecretos(reply), c.canario).slice(0, 300),
        },
      });
    }
    return bloquea ? { reply: TEXTO_SALIDA_BLOQUEADA, bloqueada: v.hallazgos } : { reply, bloqueada: v.hallazgos };
  } catch (e) {
    console.error("[filtro-salida] falló: la respuesta sale sin filtrar:", e instanceof Error ? e.message : e);
    return { reply };
  }
}

export async function runConversation(
  userText: string,
  phone: string,
  customerName: string,
  codCliente: number,
  dtoVol: number,
  apiKey: string,
  fuente = "lk_whatsapp-webhook",
  // Pablo, 08/10: lo que la capa fija contestaría a un mensaje compuesto o repetido (faq.ts decidirCapaFija). Va al final del prompt.
  opciones: { pistas?: string[] } = {},
): Promise<ConversationResult> {
  // Auditoría 02/10: historial, prompt, herramientas y cadena de modelos no dependen entre sí: se piden juntos. Antes
  // eran ~9 viajes a la base en fila antes de la primera llamada al modelo.
  const canario = await canarioDelServidor();
  const [filasVentana, promptBase, herramientas, chain, ejemplos, hechos] = await Promise.all([
    loadHistoryAnclada(phone),
    buildSystemPrompt(customerName, codCliente, dtoVol, canario),
    herramientasDelTurno(),
    resolveChain(),
    ejemplosAprobados(),
    hechosDeLaCharla(phone),   // Pablo, 08/10: pases a una persona y acciones del bot que ya no entran en las 16 filas (hechos-charla.ts)
  ]);
  // Pablo, 08/10: el modelo ve la ventana anclada (16 a 23 mensajes, para que el caché reuse el historial entre turnos); la nota de tiempo
  // y las compuertas de pedido y de mail siguen viendo los últimos 16, como antes.
  const rawHistory = filasVentana.slice(0, VENTANA_MIN);
  const bloqueAprobados = bloqueEjemplos(elegirEjemplos(userText, ejemplos));
  const pistas = bloquePistas(opciones.pistas ?? []);
  // Pablo, 08/10: el prompt va en dos partes para el caché de Anthropic (bot-llm.ts): la base (reglas y datos del cliente) es igual en todas las
  // llamadas del turno y en los mensajes seguidos del mismo cliente; lo que cambia con cada mensaje (nota de tiempo, hechos, ejemplos, pistas) va
  // dentro del último mensaje del cliente, después del historial (contextoEnElTurno), para no cambiarle el prefijo al historial.
  const promptVariable = notaDeTiempo(rawHistory, userText) + (hechos ? "\n\n" + hechos : "") +
    (bloqueAprobados ? "\n\n" + bloqueAprobados : "") + (pistas ? "\n\n" + pistas : "");
  const systemPrompt = promptBase + "\n\n" + promptVariable;
  // Historial NORMALIZADO (agnóstico de proveedor). Cada adaptador de `bot-llm`
  // lo traduce entero en cada llamada, así el failover puede cambiar de proveedor
  // en cualquier iteración sin romper el formato.
  const history: NormMsg[] = [];
  for (let i = filasVentana.length - 1; i >= 0; i--) {
    const h = filasVentana[i];
    if (h.rol === "user") history.push({ role: "user", text: h.contenido });
    else history.push({ role: "assistant", text: h.contenido, toolCalls: [] });
  }

  // El primer mensaje tiene que ser `user` (lo exigen Anthropic y Gemini). La
  // ventana puede arrancar con `assistant` → se recorta hasta el primer `user`
  // (siempre el mismo mientras la ventana no se corra: no rompe el caché).
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
  const candidates: ResolvedModel[] = chain;
  // Pruebas (simulador y chat de test): un modelo propio, más barato, para no gastar el de producción. Sin la clave
  // app_settings.llm_modelo_pruebas todo sigue igual. Con la clave, la prueba usa SÓLO los modelos de esa lista (uno o varios, separados
  // por coma, en orden: Pablo, 08/10, ver modelos-prueba.ts): si fallan todos, la prueba falla (llmError) y NO cae a la cadena, para que
  // una caída no se pague en otro modelo sin que nadie se entere (Pablo, 01/10).
  let soloPruebas = false;
  if (apiKey && (fuente === "lk_bot-simular" || fuente === "lk_chat-test")) {
    const modelosPrueba = listaModelosPrueba(await getSetting("llm_modelo_pruebas"));
    if (modelosPrueba.length) {
      candidates.length = 0;
      for (const [i, modelo] of modelosPrueba.entries()) {
        // Si el model_id es de otro proveedor con key cargada en el panel (ej. gemini-3.5-flash-lite) se usa ése; si no, es de Anthropic.
        const m = (await resolveModelById(modelo)) ?? { id: -1, provider: "anthropic", model: modelo, key: apiKey, isFreeTier: false };
        candidates.push({ ...m, id: idModeloPrueba(i) });
      }
      soloPruebas = true;
    }
  }
  if (apiKey && !soloPruebas) {
    candidates.push({ id: 0, provider: "anthropic", model: "claude-sonnet-4-6", key: apiKey, isFreeTier: false });
  }
  // Pablo, 05/10: la TOMA DE PEDIDOS (cotizador, orden de compra, armar / confirmar / agregar a un pedido) la contesta SIEMPRE un
  // modelo fijo (Sonnet), no la cadena de producción (hoy Gemini gratis #1): "no podemos fallar ahí". Si Sonnet falla se reintenta
  // una vez con el mismo modelo y, si vuelve a fallar, se avisa a una persona (alerta llm_error): NUNCA cae en otro proveedor, para
  // que un pedido no lo tome un modelo más débil. `app_settings.llm_modelo_pedidos` cambia el modelo ("cadena" lo apaga). En el
  // Simulador y el Chat de prueba no corre (usan el modelo de pruebas: un gasto en Sonnet necesita el "sí" de Pablo, 01/10).
  const turnoPedido = esTurnoDePedido(userText, rawHistory);
  if (turnoPedido && apiKey && !soloPruebas) {
    const fijo = modeloFijoDePedidos(await getSetting("llm_modelo_pedidos"));
    if (fijo) { candidates.length = 0; candidates.push(...candidatosDePedido(fijo, apiKey)); }
  }
  if (!candidates.length) {
    await notificarHumano({ tipo: "llm_error", phone, contexto: { userText, error: "Sin modelos en la cadena ni ANTHROPIC_API_KEY" } });
    return { reply: "⚠️ [LLM_ERROR] No hay modelos configurados. Se avisó a un humano.", media: [], llmError: true };
  }

  const allMedia: MediaAction[] = [];
  const usadas: Array<{ nombre: string; input: unknown; resultado: string }> = [];
  // El uso de cada llamada se registra al final del turno, con el motivo (se sabe recién cuando terminó).
  const usos: Array<{ res: Parameters<typeof logUsage>[0]; free: boolean }> = [];
  const registrarUsos = () => { const m = motivoDelTurno(usadas); for (const u of usos) logUsage(u.res, u.free, phone, fuente, m); };
  const downThisTurn = new Set<number>(); // modelos que ya fallaron en este turno

  for (let iter = 0; iter < 5; iter++) {
    let res = null as Awaited<ReturnType<typeof callModel>> | null;
    let used: ResolvedModel | null = null;
    let lastErr = "";
    let lastStatus: number | undefined;

    // Failover: probamos la cadena en orden hasta que un modelo responda.
    for (const cand of candidates) {
      if (downThisTurn.has(cand.id)) continue;
      if (cand.id === -2) await new Promise((r) => setTimeout(r, 1500));   // reintento del modelo fijo de pedidos (candidatosDePedido)
      const t0 = performance.now();
      try {
        // Pablo, 06/10: Gemini con tope corto (8 s) para que un cuelgue de Google no le cueste 30 s al cliente: ver _shared/timeouts.ts.
        res = await callModel(cand, { estable: promptBase, variable: promptVariable }, herramientas, history, timeoutDeModelo(cand.provider));
        used = cand;
        logIntento({
          funcion: fuente, modeloId: cand.id, proveedor: cand.provider, modelo: cand.model, tarea: "conversacion",
          iteracion: iter + 1, ok: true, duracionMs: performance.now() - t0,
          inputTokens: res.inputTokens, outputTokens: res.outputTokens,
        });
        break;
      } catch (e) {
        const emsg = e instanceof Error ? e.message : String(e);
        // deno-lint-ignore no-explicit-any
        lastStatus = (e as any)?.status as number | undefined;
        lastErr = emsg;
        console.error(`[runConversation] ${cand.provider}/${cand.model} falló: ${emsg}`);
        logIntento({
          funcion: fuente, modeloId: cand.id, proveedor: cand.provider, modelo: cand.model, tarea: "conversacion",
          iteracion: iter + 1, ok: false, httpStatus: lastStatus, error: emsg, duracionMs: performance.now() - t0,
        });

        // Con cadena multi-proveedor, SIEMPRE probamos el próximo candidato: un 400 puede
        // ser un schema que ESE proveedor no acepta (y otro sí), no un error universal.
        // Lo saltamos este turno igual (reintentar el mismo da el mismo error).
        downThisTurn.add(cand.id);

        // Sólo penalizamos con cooldown persistente si la culpa es del modelo
        // (401/403/404/429/5xx/timeout). Un 400/413/422 es del request → no cooldown,
        // así no dejamos caído un modelo bueno por un payload puntual.
        if (!esCulpaDelRequest(lastStatus)) {
          markModelDown(cand.id, emsg, cooldownParaError(lastStatus, emsg)).catch(() => {});
        }
      }
    }

    if (!res || !used) {
      // Toda la cadena cayó (incluido el fallback de env).
      const isTimeout = /timeout|abort/i.test(lastErr);
      await notificarHumano({ tipo: isTimeout ? "llm_timeout" : "llm_error", phone, contexto: { userText, iter, error: lastErr.slice(0, 500) } });
      registrarUsos();
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
    usos.push({ res, free: used.isFreeTier });

    if (!res.toolCalls.length) {
      registrarUsos();
      // Pablo, 05/10: sin cierres de cortesía ("¿Necesitás algo más?"): ver _shared/cierre.ts y la regla CIERRE de agente-fijos.ts.
      // El texto de respaldo (la IA no devolvió nada) tampoco cierra con "¿en qué más…?": pide que cuente la consulta (o, si derivó, dice que una persona escribe).
      // En un turno de pedido "¿Algo más?" puede ser una pregunta de verdad (¿más artículos?): ahí sólo se sacan los cierres de ayuda.
      const enPedido = turnoPedido || usadas.some((u) => HERRAMIENTAS_DE_PEDIDO.has(u.nombre));
      // Pablo, 07/10: si el modelo no escribió nada pero en el turno se derivó (derivar_a_persona), el respaldo lo dice en vez de pedir que cuente más (respaldo-texto.ts).
      const textoFinal = sinCierreGenerico(res.text || textoDeRespaldo(usadas), enPedido);
      const salida = await filtrarSalida(textoFinal, { phone, userText, customerName, codCliente, systemPrompt, history, herramientas, canario });
      return { reply: salida.reply, media: salida.reply === textoFinal ? allMedia : [],   // respuesta reemplazada: tampoco salen las fotos del turno
        herramientas: usadas, modelo: used.model, ...(salida.bloqueada ? { bloqueada: salida.bloqueada } : {}) };
    }

    // El modelo pidió herramientas: las ejecutamos y devolvemos los resultados.
    history.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });

    const results: { id: string; name: string; content: string }[] = [];
    for (const tc of res.toolCalls) {
      const result = await executeTool(tc.name, tc.input ?? {}, phone, { userText, historial: rawHistory });
      if (result.media) allMedia.push(...result.media);
      auditTool(phone, tc.name, tc.input ?? {}, JSON.stringify(result.data).slice(0, 500)).catch(() => {});
      results.push({ id: tc.id, name: tc.name, content: JSON.stringify(result.data) });
      usadas.push({ nombre: tc.name, input: tc.input ?? {}, resultado: JSON.stringify(result.data).slice(0, 1500) });
    }
    history.push({ role: "tool", results });
  }

  registrarUsos();
  return {
    reply: "Disculpá, no pude completar tu consulta. ¿Podés reformular tu pregunta?",
    media: allMedia,
    herramientas: usadas,
  };
}
