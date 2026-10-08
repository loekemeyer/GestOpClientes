// _shared/inactivos.ts — Qué se le dice al cliente de un artículo INACTIVO (products.active = false).
// Pablo Olejavetzky, 08/10/2026 (tarea 5283): hasta hoy TODO inactivo se decía "discontinuado", pero `active = false` mezcla cosas. Medido el 07/10 sobre los 66
// inactivos: 4 con la etiqueta «SIN STOCK» (333, 336, 334 y 337: 118 pedidos en 12 meses), 3 «LIQUIDACIÓN», 7 «NUEVO» y el resto sin etiqueta. Un artículo «SIN STOCK»
// no está discontinuado: decírselo así es prometerle al cliente que no vuelve.
//
// Alcance de este cambio: SÓLO «SIN STOCK» deja de decirse discontinuado. «LIQUIDACIÓN» y «NUEVO» inactivos siguen como antes (discontinuado): no se sabe qué quieren decir
// estando inactivos (el Automate, cód. 597, es «NUEVO» e inactivo y se contesta como discontinuado desde el 06/10, m72) y eso lo decide Pablo.
//
// Módulo puro, sin imports: lo usa bot-conversation.ts (buscar_productos) y lo prueba tests/inactivos.test.ts.

export const REGLA_DISCONTINUADO = "Decile que ese código está discontinuado (nombrándolo con su descripción), nunca que no lo encontraste ni que revise el código, y ofrecele el más parecido de parecidos_activos con el link de su foto si lo tiene, para que confirme.";

/** «SIN STOCK»: no está discontinuado. Para decir si hay o no hay stock manda la regla STOCK del agente (consultar_stock, sin números). */
export const REGLA_SIN_STOCK = "Ese artículo NO está discontinuado: figura como sin stock. No digas que está discontinuado ni prometas cuándo vuelve. Para decir si hay o no stock usá consultar_stock con su código (regla STOCK) y pasá lo que dice su texto. Ofrecele además el más parecido de parecidos_activos (con el link de su foto si lo tiene) por si no puede esperar.";

export type EstadoInactivo = "sin_stock" | "discontinuado";

const sinTildes = (x: string): string => x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** El estado de un artículo inactivo según su etiqueta (`products.badge_status`). Sólo «SIN STOCK» es otra cosa: todo lo demás sigue siendo discontinuado. */
export function estadoDeInactivo(badge: string | null | undefined): EstadoInactivo {
  return sinTildes(String(badge ?? "")).trim() === "sin stock" ? "sin_stock" : "discontinuado";
}

/** La regla que acompaña la respuesta de buscar_productos: una por cada tipo de inactivo que haya en la lista (si hay de los dos, las dos). "" si la lista está vacía. */
export function reglaDeInactivos(items: Array<{ discontinuado?: boolean; sin_stock?: boolean }>): string {
  const hayDiscontinuado = items.some((i) => i.sin_stock !== true);
  const haySinStock = items.some((i) => i.sin_stock === true);
  return [hayDiscontinuado ? REGLA_DISCONTINUADO : "", haySinStock ? REGLA_SIN_STOCK : ""].filter(Boolean).join(" ");
}
