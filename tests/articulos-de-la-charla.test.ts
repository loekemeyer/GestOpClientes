// Pruebas del bloque «Artículos de esta charla» (_shared/articulo-en-curso.ts, auditoría 835, Pablo Olejavetzky, 16/10/2026): «y de los otros articulos que me ofreciste?» mezclaba los
// artículos de ayer con los de hoy. Funciones puras, sin red, sin IA, US$ 0. Reproduce la charla real de Logística (…1027) del 14 y 15/10.
// Correr: deno run tests/articulos-de-la-charla.test.ts   (sale con código 1 si algo falla)
import { articulosDeLaCharla, bloqueArticulosDeLaCharla, HORAS_CHARLA_ACTUAL, MAX_ARTICULOS_CHARLA, type FilaCharla } from "../supabase/functions/_shared/articulo-en-curso.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
function ok(nombre: string, cond: boolean) { igual(nombre, cond, true); }

const AHORA = new Date("2026-10-15T19:57:15Z");   // 16:57 de Argentina, 15/10
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString();
const fila = (rol: string, contenido: string, minAtras: number): FilaCharla => ({ rol, contenido, creado_en: hace(minAtras) });
const cods = (l: { cod: string }[]) => l.map((a) => a.cod);

// ── La charla real, del más nuevo al más viejo (como rawHistory). Ayer 14/10 12:25 y 12:06 hora de Argentina = 15:25 y 15:06 UTC. ──
const AYER_LISTA = fila("assistant",
  "Estos son los peladores disponibles (precio por caja con su descuento, + IVA):\n- *Pelador Mgo Metálico* (cód. 513): $25.650\n- *Pelador Mgo Acrílico* (cód. 589E): $33.264\n" +
  "- *Pelador Madera Multifunción* (cód. 599E): $32.292\n- *Pelador Negro Dentado* (cód. 598E): $13.392\n- *Pelador V Con Mgo Ergonómico* (cód. 816E): $32.562\n- *Pelador V Mgo Acacia* (cód. 993E): $42.606", 0);
AYER_LISTA.creado_en = "2026-10-14T15:25:00Z";
const AYER_PREGUNTA = fila("assistant", "Tenemos varios peladores. ¿A cuál te referís?\n- *Pelapapas Mgo Ergonómico* (cód. 586) — $17.172\n- *Pelador Mgo Plástico* (cód. 505) — $17.172", 0);
AYER_PREGUNTA.creado_en = "2026-10-14T15:06:00Z";
const HOY = [
  fila("assistant", "Tengo varios peladores con mango rojo:\n- *Pelapapas Mgo Ergonómico* (cód. 586): mango rojo.\n- *Pelador Mgo Plástico* (cód. 505): mango rojo.\n- *Pelador Metálico Corte Laser* (cód. 587): detalles en rojo.\nEl *Pelanaranjas* (cód. 569) también es rojo, pero es para naranjas.", 1.5),
  fila("user", "Tenes stock del pelapapas con mango rojo comun?", 1.7),
  fila("assistant", "Sus descuentos son: …", 4.5),
  fila("user", "Hay posibilidad de descuento si compro 100 cajas?", 5),
  fila("assistant", "Sí, el *Pelapapas Mgo Ergonómico* (cód. 586) tiene stock para las 30 cajas.", 5.5),
  fila("user", "Tenes stock para 30 cajas?", 5.7),
  fila("assistant", "[Aviso automático pedido_recibido · pedido 1692]\n¡Hola! Recibimos tu pedido por $117.973.", 190),
];
const HISTORIAL = [...HOY, AYER_LISTA, AYER_PREGUNTA];
const PREGUNTA = "y de los otros articulos que me ofreciste?";

// ── El caso real ──
const real = articulosDeLaCharla(HISTORIAL, PREGUNTA, AHORA);
igual("la charla de hoy: 586, 505, 587 y 569, en el orden en que se nombraron", cods(real), ["586", "505", "587", "569"]);
ok("ninguno de los seis de ayer entra a la lista", !cods(real).some((c) => ["513", "589E", "599E", "598E", "816E", "993E"].includes(c)));
igual("con nombre", real.map((a) => a.nombre), ["Pelapapas Mgo Ergonómico", "Pelador Mgo Plástico", "Pelador Metálico Corte Laser", "Pelanaranjas"]);

const bloque = bloqueArticulosDeLaCharla(HISTORIAL, PREGUNTA, AHORA);
ok("arma el bloque con su título", bloque.startsWith("## Artículos de esta charla"));
ok("lista los artículos con su código", bloque.includes("- Pelador Mgo Plástico (cód. 505)") && bloque.includes("- Pelador Metálico Corte Laser (cód. 587)"));
ok("no nombra los de ayer", !/513|589E|599E|598E|816E|993E/.test(bloque));
ok("dice qué hacer con «los otros» y con las herramientas", /«los otros», «los demás»/.test(bloque) && /usá las herramientas con cada código/.test(bloque));
ok("dice que lo que no está en la lista es de una charla anterior", /NO está en esta lista es de una charla anterior/.test(bloque));
ok("dice que si no queda claro, se pregunta", /preguntale a cuáles/.test(bloque));

