// Agregar artículos a un pedido que YA ENTRÓ EN ARMADO o está facturado (Pablo Olejavetzky, 06/10/2026: "que consulte a logística
// derivando"; esa misma tarde cambió: "todas las dudas pasan por Ventas primero, sacá a Logística del medio", así que ahora se consulta a Ventas). Antes, solicitar_agregado_pedido le contestaba al cliente "ya está en armado, no le podemos sumar" y no avisaba a nadie.
// Ahora el bot NO decide que no se puede: deriva a una persona (alerta `cambio_pedido`, sin botón "Aplicar") con lo que el cliente pide
// sumar, y al cliente le dice que lo está consultando, sin prometer que se va a poder. Un pedido ya ENTREGADO no se deriva: no hay a qué
// sumarle nada, se carga uno nuevo en la web.
//
// Módulo PURO (sin red ni base): sólo decide el caso y arma los textos. La herramienta vive en bot-conversation.ts. Se prueba en
// tests/agregado-armado.test.ts.

export type CasoAgregado = "normal" | "en_armado" | "entregado";

/** Qué hacer con un pedido según su estado en Gestión (`bot_estado_pedidos_gv`) y si ya se mandó a compras. */
export function casoDeAgregado(estado: string, enviadoACompras: boolean): CasoAgregado {
  if (estado === "entregado") return "entregado";
  if (estado === "en preparacion" || estado === "facturado" || enviadoACompras) return "en_armado";
  return "normal";
}

const cajas = (n: unknown) => `${n} ${Number(n) === 1 ? "caja" : "cajas"}`;
export interface ItemAgregado { cajas: number; descripcion: string; cod: string }
const linea = (a: ItemAgregado) => `${cajas(a.cajas)} de ${a.descripcion} (cód. ${a.cod})`;

/** Cómo está el pedido, dicho para el cliente. */
function situacion(estado: string): string {
  return estado === "facturado" ? "ya está facturado" : "ya está en armado";
}

/** Texto para el cliente: lo consultamos con Ventas, sin prometer. */
export function textoClienteEnArmado(del: string, estado: string, items: ItemAgregado[]): string {
  return `Tu pedido del ${del} ${situacion(estado)}, así que no lo puedo modificar yo. Le consulté a Ventas si pueden sumarle:\n` +
    items.map((a) => `• ${linea(a)}`).join("\n") +
    `\nTe confirmamos por acá si llegan a tiempo.`;
}

/** Texto de la tarea para la persona que recibe la consulta. */
export function textoTareaEnArmado(del: string, estado: string, items: ItemAgregado[]): string {
  return `Pidió SUMAR al pedido del ${del}, que ${situacion(estado)} (no se aplica solo, hay que ver si llega a tiempo): ` +
    items.map(linea).join("; ") + `. Avisarle por acá si se puede o no.`;
}

/** Pedido ya entregado: no hay a qué sumarle, se hace uno nuevo. */
export function textoClienteEntregado(del: string): string {
  return `Tu pedido del ${del} ya fue entregado, así que no se le puede sumar nada. Si querés, cargá un pedido nuevo con lo que te falta ` +
    `en loekemeyer.com → "Pedidos Mayorista".`;
}

// ── Una sola alerta por pedido y artículos (Pablo, 06/10) ──
// En el simulador la IA (Gemini) llamó a la herramienta ANTES de la confirmación y otra vez con el "Sí, confirmo": dos tareas urgentes iguales
// para Ventas. Mientras haya una alerta ABIERTA (pendiente o notificado) del mismo teléfono, del mismo pedido y con los mismos artículos y
// cajas, no se crea otra y al cliente se le da el mismo texto. Otro pedido, o otros artículos, sí crean la suya. Si la lectura de alertas
// falla se crea igual: una repetida molesta menos que una consulta perdida.

export interface ItemDeAlerta { cod: string; cajas: number }
export interface AlertaAbierta { contexto: Record<string, unknown> | null }

/** Firma estable de lo pedido: artículos ordenados por código, con las cajas sumadas si el mismo código viene dos veces. */
export function firmaDeItems(items: ItemDeAlerta[]): string {
  const por = new Map<string, number>();
  for (const it of items) por.set(String(it.cod).trim().toUpperCase(), (por.get(String(it.cod).trim().toUpperCase()) ?? 0) + Number(it.cajas));
  return [...por.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c}:${n}`).join("|");
}

/** ¿Ya hay una alerta abierta de "agregar en armado" para este pedido y estos artículos? */
export function yaHayAlertaIgual(abiertas: AlertaAbierta[], pedido: number, items: ItemDeAlerta[]): boolean {
  const firma = firmaDeItems(items);
  return abiertas.some((a) => {
    const c = a.contexto ?? {};
    if (c.motivo !== "cambio_pedido" || c.en_armado !== true || Number(c.pedido) !== Number(pedido) || !Array.isArray(c.items)) return false;
    return firmaDeItems(c.items as ItemDeAlerta[]) === firma;
  });
}
