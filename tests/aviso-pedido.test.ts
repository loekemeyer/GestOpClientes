// Pruebas de los avisos armados con un pedido real (supabase/functions/_shared/aviso-pedido.ts). Lógica pura, sin red.
// Correr: deno run tests/aviso-pedido.test.ts   (sale con código 1 si algo falla)
import { avisoParaModo, type DatosPedido, fechaAR, modoDe, modoTexto, paramsAviso, pesos } from "../supabase/functions/_shared/aviso-pedido.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Pedido real 1509 de Torres y Liva (288), Mar del Plata por Expreso Arnes (datos del 05/10).
const expreso: DatosPedido = {
  order_id: 1509, razon_social: "Torres Y Liva S.A Cif", pedido_el: "2026-09-21", salida: "2026-09-29", modo: "expreso",
  expreso: "Arnes", direccion: "Rivadavia 3663- Mar Del Plata", total_neto: 10862967.78, metodo: "contado",
  estimada: "martes 13/10 (te lo dejamos en el expreso)",
};

// pesos: igual que to_char(…, 'FM999G999G999') de los disparadores.
igual("pesos: neto", pesos(10862967.78), "$10.862.968");
igual("pesos: con IVA", pesos(10862967.78 * 1.21), "$13.144.191");
igual("pesos: menos de mil", pesos(950), "$950");

// fechaAR: el día del pedido en hora de Argentina, no en UTC.
igual("fecha AR: pedido de la tarde", fechaAR("2026-09-21T14:41:36.942883+00:00"), "2026-09-21");
igual("fecha AR: pedido de las 22 (01:00 UTC del día siguiente)", fechaAR("2026-09-22T01:00:00+00:00"), "2026-09-21");
igual("fecha AR: vacío", fechaAR(null), "");

// modoDe: mismo criterio que la Prueba de plantillas.
igual("modo: expreso", modoDe({ nombre_expreso: "Arnes" }), "expreso");
igual("modo: sin expreso", modoDe({ nombre_expreso: null }), "propio");
igual("modo: retira por nombre", modoDe({ nombre_expreso: "Retira en depósito" }), "retira");
igual("modo: retira por fecha", modoDe({ nombre_expreso: "Arnes", retiro_fecha: "2026-10-02" }), "retira");

// avisoParaModo: la versión que le llega según cómo se entrega.
igual("programado → expreso", avisoParaModo("pedido_programado", "expreso"), "pedido_programado_expreso");
igual("programado retira → propio", avisoParaModo("pedido_programado_retira", "propio"), "pedido_programado");
igual("en viaje → retira", avisoParaModo("pedido_en_viaje", "retira"), "pedido_listo_retirar");
igual("listo retirar → expreso", avisoParaModo("pedido_listo_retirar", "expreso"), "pedido_en_viaje_expreso");
igual("entregado: expreso no", avisoParaModo("pedido_entregado", "expreso"), null);
igual("entregado: propio sí", avisoParaModo("pedido_entregado", "propio"), "pedido_entregado");
igual("recibido: todos", avisoParaModo("pedido_recibido", "retira"), "pedido_recibido");

// paramsAviso con el pedido real.
igual("recibido", paramsAviso("pedido_recibido", expreso),
  ["Torres Y Liva S.A Cif", "21/09", "$13.144.191 ($10.862.968 + IVA)", "contado", "martes 13/10 (te lo dejamos en el expreso)"]);
igual("programado expreso", paramsAviso("pedido_programado_expreso", expreso), ["21/09", "martes 29/09", "Arnes"]);
igual("reprogramado", paramsAviso("pedido_reprogramado", expreso), ["21/09", "jueves 01/10"]);
igual("en viaje expreso sin la palabra Expreso", paramsAviso("pedido_en_viaje_expreso", { ...expreso, expreso: "Expreso Arnes" }), ["21/09", "Arnes"]);
igual("factura: no es de seguimiento", paramsAviso("pedido_contado_s", expreso), null);
igual("modo en texto", modoTexto(expreso), "por Expreso Arnes");

// Sin fecha ni total no inventa datos.
const sin: DatosPedido = { ...expreso, salida: null, total_neto: null, metodo: null, estimada: null, modo: "retira" };
igual("programado retira sin fecha", paramsAviso("pedido_programado_retira", sin), ["21/09", "(sin fecha todavía)"]);
igual("listo retirar sin fecha", paramsAviso("pedido_listo_retirar", sin), ["21/09", "la fecha acordada"]);
igual("recibido sin total", paramsAviso("pedido_recibido", sin)?.slice(2), ["(sin total)", "a confirmar", "a confirmar"]);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
