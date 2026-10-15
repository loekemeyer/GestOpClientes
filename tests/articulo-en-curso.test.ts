// Pruebas de _shared/articulo-en-curso.ts (auditoría 828, Pablo Olejavetzky, 15/10/2026): el agente repreguntaba el artículo ya nombrado y mandaba cajas inventadas a
// consultar_stock. Funciones puras: sin red, sin IA, US$ 0. Reproduce la charla real de Logística (…1027) del 15/10 16:28.
// Correr: deno run tests/articulo-en-curso.test.ts   (sale con código 1 si algo falla)
import { articuloEnCurso, cajasRespaldadas, numerosDelTexto, type FilaCharla } from "../supabase/functions/_shared/articulo-en-curso.ts";

let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const AHORA = new Date("2026-10-15T19:30:00Z");   // 16:30 de Argentina
const hh = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString();
const fila = (rol: string, contenido: string, minAtras: number): FilaCharla => ({ rol, contenido, creado_en: hh(minAtras) });

// La charla real, del más nuevo al más viejo (como rawHistory). Cada llamada arma la que corresponde al turno.
const AVISO = fila("assistant", "[Aviso automático pedido_recibido · pedido 1692]\n¡Hola! Recibimos tu pedido del 15/10 por $117.973 ($97.498 + IVA).", 130);
const T1_U = fila("user", "Tenes stock del 586?", 2);
const T1_B = fila("assistant", "¡Hola!\n\n*Pelapapas Mgo Ergonomico* (cód. 586) tiene stock disponible para las 2 cajas.", 2);
const T2_U = fila("user", "Tenes stock para 30 cajas?", 1.5);
const T2_B = fila("assistant", "¿Qué artículo le interesa? Páseme el código o el nombre y le confirmo si hay stock para las 30 cajas.", 1.5);
const T3_U = fila("user", "Del art que te pregunte antes", 1);

// ── Turno 2 de la charla real: «Tenes stock para 30 cajas?» ──
const t2 = articuloEnCurso([T2_U, T1_B, T1_U, AVISO], "Tenes stock para 30 cajas?", AHORA);
ok("turno 2: arma el bloque", t2.startsWith("## Artículo en curso"));
ok("turno 2: nombra el 586 con su nombre", t2.includes("Pelapapas Mgo Ergonomico (cód. 586)"));
ok("turno 2: dice que no pregunte de qué artículo", /No le preguntes «¿de qué artículo\?»/.test(t2));
ok("turno 2: limita el uso a consultas, no a armar pedidos", /Vale para CONSULTAS/.test(t2) && /PEDIDO SIN ERRORES/.test(t2));
ok("turno 2: dice hace cuánto fue", /de hace 2 min\./.test(t2));

// ── Turno 3: «Del art que te pregunte antes», con la repregunta del bot en el medio (sin código) ──
const t3 = articuloEnCurso([T3_U, T2_B, T2_U, T1_B, T1_U, AVISO], "Del art que te pregunte antes", AHORA);
ok("turno 3: la repregunta sin código se saltea y sigue en el 586", t3.includes("(cód. 586)"));

// ── El mensaje de ahora puede venir ya guardado como primera fila: no cuenta como "lo anterior" ──
igual("el mensaje de ahora no se toma como artículo previo", articuloEnCurso([fila("user", "y el 505?", 0)], "y el 505?", AHORA), "");

// ── Cuándo NO se arma ──
igual("el mensaje ya trae un código: nada que suplir", articuloEnCurso([T1_B, T1_U], "y del 505 hay?", AHORA), "");
igual("el mensaje trae un código con letra (938E)", articuloEnCurso([T1_B, T1_U], "hay stock del 938E?", AHORA), "");
igual("sin historial", articuloEnCurso([], "tenes stock para 30 cajas?", AHORA), "");
igual("sólo el aviso automático del pedido: no es un artículo", articuloEnCurso([AVISO], "tenes stock para 30 cajas?", AHORA), "");
const lista = fila("assistant", "Estos son los peladores:\ncód. 505 · Pelador Mgo Plástico: $17.554 por caja + IVA\ncód. 586 · Pelapapas Mgo Ergonomico: $18.100 por caja + IVA", 3);
igual("el último mensaje con artículos es una lista de varios: ambiguo, no se arma", articuloEnCurso([lista, fila("user", "precio de los peladores", 4)], "y stock?", AHORA), "");
igual("más de 3 horas: no se arma", articuloEnCurso([fila("assistant", "*Pelapapas Mgo Ergonomico* (cód. 586) tiene stock disponible.", 200)], "y para 30 cajas?", AHORA), "");
ok("justo dentro de las 3 horas: sí", articuloEnCurso([fila("assistant", "*Pelapapas Mgo Ergonomico* (cód. 586) tiene stock disponible.", 170)], "y para 30 cajas?", AHORA).includes("cód. 586"));

