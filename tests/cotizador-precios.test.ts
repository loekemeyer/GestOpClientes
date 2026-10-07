// Pruebas de la lectura de precios del cotizador y su comparación con la web (supabase/functions/_shared/cotizador-precios.ts): m41, "chequear los valores".
// Las filas replican el diseño de un cotizador real de Loekemeyer (hoja "Cotizador Loekemeyer", visto el 06/10): versión en la fila 1, "Total a Abonar" en H8/H9,
// encabezado en la fila 10 y un artículo por fila desde la 11. Sin red.
// Correr: node --experimental-strip-types --no-warnings tests/cotizador-precios.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import { compararConWeb, leerHojaCotizador, textoComparacion } from "../supabase/functions/_shared/cotizador-precios.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const V = ""; // celda vacía
const hoja = (articulos: unknown[][], total: unknown = 172695.6, version: unknown = "Septiembre 2025"): unknown[][] => [
  [V, version, V, V, V, V, V, V, V, V],
  [V, V, V, V, V, V, V, V, V, V],
  [V, "Elige Plazo de Pago", V, V, "Dto x Pago Contado", "Dto x Pago Transferencia/Deposito a:", V, V, "Dtos con Envio de Echeq ", V],
  [V, V, V, V, V, "15 - 30 días", "31- 45    días", "46- 60 días", "90 días", "120 días"],
  [V, V, V, V, -0.25, -0.2, -0.15, -0.1, -0.05, 0],
  [V, 'Elegir Forma de  Pago con "X"', V, V, "x", V, V, V, V, V],
  [V, V, V, V, V, V, V, V, V, V],
  [V, "Razon Social:", V, V, V, V, V, "Total a Abonar                        ", V, V],
  [V, "Domicilio Entrega:", V, V, V, V, V, total, V, V],
  [V, "Descripcion                           ", V, "Cod", "Pedido en Cajas", "Uni x Caja", "$ x Uni", "$ x Caja ", "Total $          x Cod", "Total Uni"],
  ...articulos,
];
//        [obs, descripción,                        _, cod,    cajas, uxb, $xUni,           $xCaja, total, uni]
const FILAS = hoja([
  [0, "Abrelatas A Manija", V, "501", V, 6, 5520, 33120, 0, 0],
  [1, "Abrelatas Mariposa Capuchon Rojo", V, "512", 5, 12, 1850, 22200, 111000, 60],
  [2, "Abrelatas Doble Engranaje ", V, "503E", 2, 12, 5165, 61980, 123960, 24],
  [2, "", V, V, V, V, V, V, V, V],
  [2, "Palo de amasar 40cm", V, "231", V, 12, "No Disponible", "No Disponible", 0, 0],
  [2, "Mate Inox Térmico", V, "255", 1, 4, 9060, 36240, 36240, 4],
]);
const cot = leerHojaCotizador(FILAS)!;

// ── Lectura ──
igual("versión de la fila 1", cot.version, "Septiembre 2025");
igual("total a abonar (H9)", cot.total, 172695.6);
igual("lee los artículos con código (salta la fila vacía)", cot.filas.map((f) => f.cod), ["501", "512", "503E", "231", "255"]);
igual("cajas pedidas", cot.filas.map((f) => f.cajas), [0, 5, 2, 0, 1]);
igual("precio por unidad y por caja de una fila", [cot.filas[1].pu, cot.filas[1].pc, cot.filas[1].uxb], [1850, 22200, 12]);
igual("'No Disponible' se marca y no tiene precio", [cot.filas[3].noDisponible, cot.filas[3].pu], [true, null]);
igual("una planilla sin el encabezado esperado no es un cotizador", leerHojaCotizador([["Cod", "Cantidad"], ["501", 3]]), null);
igual("sin 'Pedido en Cajas' tampoco", leerHojaCotizador([["Cod", "$ x Uni"], ["501", 5520]]), null);
igual("planilla vacía", leerHojaCotizador([]), null);
igual("versión con 'Setiembre' y total en texto con coma", [leerHojaCotizador(hoja([], "1.234,50", "Setiembre 2026"))?.version, leerHojaCotizador(hoja([], "1.234,50"))?.total], ["Setiembre 2026", 1234.5]);
igual("sin total: null", leerHojaCotizador(hoja([], null))?.total, null);

// ── Comparación (sólo los artículos PEDIDOS) ──
const WEB = {
  "501": { pu: 5520, uxb: 6, activo: true }, "512": { pu: 3840, uxb: 12, activo: true }, "503E": { pu: 5165, uxb: 12, activo: true },
  "231": { pu: 1790, uxb: 24, activo: true }, "255": { pu: 9060, uxb: 8, activo: true },
};
let r = compararConWeb(cot, WEB);
igual("pedidos: los de cajas > 0", r.pedidos.map((f) => f.cod), ["512", "503E", "255"]);
igual("diferencias: precio del 512 y unidades por caja del 255; el 503E coincide", r.diferencias.map((d) => [d.cod, d.tipo, d.cotizador, d.web]), [["512", "precio", 1850, 3840], ["255", "unidades_por_caja", 4, 8]]);
r = compararConWeb(cot, { ...WEB, "512": { pu: 1850, uxb: 12, activo: true }, "255": { pu: 9060, uxb: 4, activo: true } });
igual("todo coincide: sin diferencias", r.diferencias, []);
r = compararConWeb(cot, { ...WEB, "512": { pu: 1850.4, uxb: 12, activo: true }, "255": { pu: 9060, uxb: 4, activo: true } });
igual("menos de un peso de diferencia no cuenta", r.diferencias, []);
r = compararConWeb(cot, { ...WEB, "512": { pu: 1850, uxb: 12, activo: false }, "255": { pu: 9060, uxb: 4, activo: true } });
igual("artículo inactivo en la web", r.diferencias.map((d) => [d.cod, d.tipo]), [["512", "no_esta_en_la_web"]]);
const sinWeb: Record<string, never> = {};
igual("artículo que no existe en la web", compararConWeb(cot, sinWeb).diferencias.map((d) => d.tipo), ["no_esta_en_la_web", "no_esta_en_la_web", "no_esta_en_la_web"]);
const pedidoNoDisp = leerHojaCotizador(hoja([[2, "Palo de amasar 40cm", V, "231", 3, 12, "No Disponible", "No Disponible", 0, 0]]))!;
igual("lo pidió pero el cotizador dice 'No Disponible' y la web lo tiene", compararConWeb(pedidoNoDisp, WEB).diferencias.map((d) => [d.cod, d.tipo, d.web]), [["231", "no_disponible_en_el_cotizador", 1790]]);

