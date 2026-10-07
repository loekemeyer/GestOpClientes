// Cada mensaje de las correcciones del artifact debe disparar SOLO su detector de supabase/functions/_shared/faq.ts, no el de otra corrección (06/10:
// "deben llegar un ratito antes" de m60 lo atrapaba el detector de entrega rápida de m59). Sin red.
// Correr: deno run --allow-env tests/faq-detectores-cruzados.test.ts   (sale con código 1 si algo falla)
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const f = await import("../supabase/functions/_shared/faq.ts");

const detectores: Record<string, (t: string) => boolean> = {
  m66_devolver: f.quiereDevolver, m64_pagar_despues: f.pidePagarDespues, m63_pedido_mail: f.pedidoPorMailRepetido,
  m59_entrega_rapida: f.pideEntregaRapida, m62_pedido_fecha: f.pedidoParaFecha, m60_horario_recepcion: f.avisaHorarioRecepcion, m17_error_de_carga: f.avisaErrorDeCarga, m68_factura_por_mail: f.avisaFacturaPorMail, m77_pedido_por_web: f.pidePedidoPorWeb,
};
const casos: Array<[string, string | null]> = [
  ["Vamos a devolver unas cucharas que no pedimos, es el código 208 y son 48 unidades", "m66_devolver"],
  ["Hola, ¿se podrá efectuar el pago el próximo viernes?", "m64_pagar_despues"],
  ["Pasé por mail un pedido para un cliente pero me vino dos veces rechazado. ¿Te llegó a vos?", "m63_pedido_mail"],
  ["En el caso que se confirme, ¿hay posibilidades de entrega rápida?", "m59_entrega_rapida"],
  ["Paso un pedidito. ¿Puede estar para el viernes?", "m62_pedido_fecha"],
  ["Por favor recuerden que recibimos hasta las 14 hs, por lo que deben llegar un ratito antes", "m60_horario_recepcion"],
  ["Cargué todo por unidad y después lo edité por caja", "m17_error_de_carga"],
  ["Nos llegó al mail las facturas, ¿lo entregan hoy?", "m68_factura_por_mail"],
  ["¿Puedo hacer el pedido directo de la web? ¿Mismos precios, mismo todo?", "m77_pedido_por_web"],
  // Frases que no son de ninguna corrección: no tienen que disparar nada.
  ["¿Cuándo llega mi pedido?", null], ["Hola, buen día", null], ["Quiero hacer un pedido", null], ["¿Cuál es el pedido mínimo?", null],
  ["Ya pagué el viernes", null], ["Devolveme la llamada cuando puedas", null], ["Me facturaron el mismo pedido dos veces", null],
  ["Llegaron 59 aceiteras de 60, pido la NC", null], ["¿Qué plazo de entrega están manejando?", null], ["Los coladores vinieron todos rotos", null], ["Ya cargué el pedido en la web", null], ["Puse 10 cajas de abrelatas", null], ["¿Cuántas unidades trae la caja?", null],
];

let fallas = 0;
for (const [texto, esperado] of casos) {
  const disparan = Object.entries(detectores).filter(([, fn]) => fn(texto)).map(([k]) => k);
  const ok = esperado === null ? disparan.length === 0 : disparan.length === 1 && disparan[0] === esperado;
  if (ok) console.log(`ok   ${esperado ?? "ninguno"}: ${texto}`);
  else { fallas++; console.error(`FALLA "${texto}"\n   dispararon: ${JSON.stringify(disparan)}\n   esperado:   ${esperado ?? "ninguno"}`); }
}
if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