// ── Cuál gana, y de dónde sale el nombre ──
const otro = articuloEnCurso([fila("assistant", "*Pelador Mgo Plástico* (cód. 505) tiene stock disponible.", 1), fila("user", "y del 505?", 1.2), T1_B, T1_U], "y para 20 cajas?", AHORA);
ok("gana el artículo más reciente (505 sobre 586)", otro.includes("(cód. 505)") && !otro.includes("586"));
const soloCliente = articuloEnCurso([fila("assistant", "En este momento no tenemos disponible ese artículo.", 1), fila("user", "Tenes stock del 586?", 1.2)], "y cuándo entra?", AHORA);
ok("si sólo lo dijo el cliente por código, sale como «el cód. 586»", soloCliente.includes("el cód. 586,") && !soloCliente.includes("undefined"));
const nombreAtras = articuloEnCurso([fila("user", "Tenes stock del 586?", 1), fila("assistant", "*Pelapapas Mgo Ergonomico* (cód. 586) tiene stock disponible.", 5)], "y para 30 cajas?", AHORA);
ok("el nombre se recupera de una respuesta del bot sobre el mismo código", nombreAtras.includes("Pelapapas Mgo Ergonomico (cód. 586)"));

// ── Lo que NO es un artículo ──
igual("un importe en el aviso del bot no es un código", articuloEnCurso([fila("assistant", "Tu pedido es por $117.973 ($97.498 + IVA).", 1)], "y cuándo llega?", AHORA), "");
igual("el cliente dice «pedido 1692»: es un pedido, no un artículo", articuloEnCurso([fila("user", "cuándo llega el pedido 1692", 1)], "y para cuándo?", AHORA), "");
igual("un año no es un código", articuloEnCurso([fila("user", "lo pedí en 2026", 1)], "y stock?", AHORA), "");

// ── Cajas: sólo las que el cliente escribió ──
const U1 = fila("user", "Tenes stock del 586?", 2);
igual("el caso real: cajas=2 en «Tenes stock del 586?» se ignora", cajasRespaldadas(2, "Tenes stock del 586?", [U1]), null);
igual("«Tenes stock para 30 cajas?» respalda 30", cajasRespaldadas(30, "Tenes stock para 30 cajas?", []), 30);
igual("30 cajas dichas en un mensaje anterior siguen valiendo", cajasRespaldadas(30, "y del 505 hay?", [fila("user", "y del 505 hay?", 0), fila("user", "quiero 30 cajas del 586", 2)]), 30);
igual("más de 4 mensajes atrás ya no vale", cajasRespaldadas(30, "y del 505?", [
  fila("user", "y del 505?", 0), fila("user", "a", 1), fila("user", "b", 2), fila("user", "c", 3), fila("user", "d", 4), fila("user", "quiero 30 cajas", 5)]), null);
igual("un número que sólo dijo el bot no vale (se auto-validaría)", cajasRespaldadas(2, "y del 505?", [fila("assistant", "tiene stock para las 2 cajas", 1)]), null);
igual("en letras: treinta cajas", cajasRespaldadas(30, "tenes stock para treinta cajas?", []), 30);
igual("en letras: treinta y cinco cajas", cajasRespaldadas(35, "treinta y cinco cajas hay?", []), 35);
igual("en letras: una caja", cajasRespaldadas(1, "hay una caja del 505?", []), 1);
igual("con punto de miles: 1.000 cajas", cajasRespaldadas(1000, "hay 1.000 cajas?", []), 1000);
igual("habló en unidades: el agente convirtió a cajas y no se puede comprobar, se deja pasar", cajasRespaldadas(17, "necesito 200 unidades del 505", []), 17);
igual("habló en docenas: se deja pasar", cajasRespaldadas(17, "200 docenas del 505", []), 17);
igual("cajas 0 o vacío: null", [cajasRespaldadas(0, "30 cajas", []), cajasRespaldadas(undefined, "30 cajas", []), cajasRespaldadas("x", "30 cajas", [])], [null, null, null]);
igual("cajas como texto «30» (la API a veces manda string)", cajasRespaldadas("30", "30 cajas", []), 30);
ok("numerosDelTexto: cifras y letras", (() => { const s = numerosDelTexto("quiero 12 y dos más, cuarenta y tres cajas"); return s.has(12) && s.has(2) && s.has(43) && s.has(40); })());

// ── Guardas de código: la pieza está conectada, no sólo escrita ──
const fuente = await Deno.readTextFile(new URL("../supabase/functions/_shared/bot-conversation.ts", import.meta.url));
ok("bot-conversation importa articuloEnCurso y cajasRespaldadas", /import \{ articuloEnCurso, cajasRespaldadas \} from "\.\/articulo-en-curso\.ts"/.test(fuente));
ok("el bloque va en la parte VARIABLE del prompt (no rompe el caché de la base)", /const promptVariable = notaDeTiempo\(rawHistory, userText\)[^;]*\(articulo \? "\\n\\n" \+ articulo : ""\)/s.test(fuente));
ok("consultar_stock usa cajasRespaldadas con el texto y el historial del turno", /const cajas = cajasRespaldadas\(input\.cajas, ctx\.userText, ctx\.historial\);/.test(fuente));
ok("la herramienta ya no admite «si las dijo» a secas: pide no inventar el número", /NO mandes este campo: no pongas 1, 2 ni ningún número por tu cuenta/.test(fuente));
ok("la descripción de consultar_stock remite al artículo en curso", /bloque \\"Artículo en curso\\"/.test(fuente));

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
