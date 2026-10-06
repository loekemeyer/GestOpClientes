// Pruebas de "agregar a un pedido ya en armado → se deriva a Ventas" (supabase/functions/_shared/agregado-armado.ts). Sin red, sin IA.
// Correr: deno run tests/agregado-armado.test.ts   (sale con código 1 si algo falla)
import { casoDeAgregado, firmaDeItems, textoClienteEnArmado, textoClienteEntregado, textoTareaEnArmado, yaHayAlertaIgual } from "../supabase/functions/_shared/agregado-armado.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── Qué se hace según el estado del pedido ──
igual("recibido, sin enviar a compras → se puede agregar", casoDeAgregado("recibido", false), "normal");
igual("programado → se puede agregar", casoDeAgregado("programado", false), "normal");
igual("en preparación → Ventas", casoDeAgregado("en preparacion", false), "en_armado");
igual("facturado → Ventas", casoDeAgregado("facturado", false), "en_armado");
igual("enviado a compras aunque el estado diga recibido → Ventas", casoDeAgregado("recibido", true), "en_armado");
igual("entregado → pedido nuevo", casoDeAgregado("entregado", false), "entregado");
igual("entregado y enviado a compras → pedido nuevo (no se deriva)", casoDeAgregado("entregado", true), "entregado");

// ── Textos ──
const uno = [{ cajas: 3, descripcion: "Pelador X", cod: "505" }];
const dos = [...uno, { cajas: 1, descripcion: "Abrelatas Y", cod: "501" }];
const cli = textoClienteEnArmado("25/09", "en preparacion", dos);
igual("cliente: nombra el pedido por su fecha y el estado", cli.startsWith("Tu pedido del 25/09 ya está en armado"), true);
igual("cliente: lista las dos filas con plural y singular", cli.includes("• 3 cajas de Pelador X (cód. 505)") && cli.includes("• 1 caja de Abrelatas Y (cód. 501)"), true);
igual("cliente: dice que se consultó a Ventas", /consulté a Ventas/.test(cli), true);
igual("cliente: no promete ni dice que no se puede", !/no se puede|no podemos|no le podemos|seguro|garantiz/i.test(cli), true);
igual("cliente: facturado se dice facturado", textoClienteEnArmado("25/09", "facturado", uno).startsWith("Tu pedido del 25/09 ya está facturado"), true);
igual("cliente: sin número de pedido ni cierre de cortesía", !/#|nro|n°|algo más/i.test(cli), true);

const tarea = textoTareaEnArmado("25/09", "facturado", dos);
igual("tarea: dice que pidió SUMAR y que no se aplica solo", tarea.includes("Pidió SUMAR al pedido del 25/09") && tarea.includes("no se aplica solo"), true);
igual("tarea: trae código y cajas de cada artículo", tarea.includes("3 cajas de Pelador X (cód. 505); 1 caja de Abrelatas Y (cód. 501)"), true);
igual("tarea: pide avisarle al cliente", /Avisarle por acá/.test(tarea), true);

const ent = textoClienteEntregado("25/09");
igual("entregado: pedido nuevo en la web", ent.includes("ya fue entregado") && ent.includes("Pedidos Mayorista"), true);

// ── Una sola alerta abierta por pedido y artículos ──
igual("firma: ordena por código", firmaDeItems([{ cod: "506", cajas: 1 }, { cod: "501", cajas: 2 }]), "501:2|506:1");
igual("firma: no depende del orden ni de mayúsculas", firmaDeItems([{ cod: "998e", cajas: 3 }, { cod: "501", cajas: 1 }]), firmaDeItems([{ cod: "501", cajas: 1 }, { cod: "998E", cajas: 3 }]));
igual("firma: suma las cajas del mismo código repetido", firmaDeItems([{ cod: "501", cajas: 1 }, { cod: "501", cajas: 1 }]), firmaDeItems([{ cod: "501", cajas: 2 }]));
const abierta = (over: Record<string, unknown> = {}) => ({ contexto: { motivo: "cambio_pedido", en_armado: true, pedido: 1581, items: [{ cod: "501", cajas: 2 }], ...over } });
const pedir = [{ cod: "501", cajas: 2 }];
igual("repetida: misma alerta abierta (el caso del simulador, dos llamadas)", yaHayAlertaIgual([abierta()], 1581, pedir), true);
igual("repetida: aunque el artículo venga con otras mayúsculas o el pedido como texto", yaHayAlertaIgual([abierta({ pedido: "1581" })], 1581, [{ cod: "501", cajas: 2 }]), true);
igual("no repetida: otro pedido", yaHayAlertaIgual([abierta()], 1600, pedir), false);
igual("no repetida: otras cajas", yaHayAlertaIgual([abierta()], 1581, [{ cod: "501", cajas: 3 }]), false);
igual("no repetida: otro artículo", yaHayAlertaIgual([abierta()], 1581, [{ cod: "506", cajas: 2 }]), false);
igual("no repetida: pide uno más además del que ya estaba", yaHayAlertaIgual([abierta()], 1581, [{ cod: "501", cajas: 2 }, { cod: "506", cajas: 1 }]), false);
igual("no repetida: sin alertas abiertas", yaHayAlertaIgual([], 1581, pedir), false);
igual("no repetida: la abierta es de otro motivo", yaHayAlertaIgual([abierta({ motivo: "pago" })], 1581, pedir), false);
igual("no repetida: la abierta no es de 'en armado' (la de Aplicar con stock)", yaHayAlertaIgual([abierta({ en_armado: undefined })], 1581, pedir), false);
igual("no repetida: alerta vieja sin 'items' (anterior a este cambio)", yaHayAlertaIgual([abierta({ items: undefined })], 1581, pedir), false);
igual("no repetida: contexto nulo", yaHayAlertaIgual([{ contexto: null }], 1581, pedir), false);
igual("repetida: alcanza con que UNA de varias abiertas coincida", yaHayAlertaIgual([abierta({ pedido: 7 }), abierta()], 1581, pedir), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
