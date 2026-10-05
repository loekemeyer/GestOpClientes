// aviso-pedido — valores de los avisos de seguimiento armados con un pedido web REAL (sin red, funciones puras).
// Lo usan lk_templates (Prueba de plantillas) y lk_bot-simular (botonera del Simulador). Pablo Olejavetzky, 05/10:
// el Simulador mandaba los avisos con los valores de ejemplo de plantillas-meta.ts ("Lamadrid 157 - S.M. Tucumán") y
// con la versión que se tocara, aunque el cliente fuera por expreso. Ahora usa el último pedido del cliente y la
// versión que le corresponde según cómo se le entrega.

export type Modo = "propio" | "expreso" | "retira";

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** "YYYY-MM-DD" en hora de Argentina, como los disparadores (AT TIME ZONE 'America/Argentina/Buenos_Aires'). Cortar el
 *  timestamp UTC daba el día siguiente a un pedido hecho después de las 21. */
export const fechaAR = (ts?: string | null) =>
  ts ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(ts)) : "";

/** "30/09" a partir de "2026-09-30…". */
export const fechaCorta = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "");
/** "miércoles 30/09": fecha de salida con día de la semana, sin año. */
export const fechaLarga = (d?: string | null) =>
  d ? `${DIAS[new Date(d.slice(0, 10) + "T12:00:00Z").getUTCDay()]} ${fechaCorta(d)}` : "";
export function masDias(d: string | null, n: number): string | null {
  if (!d) return null;
  const x = new Date(d.slice(0, 10) + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
// deno-lint-ignore no-explicit-any
export function modoDe(np: any): Modo {
  if (np.retiro_fecha || /retira/i.test(np.nombre_expreso ?? "")) return "retira";
  return np.nombre_expreso ? "expreso" : "propio";
}

/** "$13.144.191": pesos sin decimales con punto de miles, igual que to_char(…, 'FM999G999G999') de los disparadores. */
export const pesos = (n: number) => "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

// Versión de cada aviso según cómo se entrega el pedido (mismo criterio que los disparadores, sql/079 y 105).
// null = a ese modo no se le manda ese aviso.
const VARIANTES: Record<string, Record<Modo, string | null>> = {
  programado: { propio: "pedido_programado", expreso: "pedido_programado_expreso", retira: "pedido_programado_retira" },
  salida: { propio: "pedido_en_viaje", expreso: "pedido_en_viaje_expreso", retira: "pedido_listo_retirar" },
  entregado: { propio: "pedido_entregado", expreso: null, retira: null },
};
const FAMILIA: Record<string, string> = {
  pedido_programado: "programado", pedido_programado_expreso: "programado", pedido_programado_retira: "programado",
  pedido_en_viaje: "salida", pedido_en_viaje_expreso: "salida", pedido_listo_retirar: "salida",
  pedido_entregado: "entregado",
};
/** Avisos de seguimiento que se pueden armar con un pedido real (los demás salen con los valores de ejemplo). */
export const AVISOS_DE_PEDIDO = new Set(["pedido_recibido", "pedido_reprogramado", ...Object.keys(FAMILIA)]);

/** La versión del aviso que le llega a un pedido con ese modo; null si a ese modo no se le manda. */
export function avisoParaModo(nombre: string, modo: Modo): string | null {
  const f = FAMILIA[nombre];
  return f ? VARIANTES[f][modo] : nombre;
}

export type DatosPedido = {
  order_id: number;
  razon_social: string;
  /** Fecha del pedido, "YYYY-MM-DD". */
  pedido_el: string;
  /** Fecha de salida o de retiro, "YYYY-MM-DD" (null si todavía no tiene). */
  salida: string | null;
  modo: Modo;
  expreso: string;
  direccion: string;
  /** Total de orders: sin IVA, con los descuentos ya aplicados. */
  total_neto: number | null;
  /** Método de pago ya limpio (wa_metodo_pago_texto). */
  metodo: string | null;
  /** Entrega estimada (wa_fecha_estimada o wa_fecha_estimada_calc). */
  estimada: string | null;
};

/** Valores {{1}}…{{n}} del aviso con los datos del pedido, en el orden de plantillas-meta.ts. null si no es de seguimiento. */
export function paramsAviso(nombre: string, d: DatosPedido): string[] | null {
  const fp = fechaCorta(d.pedido_el);
  const sal = fechaLarga(d.salida) || "(sin fecha todavía)";
  const exp = d.expreso.replace(/^expreso\s+/i, "");
  switch (nombre) {
    // sql/108: total con IVA y el neto, "$896.668 ($741.048 + IVA)" (texto de pedido_recibido_v2, el de plantillas-meta.ts).
    case "pedido_recibido":
      return [d.razon_social || "cliente", fp,
        d.total_neto == null ? "(sin total)" : `${pesos(d.total_neto * 1.21)} (${pesos(d.total_neto)} + IVA)`,
        d.metodo || "a confirmar", d.estimada || "a confirmar"];
    case "pedido_programado": return [fp, sal, d.direccion || "tu dirección de entrega"];
    case "pedido_programado_expreso": return [fp, sal, exp];
    case "pedido_programado_retira": return [fp, sal];
    // La fecha nueva no existe hasta que se reprograma: dos días después de la salida, como ejemplo.
    case "pedido_reprogramado": return [fp, fechaLarga(masDias(d.salida, 2)) || "(nueva fecha)"];
    case "pedido_en_viaje": return [fp, d.direccion || "tu dirección de entrega"];
    case "pedido_en_viaje_expreso": return [fp, exp];
    // sql/110: hasta cuándo retirarlo, con el artículo ("el jueves 02/10"), o "la fecha acordada" si no hay fecha.
    case "pedido_listo_retirar": return [fp, d.salida ? `el ${fechaLarga(d.salida)}` : "la fecha acordada"];
    case "pedido_entregado": return [fp];
    default: return null;
  }
}

/** "por Expreso Arnes" · "reparto propio a Santa Fe 1837" · "retira en depósito". */
export function modoTexto(d: Pick<DatosPedido, "modo" | "expreso" | "direccion">): string {
  if (d.modo === "expreso") return `por Expreso ${d.expreso.replace(/^expreso\s+/i, "")}`;
  if (d.modo === "retira") return "retira en depósito";
  return d.direccion ? `reparto propio a ${d.direccion}` : "reparto propio";
}
