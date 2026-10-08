// _shared/inactivos.ts — Qué se le dice al cliente de un artículo INACTIVO (products.active = false).
// Pablo Olejavetzky, 08/10/2026 (tareas 5283 y 5448): hasta el 08/10 TODO inactivo se decía "discontinuado", pero `active = false` mezcla cosas. Medido sobre los inactivos de
// Loekemeyer (07 y 08/10): 4 con la etiqueta «SIN STOCK» (333, 334, 336 y 337: 118 pedidos en 12 meses), 3 «LIQUIDACIÓN», 8 «NUEVO» y 52 sin etiqueta. Siete de los
// «NUEVO» / «LIQUIDACIÓN» tienen el precio provisorio 8888 y 0 pedidos: pueden ser lanzamientos sin habilitar, no discontinuados.
//
// Qué se dice (Pablo, 08/10: «no están en la página, puede ser que no haya stock, o que estén discontinuados en este momento» y, sobre los sin etiqueta, «si no está en la página, no disponible»):
//   - «SIN STOCK»  → sin stock: el stock lo dice consultar_stock (regla STOCK del agente).
//   - todo el resto → no disponible por el momento: no se sabe si es por stock o si ya no se hace, así que no se afirma ninguna de las dos. NUNCA se dice "discontinuado".
//
// Módulo puro, sin imports: lo usa bot-conversation.ts (buscar_productos) y lo prueba tests/inactivos.test.ts.

/** «SIN STOCK»: figura como sin stock. Para decir si hay o no hay stock manda la regla STOCK del agente (consultar_stock, sin números). */
export const REGLA_SIN_STOCK = "Ese artículo figura como sin stock, no como discontinuado. No digas que está discontinuado ni prometas cuándo vuelve, ni que no lo encontraste ni que revise el código. Para decir si hay o no stock usá consultar_stock con su código (regla STOCK) y pasá lo que dice su texto. Ofrecele además el más parecido de parecidos_activos (con el link de su foto si lo tiene) por si no puede esperar.";

/** Cualquier otro inactivo (sin etiqueta, «NUEVO», «LIQUIDACIÓN»): no figura en la web y no se sabe si es por falta de stock o porque ya no se hace. No se afirma ninguna de las dos cosas. */
export const REGLA_NO_DISPONIBLE = "Ese artículo no está disponible por el momento: no figura en la web y no sabemos si es por falta de stock o porque ya no se hace. No digas que está discontinuado ni que no hay stock, ni prometas cuándo vuelve, ni que no lo encontraste ni que revise el código. Nombralo con su descripción y ofrecele el más parecido de parecidos_activos (con el link de su foto si lo tiene) por si lo necesita.";

export type EstadoInactivo = "sin_stock" | "no_disponible";

const sinTildes = (x: string): string => x.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

/** El estado de un artículo inactivo según su etiqueta (`products.badge_status`). Sólo «SIN STOCK» es distinto: todo lo demás (sin etiqueta, «NUEVO», «LIQUIDACIÓN», una etiqueta que no se conoce) es no disponible. */
export function estadoDeInactivo(badge: string | null | undefined): EstadoInactivo {
  return sinTildes(String(badge ?? "")).trim() === "sin stock" ? "sin_stock" : "no_disponible";
}

/** La regla que acompaña la respuesta de buscar_productos: una por cada tipo de inactivo que haya en la lista (si hay de los dos, las dos, sin stock primero).
 *  Un item sin marca se trata como no disponible. "" si la lista está vacía. */
export function reglaDeInactivos(items: Array<{ sin_stock?: boolean; no_disponible?: boolean }>): string {
  const haySinStock = items.some((i) => i.sin_stock === true);
  const hayNoDisponible = items.some((i) => i.sin_stock !== true);
  return [haySinStock ? REGLA_SIN_STOCK : "", hayNoDisponible ? REGLA_NO_DISPONIBLE : ""].filter(Boolean).join(" ");
}
