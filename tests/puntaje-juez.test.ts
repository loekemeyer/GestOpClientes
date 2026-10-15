// Pruebas de lo que ve el juez de lk_ia-puntaje (supabase/functions/lk_ia-puntaje/juez.ts). Sin red, sin IA, sin base.
// Correr: deno run --allow-env --allow-read tests/puntaje-juez.test.ts   (sale con código 1 si algo falla)
//
// Problemas 818 y 819 de la auditoría (15/10/2026): el juez usaba la regla vieja de pedidos apagados (con wa_pedidos_config.activo = true
// marcaba como mala toda respuesta que tomaba un pedido) y leía la charla previa de wa_conversations, sin filas desde el 05/10.
import { armarCharlaPrevia, pedidosWaParaFila, sistema } from "../supabase/functions/lk_ia-puntaje/juez.ts";
import { REGLA_PEDIDOS_WA, REGLAS_OPERATIVAS } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── 818: las reglas que recibe el juez ──
const LINEA_APAGADO = "PEDIDOS: por ahora NO se toman pedidos por WhatsApp";
igual("con pedidos prendidos el juez recibe REGLA_PEDIDOS_WA y no la línea de «por ahora NO»",
  [sistema(true).includes(REGLA_PEDIDOS_WA), sistema(true).includes(LINEA_APAGADO)], [true, false]);
igual("con pedidos apagados el juez recibe la línea vieja y no REGLA_PEDIDOS_WA",
  [sistema(false).includes(LINEA_APAGADO), sistema(false).includes(REGLA_PEDIDOS_WA)], [true, false]);
igual("la línea de «por ahora NO» existe en REGLAS_OPERATIVAS (si se renombra, esta prueba avisa)", REGLAS_OPERATIVAS.includes(LINEA_APAGADO), true);
igual("el criterio «reglas» del propio juez ya no dice «no toma pedidos» cuando están prendidos",
  [sistema(true).includes("no toma pedidos por WhatsApp,"), sistema(false).includes("no toma pedidos por WhatsApp,")], [false, true]);
igual("pedidosWaParaFila: activo manda, el Simulador también cuenta salvo simulador = false",
  [pedidosWaParaFila({ activo: true }, false), pedidosWaParaFila({ activo: false }, false), pedidosWaParaFila({ activo: false }, true),
    pedidosWaParaFila({ activo: false, simulador: false }, true), pedidosWaParaFila(null, true)], [true, false, true, false, true]);

// ── 819: la charla previa ──
const t = (min: number) => new Date(Date.UTC(2026, 9, 14, 13, 0, 0) + min * 60_000).toISOString();
const H = (min: number, rol: string, contenido: string) => ({ rol, contenido, creado_en: t(min) });
const turno = [H(0, "user", "me van a entregar productos dañados?"), H(0.1, "assistant", "Disculpá el inconveniente. ¿Nos podés enviar una foto?"),
  H(1, "user", "ya lo estan armando?"), H(1.1, "assistant", "Su consulta por el reclamo ya fue pasada a una persona del equipo.")];
igual("la charla previa deja afuera el turno evaluado (su pregunta y su respuesta)",
  armarCharlaPrevia(turno, "ya lo estan armando?", t(1.1)),
  "Cliente: me van a entregar productos dañados?\nBot: Disculpá el inconveniente. ¿Nos podés enviar una foto?");
igual("sin mensajes anteriores dice «(sin charla previa)»", armarCharlaPrevia(turno.slice(2), "ya lo estan armando?", t(1.1)), "(sin charla previa)");
igual("sin filas dice «(sin charla previa)»", armarCharlaPrevia([], "hola", t(0)), "(sin charla previa)");
const largo = Array.from({ length: 12 }, (_, i) => H(i, i % 2 === 0 ? "user" : "assistant", `mensaje ${i}`)).concat([H(20, "user", "la pregunta"), H(20.1, "assistant", "la respuesta")]);
const previa = armarCharlaPrevia(largo, "la pregunta", t(20.1)).split("\n");
igual("muestra sólo los últimos 6 anteriores, del más viejo al más nuevo", [previa.length, previa[0], previa[5]], [6, "Cliente: mensaje 6", "Bot: mensaje 11"]);
igual("el mismo texto repetido corta en el más nuevo, no en el primero",
  armarCharlaPrevia([H(0, "user", "si"), H(0.1, "assistant", "uno"), H(5, "user", "si"), H(5.1, "assistant", "dos")], "si", t(5.1)), "Cliente: si\nBot: uno");
igual("compara ignorando saltos de línea y espacios de más",
  armarCharlaPrevia([H(0, "user", "hola"), H(0.1, "assistant", "r"), H(1, "user", "dame  el\n505"), H(1.1, "assistant", "x")], "dame el 505", t(1.1)), "Cliente: hola\nBot: r");
igual("si la pregunta no se encuentra usa lo anterior a un minuto antes del puntaje",
  armarCharlaPrevia([H(0, "user", "a"), H(0.1, "assistant", "b"), H(9.5, "user", "[ADJUNTO IMAGE] c"), H(9.6, "assistant", "d")], "otra cosa", t(10)),
  "Cliente: a\nBot: b");
igual("recorta cada mensaje a 500 caracteres", armarCharlaPrevia([H(0, "user", "x".repeat(900)), H(1, "user", "p")], "p", t(1)).length, "Cliente: ".length + 500);
igual("un contenido vacío no rompe", armarCharlaPrevia([{ rol: "assistant", contenido: null, creado_en: t(0) }, H(1, "user", "p")], "p", t(1)), "Bot: ");

// ── el index.ts usa lo corregido (guarda contra volver atrás) ──
const idx = Deno.readTextFileSync(new URL("../supabase/functions/lk_ia-puntaje/index.ts", import.meta.url));
igual("lk_ia-puntaje ya no lee wa_conversations ni pasa REGLAS_OPERATIVAS suelta",
  [/from\("wa_conversations"\)/.test(idx), /\$\{REGLAS_OPERATIVAS\}|system:\s*SISTEMA/.test(idx)], [false, false]);
igual("lk_ia-puntaje lee bot_historial_chat y wa_pedidos_cfg, y no evalúa si no puede leer la configuración",
  [idx.includes('from("bot_historial_chat")'), idx.includes('rpc("wa_pedidos_cfg")'), /errCfg \|\| cfgPedidos == null\) return json/.test(idx)], [true, true, true]);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