// ── Cuándo NO se arma ──
igual("el mensaje trae un código: manda ese código", bloqueArticulosDeLaCharla(HISTORIAL, "y del 505 hay stock?", AHORA), "");
igual("con un solo artículo en la charla rige «Artículo en curso», no esta lista",
  bloqueArticulosDeLaCharla([fila("assistant", "*Pelapapas Mgo Ergonómico* (cód. 586) tiene stock disponible.", 2), fila("user", "Tenes stock del 586?", 3)], "y los otros?", AHORA), "");
igual("sin historial", bloqueArticulosDeLaCharla([], PREGUNTA, AHORA), "");
igual("el último mensaje tiene más de 12 h: no hay charla actual",
  articulosDeLaCharla([fila("assistant", "*A* (cód. 505) y *B* (cód. 586)", (HORAS_CHARLA_ACTUAL + 1) * 60)], PREGUNTA, AHORA), []);
const conHueco = [fila("assistant", "*Nuevo* (cód. 700)", 5), fila("assistant", "*Viejo* (cód. 800) y *Otro* (cód. 801)", 5 + HORAS_CHARLA_ACTUAL * 60 + 30)];
igual("un hueco de más de 12 h corta la charla: lo de antes del hueco no entra", cods(articulosDeLaCharla(conHueco, PREGUNTA, AHORA)), ["700"]);
igual("sin hueco (justo 11 h) todo es la misma charla",
  cods(articulosDeLaCharla([fila("assistant", "*Nuevo* (cód. 700)", 5), fila("assistant", "*Viejo* (cód. 800)", 5 + 11 * 60)], PREGUNTA, AHORA)), ["800", "700"]);

// ── Detalles ──
igual("el mensaje de ahora, ya guardado como primera fila, no cuenta", cods(articulosDeLaCharla([fila("user", "dame el 505", 0), ...HOY], "dame el 505", AHORA)), ["586", "505", "587", "569"]);
igual("el aviso automático de pedido no aporta artículos", cods(articulosDeLaCharla([fila("assistant", "[Aviso automático x]\n*Algo* (cód. 999)", 2)], PREGUNTA, AHORA)), []);
igual("un código dicho por el cliente sin nombre toma el nombre de una respuesta del bot",
  articulosDeLaCharla([fila("user", "y el 600?", 1), fila("assistant", "*Pelador Mgo Plástico* (cód. 505) tiene stock.", 2), fila("user", "tenes el 505?", 3)], PREGUNTA, AHORA),
  [{ cod: "505", nombre: "Pelador Mgo Plástico" }, { cod: "600", nombre: null }]);
igual("un número de pedido o un importe no es un artículo", cods(articulosDeLaCharla([fila("user", "cuándo llega el pedido 1692 por $117.973", 2), fila("assistant", "*A* (cód. 505)", 3)], PREGUNTA, AHORA)), ["505"]);
const muchos = Array.from({ length: 12 }, (_, i) => fila("assistant", `*Art ${i}* (cód. ${500 + i})`, 10 + i));   // del más nuevo (i=0) al más viejo (i=11)
igual(`tope de ${MAX_ARTICULOS_CHARLA}: quedan los más recientes, del más viejo al más nuevo`, cods(articulosDeLaCharla(muchos, PREGUNTA, AHORA)),
  ["509", "508", "507", "506", "505", "504", "503", "502", "501", "500"]);
// ── Una cantidad no es un código (el caso real: «compro 100 cajas» entraba a la lista como el cód. 100) ──
igual("«100 cajas» no es el código 100", cods(articulosDeLaCharla([fila("user", "Hay descuento si compro 100 cajas?", 2)], PREGUNTA, AHORA)), []);
igual("«200 unidades» tampoco, pero el código sí", cods(articulosDeLaCharla([fila("user", "necesito 200 unidades del 505", 2)], PREGUNTA, AHORA)), ["505"]);

// ── Guardas de código: la pieza está conectada, no sólo escrita ──
const fuente = await Deno.readTextFile(new URL("../supabase/functions/_shared/bot-conversation.ts", import.meta.url));
ok("bot-conversation importa bloqueArticulosDeLaCharla", /import \{[^}]*bloqueArticulosDeLaCharla[^}]*\} from "\.\/articulo-en-curso\.ts";/.test(fuente));
ok("el bloque se arma con el historial y el mensaje del turno", /const articulosCharla = bloqueArticulosDeLaCharla\(rawHistory, userText\);/.test(fuente));
ok("va en la parte VARIABLE del prompt, junto al artículo en curso", /\(articulo \? "\\n\\n" \+ articulo : ""\) \+ \(articulosCharla \? "\\n\\n" \+ articulosCharla : ""\)/.test(fuente));

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
