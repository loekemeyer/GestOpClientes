// _shared/inactivos.ts — Qué se le dice al cliente de un artículo INACTIVO (products.active = false).
// Pablo Olejavetzky, 08/10/2026 (tareas 5283, 5448 y 5456): hasta el 08/10 TODO inactivo se decía "discontinuado", pero `active = false` mezcla cosas. Medido sobre los inactivos de
// Loekemeyer (07 y 08/10): 67 en total, 4 con la etiqueta «SIN STOCK» (333, 334, 336 y 337: 118 pedidos en 12 meses), 3 «LIQUIDACIÓN», 8 «NUEVO» y 52 sin etiqueta. Siete de los
// «NUEVO» / «LIQUIDACIÓN» tienen el precio provisorio 8888 y 0 pedidos: pueden ser lanzamientos sin habilitar, no discontinuados.
//
// Qué se dice (Pablo, 08/10): «no están en la página, puede ser que no haya stock, o que estén discontinuados en este momento» → «si no está en la página, no disponible» → y lo mismo
// para «SIN STOCK» («sí, hacelo así»). UNA sola regla para TODOS los inactivos, sin mirar la etiqueta (`badge_status`): "no disponible por el momento". NUNCA se dice "discontinuado" ni
// "no hay stock" (no se sabe cuál de las dos es). Sólo si el cliente insiste en saber si hay stock, el agente usa consultar_stock (regla STOCK).
//
// Módulo puro, sin imports: lo usa bot-conversation.ts (buscar_productos) y lo prueba tests/inactivos.test.ts.

export const REGLA_NO_DISPONIBLE = "Ese artículo no está disponible por el momento: no figura en la web y no sabemos si es por falta de stock o porque ya no se hace. No digas que está discontinuado ni que no hay stock, ni prometas cuándo vuelve, ni que no lo encontraste ni que revise el código. Nombralo con su descripción y ofrecele el más parecido de parecidos_activos (con el link de su foto si lo tiene) por si lo necesita. Sólo si el cliente insiste en saber si hay stock, usá consultar_stock con su código (regla STOCK) y pasá lo que dice su texto.";
