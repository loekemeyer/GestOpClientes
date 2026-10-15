// Pruebas de cuándo un mensaje sólo pregunta si HAY stock y no es un pedido (supabase/functions/_shared/consulta-disponibilidad.ts). Sin red, sin IA.
// Pablo Olejavetzky, 15/10/2026 (tanda de pruebas, mensajes 2 y 3): «Si quiero 30 cajas hay?» tardó 11,5 s y costó US$ 0,0974 (5 s de espera de ráfaga + Sonnet 4.6 fijo) por decir «30 cajas».
// Correr: node --experimental-strip-types --no-warnings tests/consulta-disponibilidad.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import { esConsultaDeDisponibilidad } from "../supabase/functions/_shared/consulta-disponibilidad.ts";
import { esTurnoDePedido } from "../supabase/functions/_shared/pedido-turno.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const AHORA = Date.parse("2026-10-15T15:00:00Z");
const sinHistorial: { rol: string; contenido: string; creado_en: string }[] = [];
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();

// ── Preguntas de disponibilidad: no son un pedido ──
const CONSULTAS = [
  "Si quiero 30 cajas hay?",                       // mensaje 3 de la tanda
  "Tiene stock del 586?",                          // mensaje 2
  "Hay 30 cajas del 505?",
  "Tienen stock para 50 cajas?",
  "Hay stock del 586?",
  "¿Queda stock del 505?",
  "Tienen disponible el 586?",
  "Necesito saber si hay 30 cajas del 505",
  "Quiero saber si tienen 20 cajas del 505",
  "Quisiera consultar si hay stock de 40 cajas del 586",
  "Si necesito 100 cajas del 505 tienen?",
  "Si me llevo 30 cajas hay?",
  "Hay stock de 12 unidades del 505?",
  "Disponibilidad de 30 cajas del 505?",
  "Tienen 200 docenas del 505?",
  "El 505 tiene 12 unidades por caja?",
];
for (const t of CONSULTAS) igual(`consulta de disponibilidad: ${t}`, esConsultaDeDisponibilidad(t), true);

// ── Pedidos (con verbo de pedir sin condicional) o mensajes sin pregunta de stock: siguen como antes ──
const NO_CONSULTAS = [
  "Quiero 30 cajas del 505",
  "Mandame 20 cajas del 586",
  "Tienen 30 cajas del 505? las quiero",
  "Hay stock? quiero 30 cajas del 505",
  "Hay stock del 505, mandame 10 cajas",
  "Necesito 30 cajas del 505, hay?",
  "Me llevo 30 cajas del 505 si hay",
  "Tienen stock? anotame 20 cajas del 586",
  "Hay 30 cajas del 505? Pasame un pedido",
  "Agregá 10 cajas del 505 si hay",
  "Si hay stock, quiero 30 cajas del 505",
  "Tienen el 505? cargame 20 cajas",
  "Hay stock del 505? Dame 5 cajas",
  "Hay stock del 505? Quiero hacer un pedido",
  "Tienen stock? Te paso la orden de compra",
  "Hay stock del 501? Quería comprar 10 cajas",
  "Quiero hacer un pedido",
  "Cuanto sale el 505?",
  "6 cajas de pelapapas 505, 1 caja abrelatas 501, lo retiro yo",
  "",
];
for (const t of NO_CONSULTAS) igual(`no es sólo una consulta: ${JSON.stringify(t)}`, esConsultaDeDisponibilidad(t), false);

// ── Lo que decide el modelo: la consulta ya no va a Sonnet, el pedido sí ──
for (const t of CONSULTAS) igual(`no va al modelo fijo (Sonnet): ${t}`, esTurnoDePedido(t, sinHistorial, AHORA), false);
for (const t of NO_CONSULTAS.filter((x) => /\d\s*(cajas?|unid)|pedido|cotizador|orden/i.test(x))) igual(`sigue en el modelo fijo: ${t}`, esTurnoDePedido(t, sinHistorial, AHORA), true);
const botEnPedido = [{ rol: "assistant", contenido: "Este es el resumen de tu pedido: … ¿Lo confirmás con un sí?", creado_en: hace(2) }];
igual("con un pedido en curso, una pregunta de stock sigue siendo del pedido", esTurnoDePedido("Hay 30 cajas del 505?", botEnPedido, AHORA), true);
const botCharla = [{ rol: "assistant", contenido: "El *Pelapapas Mgo Ergonomico* (cód. 586) tiene stock disponible.", creado_en: hace(1) }];
igual("después de una respuesta de stock, la consulta de cantidad no es de pedido", esTurnoDePedido("Si quiero 30 cajas hay?", botCharla, AHORA), false);

// ── Guarda sobre el código: el webhook sólo espera 5 s por «N cajas» si no es una consulta, y pedido-turno usa lo mismo ──
const hook = readFileSync(new URL("../supabase/functions/lk_whatsapp-webhook/index.ts", import.meta.url), "utf8");
igual("el webhook importa esConsultaDeDisponibilidad", hook.includes('import { esConsultaDeDisponibilidad } from "../_shared/consulta-disponibilidad.ts";'), true);
igual("el webhook no espera por una consulta, pero sí con ráfaga o pedido en curso",
  hook.includes("if (visto && (rafaga || (RE_ITEMS.test(text) && !esConsultaDeDisponibilidad(text)) || await enCursoLazy())) {"), true);
const turno = readFileSync(new URL("../supabase/functions/_shared/pedido-turno.ts", import.meta.url), "utf8");
igual("pedido-turno.ts excluye la consulta pero conserva el pedido en curso",
  turno.includes("return (RE_CLIENTE_PIDE.test(textoCliente) && !esConsultaDeDisponibilidad(textoCliente)) || ultimoDelBotEsDePedido(historial, ahora);"), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
