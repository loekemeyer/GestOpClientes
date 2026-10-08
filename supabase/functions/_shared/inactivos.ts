// _shared/inactivos.ts — Qué se le dice al cliente de un artículo INACTIVO (products.active = false).
// Pablo Olejavetzky, 08/10/2026 (tarea 5283): hasta hoy TODO inactivo se decía "discontinuado", pero `active = false` mezcla cosas. Medido sobre los inactivos de
// Loekemeyer (07 y 08/10): 4 con la etiqueta «SIN STOCK» (333, 334, 336 y 337: 118 pedidos en 12 meses), 3 «LIQUIDACIÓN», 8 «NUEVO» y el resto sin etiqueta. Siete de los
// «NUEVO» / «LIQUIDACIÓN» tienen el precio provisorio 8888 y 0 pedidos: pueden ser lanzamientos sin habilitar, no discontinuados.
//
// Qué se dice (decisión de Pablo, 08/10: «no están en la página, puede ser que no haya stock, o que estén discontinuados en este momento»):
//   - «SIN STOCK»              → sin stock: NO discontinuado; el stock lo dice consultar_stock (regla STOCK del agente).
//   - «NUEVO» y «LIQUIDACIÓN»  → no disponible por el momento: no se sabe si es por stock o si ya no se hace, así que no se afirma ninguna de las dos.
//   - sin etiqueta             → discontinuado, como siempre (Pablo, 30/09, fila 2.5). Queda abierto si los que se pidieron hace poco (565, 561…) deben decirse igual.
//
// Módulo puro, sin imports: lo usa bot-conversation.ts (buscar_productos) y lo prueba tests/inactivos.test.ts.

export const REGLA_DISCONTINUADO = "Decile que ese código está discontinuado (nombrándolo con su descripción), nunca que no lo encontraste ni que revise el código, y ofrecele el más parecido de parecidos_activos con el link de su foto si lo tiene, para que confirme.";

/** «SIN STOCK»: no está discontinuado. Para decir si hay o no hay stock manda la regla STOCK del agente (consultar_stock, sin números). */
export const REGLA_SIN_STOCK = "Ese artículo NO está discontinuado: figura como sin stock. No digas que está discontinuado ni prometas cuándo vuelve, ni que no lo encontraste ni que revise el código. Para decir si hay o no stock usá consultar_stock con su código (regla STOCK) y pasá lo que dice su texto. Ofrecele además el más parecido de parecidos_activos (con el link de su foto si lo tiene) por si no puede esperar.";

/** «NUEVO» o «LIQUIDACIÓN» estando inactivo: no figura en la web y no se sabe si es por falta de stock o porque ya no se hace. No se afirma ninguna de las dos cosas. */
export const REGLA_NO_DISPONIBLE = "Ese artículo no está disponible por el momento: no figura en la web y no sabemos si es por falta de stock o porque ya no se hace. No digas que está discontinuado ni que no hay stock, ni prometas cuándo vuelve, ni que no lo encontraste ni que revise el código. Nombralo con su descripción y ofrecele el más parecido de parecidos_activos (con el link de su foto si lo tiene) por si lo necesita.";

export type EstadoInactivo = "sin_stock" | "no_disponible" | "discontinuado";

const sinTildes = (x: string): string => x.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

/** El estado de un artículo inactivo según su etiqueta (`products.badge_status`). Sin etiqueta (o una que no se conoce) sigue siendo discontinuado. */
export function estadoDeInactivo(badge: string | null | undefined): EstadoInactivo {
  const b = sinTildes(String(badge ?? "")).trim();
  if (b === "sin stock") return "sin_stock";
  if (b === "liquidacion" || b === "nuevo") return "no_disponible";
  return "discontinuado";
}

/** La regla que acompaña la respuesta de buscar_productos: una por cada tipo de inactivo que haya en la lista (si hay de varios, todas, en este orden:
 *  discontinuado, sin stock, no disponible). Un item sin marca se trata como discontinuado (así eran todos antes). "" si la lista está vacía. */
export function reglaDeInactivos(items: Array<{ discontinuado?: boolean; sin_stock?: boolean; no_disponible?: boolean }>): string {
  const hayDiscontinuado = items.some((i) => i.sin_stock !== true && i.no_disponible !== true);
  const haySinStock = items.some((i) => i.sin_stock === true);
  const hayNoDisponible = items.some((i) => i.no_disponible === true);
  return [hayDiscontinuado ? REGLA_DISCONTINUADO : "", haySinStock ? REGLA_SIN_STOCK : "", hayNoDisponible ? REGLA_NO_DISPONIBLE : ""].filter(Boolean).join(" ");
}
