// Importes de un pedido para el agente (supabase/functions/_shared/importes-pedido.ts). Pablo Olejavetzky, 14/10/2026: el total de orders es SIN IVA y la IA lo decía pelado.
// Ahora la IA dice lo mismo que el aviso automático de pedido recibido: «$152.719 ($126.214 + IVA)». Sin red.
// Correr: node --experimental-strip-types --no-warnings tests/importes-pedido.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import { detalleDePedido, importesDelTotal, NOTA_IMPORTES_POR_LINEA, pesos } from "../supabase/functions/_shared/importes-pedido.ts";
import { REGLAS_OPERATIVAS } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// El mismo texto que el aviso automático (plantillas-meta.ts: ejemplo "$11.430 ($9.446 + IVA)" y el real del 14/10 "$152.719 ($126.214 + IVA)").
igual("pedido real del 14/10", importesDelTotal(126214)?.total_para_el_cliente, "$152.719 ($126.214 + IVA)");
igual("ejemplo de la plantilla pedido_recibido", importesDelTotal(9446)?.total_para_el_cliente, "$11.430 ($9.446 + IVA)");
igual("ejemplo de aviso-pedido.ts", importesDelTotal(741048)?.total_para_el_cliente, "$896.668 ($741.048 + IVA)");
igual("numeric de la base llega como texto", importesDelTotal("10172430"), { total_sin_iva: 10172430, total_con_iva: 12308640, total_para_el_cliente: "$12.308.640 ($10.172.430 + IVA)" });
igual("con decimales redondea el neto y el total", importesDelTotal(741100.5), { total_sin_iva: 741101, total_con_iva: 896732, total_para_el_cliente: "$896.732 ($741.101 + IVA)" });
for (const raro of [0, -5, null, undefined, "", "abc", NaN]) igual(`sin total válido: ${String(raro)}`, importesDelTotal(raro), null);
igual("pesos: punto de miles y sin decimales", pesos(13144190.6), "$13.144.191");

// Detalle: el importe por línea sólo si está cargado, y nunca si no se puede saber cuál lo está.
const fila = (cod: string, line_total: number) => ({ cod, description: `art ${cod}`, cajas: 2, line_total, total_pedido: 741100.5, fecha: "2026-10-14", payment_method: "contado" });
const d1 = detalleDePedido([fila("505", 0), fila("586", 0)], [false, false]);
igual("sin importes cargados: ninguna línea trae importe (no se calcula a precio de lista)", d1.items.map((i) => "importe_linea_sin_iva_antes_de_descuentos" in i), [false, false]);
igual("el total del pedido va con IVA y el neto", d1.pedido.total_para_el_cliente, "$896.732 ($741.101 + IVA)");
const d2 = detalleDePedido([fila("505", 19080.4), fila("586", 0)], [true, false]);
igual("sólo la línea cargada trae importe, redondeado", d2.items.map((i) => (i as Record<string, unknown>).importe_linea_sin_iva_antes_de_descuentos ?? null), [19080, null]);
const d3 = detalleDePedido([fila("505", 19080), fila("586", 5000)], [true]);
igual("si no coinciden las posiciones no se muestra ningún importe por línea", d3.items.some((i) => "importe_linea_sin_iva_antes_de_descuentos" in i), false);
igual("la nota avisa que es sin IVA y antes de los descuentos", d2.nota === NOTA_IMPORTES_POR_LINEA && /SIN IVA y ANTES de los descuentos/.test(d2.nota), true);
igual("sin total válido, el pedido no inventa uno", Object.keys(detalleDePedido([{ ...fila("505", 0), total_pedido: null }], [false]).pedido).sort(), ["fecha", "payment_method"]);

// La regla del prompt: una sola línea, con el ejemplo del aviso, sin calcular el IVA y sin punto y coma.
const lineas = REGLAS_OPERATIVAS.split("\n").filter((l) => l.startsWith("- TOTAL DE UN PEDIDO"));
igual("hay una regla TOTAL DE UN PEDIDO de una sola línea", lineas.length, 1);
const regla = lineas[0] ?? "";
igual("pide total_para_el_cliente tal cual, con el ejemplo del aviso", /total_para_el_cliente tal cual/.test(regla) && regla.includes("«$152.719 ($126.214 + IVA)»"), true);
igual("dice que el total es SIN IVA y con descuentos, y que no calcule el IVA", /es SIN IVA y ya tiene los descuentos aplicados/.test(regla) && /no calcules el IVA vos/.test(regla), true);
igual("cubre las dos herramientas y los importes por línea", ["consultar_mis_pedidos", "consultar_detalle_pedido", "importe_linea_sin_iva_antes_de_descuentos"].every((x) => regla.includes(x)), true);
igual("no lleva punto y coma", regla.includes(";"), false);

// bot-conversation.ts: ya no pasa el total pelado y usa las funciones del módulo.
const conv = readFileSync(new URL("../supabase/functions/_shared/bot-conversation.ts", import.meta.url), "utf8");
igual("consultar_mis_pedidos saca el neto pelado y arma el total con IVA", /total: totalNeto, subtotal: subtotalLista/.test(conv) && /importesDelTotal\(totalNeto\)/.test(conv), true);
igual("consultar_detalle_pedido pasa por detalleParaIA (las dos ramas)", (conv.match(/detalleParaIA\(data as FilaDetallePedido\[\]/g) ?? []).length, 2);
igual("las descripciones de las dos herramientas hablan de total_para_el_cliente", (conv.match(/total_para_el_cliente: con IVA y el neto «\+ IVA», pasalo tal cual/g) ?? []).length, 2);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
