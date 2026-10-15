// Pruebas de _shared/compuerta-stock.ts (auditoría 834, Pablo Olejavetzky, 15/10/2026): el agente afirmaba stock repitiendo su respuesta anterior, sin llamar a
// consultar_stock. Funciones puras, sin red, sin IA, US$ 0. Usa los textos reales de la charla de Logística (…1027) del 15/10.
// Correr: deno run tests/compuerta-stock.test.ts   (sale con código 1 si algo falla)
import { afirmaStock, debeForzarStock, llamadasDeStock, MAX_ARTICULOS_COMPUERTA } from "../supabase/functions/_shared/compuerta-stock.ts";
import type { FilaCharla } from "../supabase/functions/_shared/articulo-en-curso.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
function ok(nombre: string, cond: boolean) { igual(nombre, cond, true); }

const AHORA = new Date("2026-10-15T19:58:00Z");
const hh = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString();
const fila = (rol: string, contenido: string, minAtras: number): FilaCharla => ({ rol, contenido, creado_en: hh(minAtras) });

// ── Lo que debe saltar: afirmar o negar stock ──
const RESPUESTA_REAL = "Sí, el *Pelapapas Mgo Ergonómico* (cód. 586) tiene stock para las 30 cajas.";   // puntaje 74, sin herramientas
ok("la respuesta real sin herramienta (puntaje 74)", afirmaStock(RESPUESTA_REAL));
ok("«no tiene stock disponible»", afirmaStock("El *Pelador Mgo Plástico* (cód. 505) no tiene stock disponible en este momento."));
ok("«no hay stock»", afirmaStock("No hay stock del 505."));
ok("«tenemos stock»", afirmaStock("Tenemos stock de todos los que pidió."));
ok("«hay poco stock» (hasta tres palabras en el medio)", afirmaStock("Hay muy poco stock de ese."));
ok("«sin stock»", afirmaStock("Ese artículo está sin stock."));
ok("«stock limitado»", afirmaStock("El 505 tiene stock limitado."));
ok("el verbo con tilde: «tenés stock»", afirmaStock("Sí, tenés stock del 586."));
ok("la afirmación en la segunda frase", afirmaStock("Hola. El 586 tiene stock para esa cantidad."));

// ── Lo que NO debe saltar ──
igual("la repregunta vieja: «le confirmo si hay stock» es condicional", afirmaStock("Páseme el código o el nombre y le confirmo si hay stock para las 30 cajas."), false);
igual("«si tiene stock» es condicional", afirmaStock("Le aviso si tiene stock en los próximos días."), false);
igual("la respuesta real del puntaje 73: ofrece verificar", afirmaStock("¿Cuál de estos es el que busca? Si me confirma el código, le verifico el stock."), false);
igual("una pregunta al cliente no afirma nada", afirmaStock("¿Querés que revise si tienen stock?"), false);
igual("«cuando haya stock» no afirma", afirmaStock("Te aviso cuando haya stock."), false);
igual("la lista de precios del puntaje 75 no habla de stock", afirmaStock("Los otros peladores son:\n- *Pelador Mgo Plástico* (cód. 505): $17.172 por caja + IVA\n- *Pelador Metálico Corte Laser* (cód. 587): $19.332 por caja + IVA"), false);
igual("el texto sin stock de nada", afirmaStock("Tu pedido del 15/10 va a estar listo para retirar el martes 20/10."), false);
igual("vacío", afirmaStock(""), false);

// ── Qué se consulta: el caso real (puntaje 74) ──
const H_74 = [
  fila("user", "Del ergonomico, de ese tenes 30 cajas?", 0),
  fila("assistant", "Tengo varios peladores con mango rojo que podrían ser el que busca:\n- *Pelapapas Mgo Ergonómico* (cód. 586)\n- *Pelador Mgo Plástico* (cód. 505)", 0.5),
  fila("user", "Tenes stock del pelapapas con mango rojo comun?", 0.6),
];
igual("puntaje 74: el código sale de la respuesta y las 30 cajas de lo que escribió el cliente",
  llamadasDeStock(RESPUESTA_REAL, "Del ergonomico, de ese tenes 30 cajas?", H_74, AHORA), [{ cod: "586", cajas: 30 }]);

// ── Variantes de dónde sale el artículo ──
igual("sin código en la respuesta: el que escribió el cliente",
  llamadasDeStock("Sí, hay stock.", "Tenes stock del 586 para 20 cajas?", [], AHORA), [{ cod: "586", cajas: 20 }]);
