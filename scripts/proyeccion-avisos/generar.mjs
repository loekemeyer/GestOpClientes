// Arma supabase/functions/_shared/proyeccion-datos.ts a partir de datos-base.json (resultado de consultas.sql).
// Uso: node scripts/proyeccion-avisos/generar.mjs      (desde la raíz del repo)
//
// Las reglas de "qué avisos dispara un pedido" copian a los disparadores reales (ver docs/ESTADO.md y sql/):
//   · pedido_recibido ........ trg_notify_order_created (orders.sheets_sent)
//   · pedido_programado_* .... trg_order_tracking_notify, cuando el pedido pasa a "programado" (según el modo de entrega)
//   · pedido_en_viaje /
//     pedido_en_viaje_expreso  wa_avisos_en_viaje_web (9 y 11 h del día de entrega) o, si no llegó a salir por ahí, el
//                              pase a "entregado" del trigger de tracking (expreso). Reparto además manda pedido_entregado.
//   · pedido_listo_retirar ... wa_avisos_retiro_web (retiro con pedido facturado)
//   · pedido_{contado|credito|echeq}_{s|p} ... lk_factura-check; pedido_recordatorio_descuento ... lk_recordatorio-descuento
import { readFileSync, writeFileSync } from "node:fs";

const base = JSON.parse(readFileSync(new URL("./datos-base.json", import.meta.url), "utf8"));
const SALIDA = new URL("../../supabase/functions/_shared/proyeccion-datos.ts", import.meta.url);

const MESES = base.meses.map((m) => m.id);
const CICLO = {
  reparto: ["pedido_recibido", "pedido_programado", "pedido_en_viaje", "pedido_entregado"],
  expreso: ["pedido_recibido", "pedido_programado_expreso", "pedido_en_viaje_expreso"],
  retira: ["pedido_recibido", "pedido_programado_retira", "pedido_listo_retirar"],
};
// Lo que dispara el pedido de punta a punta. Uno que quedó sin programar sólo cuenta su "recibido".
const completo = (modo, etapa) => (etapa === "recibido" ? CICLO[modo].slice(0, 1) : CICLO[modo]);
// Lo que ya salió según la etapa real: facturado de retiro ya mandó "listo para retirar"; el resto de la salida
// espera al día de entrega.
function yaSalio(modo, etapa) {
  const c = CICLO[modo];
  if (etapa === "entregado") return c;
  if (etapa === "facturado") return modo === "retira" ? c : c.slice(0, 2);
  if (etapa === "programado") return c.slice(0, 2);
  return c.slice(0, 1);
}

const ETIQUETA = {
  pedido_recibido: ["Pedido recibido", "Seguimiento del pedido"],
  pedido_programado: ["Programado · reparto", "Seguimiento del pedido"],
  pedido_programado_expreso: ["Programado · expreso", "Seguimiento del pedido"],
  pedido_programado_retira: ["Programado · retira", "Seguimiento del pedido"],
  pedido_en_viaje: ["Salió en el camión · reparto", "Seguimiento del pedido"],
  pedido_entregado: ["Entregado · reparto", "Seguimiento del pedido"],
  pedido_en_viaje_expreso: ["Entregado al expreso", "Seguimiento del pedido"],
  pedido_listo_retirar: ["Listo para retirar", "Seguimiento del pedido"],
  pedido_recordatorio_descuento: ["Recordatorio de descuento por vencer", "Recordatorio"],
};
const GRUPO_FACT = { contado: "contado", credito: "crédito", echeq: "e-cheq" };

const filas = new Map(); // id → { id, etiqueta, grupo, empresa, porMes }
function celda(id, mes) {
  if (!filas.has(id)) {
    const [etiqueta, grupo] = ETIQUETA[id] ?? [id, "Factura y pago"];
    filas.set(id, { id, etiqueta, grupo, empresa: id.endsWith("_chef") ? "chef" : "lk", porMes: {} });
  }
  const f = filas.get(id);
  return (f.porMes[mes] ??= { todos: 0, conTel: 0, falta: 0 });
}

// ── Pedidos web de LK ──────────────────────────────────────────────────────────────────────────────────────────
const pedidos = Object.fromEntries(MESES.map((m) => [m, {
  total: 0, conTel: 0, cancelados: base.cancelados[m] ?? 0,
  modo: { reparto: 0, expreso: 0, retira: 0 }, enCurso: 0, avisos: 0,
}]));
for (const r of base.pedidos) {
  const p = pedidos[r.mes];
  p.total += r.pedidos; p.conTel += r.conTel; p.modo[r.modo] += r.pedidos;
  if (r.etapa !== "entregado") p.enCurso += r.pedidos;
  const full = completo(r.modo, r.etapa), ya = yaSalio(r.modo, r.etapa);
  for (const id of full) {
    const c = celda(id, r.mes);
    c.todos += r.pedidos; c.conTel += r.conTel;
    if (!ya.includes(id)) c.falta += r.pedidos;
  }
  p.avisos += full.length * r.pedidos;
}

// El aviso de "recibido" sale al cargar el pedido, antes de que se cancele: los cancelados también lo recibieron.
// Su teléfono no se cruzó, así que van en la misma proporción que el resto del mes.
for (const m of MESES) {
  const p = pedidos[m];
  if (!p.cancelados) continue;
  const c = celda("pedido_recibido", m);
  c.todos += p.cancelados; c.conTel += Math.round(p.cancelados * p.conTel / p.total); p.avisos += p.cancelados;
}

