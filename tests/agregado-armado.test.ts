// Pruebas de "agregar a un pedido ya en armado → se deriva a logística" (supabase/functions/_shared/agregado-armado.ts). Sin red, sin IA.
// Correr: deno run tests/agregado-armado.test.ts   (sale con código 1 si algo falla)
import { casoDeAgregado, textoClienteEnArmado, textoClienteEntregado, textoTareaEnArmado } from "../supabase/functions/_shared/agregado-armado.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── Qué se hace según el estado del pedido ──
igual("recibido, sin enviar a compras → se puede agregar", casoDeAgregado("recibido", false), "normal");
igual("programado → se puede agregar", casoDeAgregado("programado", false), "normal");
igual("en preparación → logística", casoDeAgregado("en preparacion", false), "en_armado");
igual("facturado → logística", casoDeAgregado("facturado", false), "en_armado");
igual("enviado a compras aunque el estado diga recibido → logística", casoDeAgregado("recibido", true), "en_armado");
igual("entregado → pedido nuevo", casoDeAgregado("entregado", false), "entregado");
igual("entregado y enviado a compras → pedido nuevo (no se deriva)", casoDeAgregado("entregado", true), "entregado");

// ── Textos ──
const uno = [{ cajas: 3, descripcion: "Pelador X", cod: "505" }];
const dos = [...uno, { cajas: 1, descripcion: "Abrelatas Y", cod: "501" }];
const cli = textoClienteEnArmado("25/09", "en preparacion", dos);
igual("cliente: nombra el pedido por su fecha y el estado", cli.startsWith("Tu pedido del 25/09 ya está en armado"), true);
igual("cliente: lista las dos filas con plural y singular", cli.includes("• 3 cajas de Pelador X (cód. 505)") && cli.includes("• 1 caja de Abrelatas Y (cód. 501)"), true);
igual("cliente: dice que se consultó a logística", /consulté a logística/.test(cli), true);
igual("cliente: no promete ni dice que no se puede", !/no se puede|no podemos|no le podemos|seguro|garantiz/i.test(cli), true);
igual("cliente: facturado se dice facturado", textoClienteEnArmado("25/09", "facturado", uno).startsWith("Tu pedido del 25/09 ya está facturado"), true);
igual("cliente: sin número de pedido ni cierre de cortesía", !/#|nro|n°|algo más/i.test(cli), true);

const tarea = textoTareaEnArmado("25/09", "facturado", dos);
igual("tarea: dice que pidió SUMAR y que no se aplica solo", tarea.includes("Pidió SUMAR al pedido del 25/09") && tarea.includes("no se aplica solo"), true);
igual("tarea: trae código y cajas de cada artículo", tarea.includes("3 cajas de Pelador X (cód. 505); 1 caja de Abrelatas Y (cód. 501)"), true);
igual("tarea: pide avisarle al cliente", /Avisarle por acá/.test(tarea), true);

const ent = textoClienteEntregado("25/09");
igual("entregado: pedido nuevo en la web", ent.includes("ya fue entregado") && ent.includes("Pedidos Mayorista"), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