const H_CURSO = [fila("user", "y para 30 cajas?", 0), fila("assistant", "*Pelapapas Mgo Ergonómico* (cód. 586) tiene stock disponible.", 1), fila("user", "Tenes stock del 586?", 1.2)];
igual("sin código en la respuesta ni en el mensaje: el artículo en curso de la charla",
  llamadasDeStock("Sí, tenemos stock.", "y para 30 cajas?", H_CURSO, AHORA), [{ cod: "586", cajas: 30 }]);
igual("cajas inventadas por el modelo: no se pasan (el cliente no las escribió)",
  llamadasDeStock("*Pelapapas Mgo Ergonómico* (cód. 586) tiene stock para las 2 cajas.", "Tenes stock del 586?", [], AHORA), [{ cod: "586" }]);
igual("no se sabe de qué artículo habla: no se inventa uno",
  llamadasDeStock("Sí, tenemos stock.", "tenes stock?", [], AHORA), []);
igual("una lista de artículos en la charla: ambiguo, no se inventa uno",
  llamadasDeStock("Sí, tenemos stock.", "y de esos tenes?", [fila("assistant", "cód. 505 · Pelador: $17.172\ncód. 586 · Pelapapas: $17.172", 1)], AHORA), []);
igual("los códigos repetidos se consultan una sola vez",
  llamadasDeStock("(cód. 586) tiene stock. Insisto: el cód. 586 tiene stock.", "hay?", [], AHORA), [{ cod: "586" }]);
const seis = "cód. 505, cód. 586, cód. 587, cód. 513, cód. 598E, cód. 816E tienen stock.";
igual(`tope de ${MAX_ARTICULOS_COMPUERTA} artículos por turno`, llamadasDeStock(seis, "hay?", [], AHORA).map((l) => l.cod), ["505", "586", "587", "513"]);
igual("«N cajas» sólo cuenta con cifra: «una caja» no se infiere", llamadasDeStock("(cód. 586) tiene stock para una caja.", "una caja del 586?", [], AHORA), [{ cod: "586" }]);

// ── Cuándo se fuerza ──
ok("afirma stock, sin herramienta, fuera de un pedido: se fuerza", debeForzarStock(RESPUESTA_REAL, [], false));
ok("con otras herramientas pero no consultar_stock: se fuerza", debeForzarStock(RESPUESTA_REAL, ["buscar_productos"], false));
igual("si ya llamó a consultar_stock: no se fuerza", debeForzarStock(RESPUESTA_REAL, ["buscar_productos", "consultar_stock"], false), false);
igual("en un turno de pedido: no se toca", debeForzarStock(RESPUESTA_REAL, [], true), false);
igual("una respuesta que no habla de stock: no se fuerza", debeForzarStock("Tu pedido está programado.", [], false), false);

// ── Guardas de código: la pieza está conectada, no sólo escrita ──
const fuente = await Deno.readTextFile(new URL("../supabase/functions/_shared/bot-conversation.ts", import.meta.url));
ok("bot-conversation importa la compuerta", /import \{ debeForzarStock, llamadasDeStock \} from "\.\/compuerta-stock\.ts";/.test(fuente));
ok("una sola vez por turno", /let compuertaStockUsada = false;/.test(fuente) && /!toolCalls\.length && !compuertaStockUsada/.test(fuente));
ok("las llamadas forzadas se arman como llamadas de consultar_stock y llevan la marca _compuerta", /name: "consultar_stock", input: \{ \.\.\.l, _compuerta: true \}/.test(fuente));
ok("el bucle ejecuta toolCalls (las del modelo o las forzadas), no res.toolCalls", /for \(const tc of toolCalls\)/.test(fuente) && !/for \(const tc of res\.toolCalls\)/.test(fuente));
ok("la rama final mira toolCalls, no res.toolCalls", /if \(!toolCalls\.length\) \{\s*registrarUsos\(\);/.test(fuente));
ok("el borrador forzado se descarta del historial y sin bloques de pensamiento", /text: forzada \? "" : res\.text/.test(fuente) && /!forzada && res\.bloques/.test(fuente));
ok("no corre en la toma de pedidos", /const enPedidoCompuerta = turnoPedido \|\| usadas\.some/.test(fuente));
ok("executeTool ignora la marca: sólo lee cod y cajas", /const cod = String\(input\.cod \?\? ""\)\.trim\(\);/.test(fuente) && !/input\._compuerta/.test(fuente));
const reglas = await Deno.readTextFile(new URL("../supabase/functions/_shared/agente-fijos.ts", import.meta.url));
ok("la regla STOCK pide volver a consultar aunque ya lo haya dicho", /volvé a consultarlo en cada pregunta de stock, no repitas tu respuesta anterior/.test(reglas));

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
