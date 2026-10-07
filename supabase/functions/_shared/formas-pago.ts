// Formas de pago que el agente de IA le ofrece al cliente en un pedido por WhatsApp (herramienta opciones_de_pedido). Pablo Olejavetzky, 07/10/2026, corrección m12 del artifact:
// "Sacale los códigos, y el 'prefiero no decidir ahora'. Me parece que sobra." → "sí, ese texto". Antes la herramienta devolvía `{ code: 8, texto: "Contado…" }` y el modelo
// mostraba "8 - Contado, 9 - 15 a 30 días… 18 - Prefiero no decidir ahora": los códigos internos como si fueran la numeración, y una opción que sobra.
// Módulo PURO, sin imports: lo usa bot-conversation.ts y lo prueba tests/formas-pago.test.ts.

/** Los códigos de forma de pago que acepta armar_pedido (condicion_code). El 18 ("Prefiero no decidir ahora") se sigue aceptando si el cliente lo pide, pero ya no se ofrece. */
export const CODIGOS_FORMA_DE_PAGO = [8, 9, 10, 11, 12, 13, 18] as const;

const FORMAS: ReadonlyArray<readonly [number, string]> = [
  [8, "Contado (25% de descuento)"], [9, "15 a 30 días (20%)"], [10, "31 a 45 días (15%)"], [11, "46 a 60 días (10%)"],
  [12, "E-cheq a 90 días (5%)"], [13, "E-cheq a 120 días (sin descuento)"],
];

export type FormaDePago = { opcion: number; texto: string; condicion_code: number };

/** Las opciones para mostrar: numeradas 1, 2, 3… (`opcion`, lo que ve el cliente) y con el código interno aparte (`condicion_code`, sólo para armar_pedido).
 *  Una cuenta que sólo puede pedir de contado ve únicamente "Contado". */
export function formasDePago(soloContado: boolean): FormaDePago[] {
  return FORMAS.filter(([code]) => !soloContado || code === 8).map(([code, texto], i) => ({ opcion: i + 1, texto, condicion_code: code }));
}