// ── Cadena con lista de precios propia (m41, 07/10): no se compara el PRECIO, lo demás sí ──
const sinPrecio = { ignorarPrecio: true };
igual("cadena: el precio distinto del 512 no es diferencia; las unidades por caja del 255 sí",
  compararConWeb(cot, WEB, sinPrecio).diferencias.map((d) => [d.cod, d.tipo, d.cotizador, d.web]), [["255", "unidades_por_caja", 4, 8]]);
igual("cadena: con todo lo demás igual no hay diferencias (antes: falsa alarma de precio)",
  compararConWeb(cot, { ...WEB, "255": { pu: 9060, uxb: 4, activo: true } }, sinPrecio).diferencias, []);
igual("sin la opción se sigue marcando el precio (el comportamiento de siempre)",
  compararConWeb(cot, { ...WEB, "255": { pu: 9060, uxb: 4, activo: true } }, {}).diferencias.map((d) => [d.cod, d.tipo]), [["512", "precio"]]);
igual("cadena: 'no está en la web' se sigue avisando", compararConWeb(cot, sinWeb, sinPrecio).diferencias.map((d) => d.tipo), ["no_esta_en_la_web", "no_esta_en_la_web", "no_esta_en_la_web"]);
igual("cadena: 'No Disponible' con precio en la web se sigue avisando", compararConWeb(pedidoNoDisp, WEB, sinPrecio).diferencias.map((d) => [d.cod, d.tipo]), [["231", "no_disponible_en_el_cotizador"]]);
igual("cadena sin diferencias: el cliente no recibe ningún texto",
  textoComparacion(cot, compararConWeb(cot, { ...WEB, "255": { pu: 9060, uxb: 4, activo: true } }, sinPrecio).diferencias), "");

// Guarda sobre el código: los DOS llamadores (webhook y Simulador) pasan el código del cliente; sin él una cadena volvería a dar falsa alarma de precio.
const leer = (ruta: string) => readFileSync(new URL(ruta, import.meta.url), "utf8");
igual("el webhook pasa el código del cliente a la comparación", /compararCotizadorConWeb\(r\.hoja,\s*customer\.cod_cliente\)/.test(leer("../supabase/functions/lk_whatsapp-webhook/index.ts")), true);
igual("el Simulador pasa el código del cliente a la comparación", /compararCotizadorConWeb\(r\.hoja,\s*body\.cod_cliente/.test(leer("../supabase/functions/lk_bot-simular/index.ts")), true);
igual("la comparación consulta las cadenas con lista propia", /cadenasListaPropia\(\[codCliente\]\)/.test(leer("../supabase/functions/_shared/pedido-archivo.ts")), true);

// ── Texto para el cliente ──
const dif = compararConWeb(cot, { ...WEB, "255": { pu: 9060, uxb: 4, activo: true } });
igual("texto con una diferencia (el caso real de la prueba del 06/10)", textoComparacion(cot, dif.diferencias),
  "💰 Ojo, tu cotizador puede estar desactualizado: estos valores no coinciden con los de la web.\n" +
  "• Abrelatas Mariposa Capuchon Rojo (cód. 512): en tu cotizador $22.200 por caja; en la web $46.080 por caja.\n" +
  "Total que figura en tu cotizador: $172.695,60 (con sus precios).");
igual("no aclara cuáles SÍ coinciden", /coinciden con la web\.$|coincide con la web/m.test(textoComparacion(cot, dif.diferencias).replace("no coinciden con los de la web", "")), false);
const ok = compararConWeb(cot, { ...WEB, "512": { pu: 1850, uxb: 12, activo: true }, "255": { pu: 9060, uxb: 4, activo: true } });
igual("si todo coincide NO se le dice nada al cliente (Pablo, 06/10)", textoComparacion(cot, ok.diferencias), "");
const unico = leerHojaCotizador(hoja([[1, "Abrelatas Mariposa Capuchon Rojo", V, "512", 5, 12, 1850, 22200, 111000, 60], [2, "Abrelatas Doble Engranaje", V, "503E", 2, 12, 5165, 61980, 123960, 24]], null))!;
const d2 = compararConWeb(unico, { ...WEB, "512": { pu: 3840, uxb: 12, activo: true } });
igual("hay una diferencia (para que la prueba de abajo no sea vacía)", d2.diferencias.length, 1);
igual("sin total no inventa uno", /Total que figura/.test(textoComparacion(unico, d2.diferencias)), false);
igual("con 'No disponible en la web' el texto lo dice", /hoy no está disponible en la web/.test(textoComparacion(cot, compararConWeb(cot, sinWeb).diferencias)), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