// ── Facturas (lk_factura-check) ────────────────────────────────────────────────────────────────────────────────
for (const r of base.facturas) {
  for (const [sufijo, n] of [["s", r.s], ["p", r.p]]) {
    if (!n) continue;
    const id = `pedido_${r.grupo}_${sufijo}${r.empresa === "chef" ? "_chef" : ""}`;
    const c = celda(id, r.mes);
    const f = filas.get(id);
    f.etiqueta = `Factura ${GRUPO_FACT[r.grupo]} · ${sufijo === "s" ? "1 factura" : "varias facturas"}${r.empresa === "chef" ? " (Chef)" : ""}`;
    c.todos += n;
    if (r.conTel === null) { c.conTel = null; } else if (c.conTel !== null && r.conTel) c.conTel += n;
  }
}

// ── Recordatorio de descuento (lk_recordatorio-descuento) ──────────────────────────────────────────────────────
for (const r of base.recordatorios) {
  const c = celda("pedido_recordatorio_descuento", r.mes);
  c.todos += r.avisos;
  if (r.conTel) c.conTel += r.avisos;
}
// Las celdas que no tuvieron avisos ese mes quedan en cero para que la tabla no tenga huecos.
for (const f of filas.values()) for (const m of MESES) f.porMes[m] ??= { todos: 0, conTel: f.empresa === "chef" ? null : 0, falta: 0 };

// Orden: mayor a menor por avisos del total de los meses completos (que es lo que pesa en plata).
const completos = MESES.filter((m) => !base.meses.find((x) => x.id === m).parcial);
const peso = (f) => completos.reduce((s, m) => s + f.porMes[m].todos, 0);
const plantillas = [...filas.values()].sort((a, b) => peso(b) - peso(a));

// Totales por mes. "Con teléfono" no suma a Chef (su teléfono no se pudo cruzar).
const totales = Object.fromEntries(MESES.map((m) => {
  let todos = 0, conTel = 0, falta = 0;
  for (const f of plantillas) {
    const c = f.porMes[m];
    todos += c.todos; falta += c.falta;
    if (c.conTel !== null) conTel += c.conTel;
  }
  return [m, { todos, conTel, falta }];
}));

const notas = [
  "Cuenta lo que dispararían HOY los disparadores del sistema (registro del pedido, cambios de estado, retiro y salida de pedidos web, facturas y recordatorio de descuento) si todos los clientes tuvieran teléfono. \"Con teléfono\" cuenta sólo a los clientes que ya tienen un número en el ERP o en el bot; hoy, en cambio, el trigger sólo avisa a los agendados en el bot (2 clientes).",
  "Pedidos web de LK: cada pedido genera 4 avisos si es reparto (recibido, programado, salió en el camión y entregado) y 3 si es por expreso o retiro. Se descuentan los cancelados (salvo en el aviso de recibido, que salió antes de cancelarse), pero sólo están registrados desde septiembre: los meses anteriores pueden estar algo inflados. Es un tope: supone que todos los avisos de salida llegan a salir.",
  "Los pedidos todavía en curso (septiembre y octubre) se cuentan con su recorrido completo; la fila \"Aún sin salir\" dice cuántos de esos avisos todavía no salieron. Un pedido que quedó sin programar sólo cuenta su aviso de recibido.",
  "No incluye pedido_reprogramado: antes del 28/09 no se guardó el historial de cambios de fecha. En septiembre hubo al menos 10 reprogramaciones de pedidos diferidos, así que el número real es mayor a cero.",
  "Facturas: un mensaje por cliente, día y método de pago, con la regla de lk_factura-check (\"no decidido\" se suma a contado). Agosto más septiembre da 434 mensajes de LK; la simulación del 29/09 contó 431 para 31/07 al 28/09. Un cliente con dos direcciones el mismo día recibiría dos mensajes y acá cuenta uno, así que el número queda levemente por debajo.",
  "Recordatorio de descuento: un aviso 2 días hábiles antes de cada escalón (14, 30, 45 y 60 días de la factura) mientras la factura siga sin pagar. Los meses pasados se calculan con las fechas de pago reales. Usa la versión v5 (utilidad): si Meta la tomara como marketing, cada aviso pasaría de US$ 0,026 a US$ 0,0618.",
  "Costo: cada aviso a la tarifa de utilidad de Argentina (US$ 0,026). Según el cambio de Meta del 01/10 (a confirmar con la primera factura), la utilidad se cobra aunque la ventana de 24 h esté abierta; antes esos avisos salían gratis, así que para meses anteriores es el costo que tendrían hoy, no el que se habría pagado.",
  "Chef: sólo cuentan sus facturas (el seguimiento de pedidos es de LK) y no se pudo cruzar su teléfono, por eso no entra en \"Con teléfono\".",
  "Los pedidos de Gestión se guardan unas 4 semanas: para los pedidos anteriores al 07/09 se supone que ya terminaron su recorrido.",
];

const salida = {
  generado: base.generado,
  tarifa: { utility: 0.026, marketing: 0.0618 },
  meses: base.meses,
  pedidos,
  plantillas,
  totales,
  notas,
  ia: base.ia,
};

writeFileSync(SALIDA,
  `// GENERADO por scripts/proyeccion-avisos/generar.mjs a partir de scripts/proyeccion-avisos/datos-base.json. No editar a mano.\n` +
  `// Informe "Proyección de avisos y gasto" del dashboard (Informes). Sólo agregados: ningún dato de clientes.\n` +
  `// deno-lint-ignore-file\n` +
  `export const PROYECCION_DATOS = ${JSON.stringify(salida, null, 1)};\n`);

// Resumen para controlar a ojo.
for (const m of MESES) {
  const t = totales[m], p = pedidos[m];
  console.log(`${m}: pedidos ${p.total} (en curso ${p.enCurso}, cancelados ${p.cancelados}) · avisos ${t.todos} · con tel ${t.conTel} · sin salir ${t.falta}`);
}
console.log(`plantillas: ${plantillas.length} → ${SALIDA.pathname}`);
