// Pruebas de la memoria de la charla anterior (supabase/functions/_shared/ventana-historial.ts, historialParaElModelo). Sin red, sin IA.
// Pablo Olejavetzky, 08/10/2026 (pedido de gerencia): el agente ve la charla anterior completa, anclada a su inicio y con tope de 8.750
// caracteres (~2.500 tokens) y 60 mensajes; cada tramo de otra charla lleva una marca de fecha. Medido el 08/10 sobre bot_historial_chat
// (datos de prueba, 120 charlas de 34 teléfonos): 86 de 120 charlas tienen 15 mensajes o menos y ya entraban en la ventana.
// Correr: deno run --allow-env tests/memoria-charla.test.ts   (sale con código 1 si algo falla)
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { historialParaElModelo, marcaDeTramo, sinMarcaDeTramo, TOPE_ANTERIOR_CARACTERES, TOPE_ANTERIOR_MENSAJES, largoVentana } =
  await import("../supabase/functions/_shared/ventana-historial.ts");
const { cuerpoAnthropic } = await import("../supabase/functions/_shared/bot-llm.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

type Fila = { rol: string; contenido: string; creado_en: string };
/** Una charla de `n` mensajes alternados (cliente primero) que arranca `dia` (08 = hoy) a las 12 UTC, uno por minuto. */
function charla(dia: number, n: number, etiqueta: string, largo = 10, desdeBot = false): Fila[] {
  return Array.from({ length: n }, (_, i) => ({
    rol: (i % 2 === 0) !== desdeBot ? "user" : "assistant",
    contenido: `${etiqueta}${i}`.padEnd(largo, "."),
    creado_en: new Date(Date.UTC(2026, 9, dia, 12, i)).toISOString(),
  }));
}
/** Como lo lee bot-conversation: del más nuevo al más viejo, con el total. */
const modelo = (viejasPrimero: Fila[]) => historialParaElModelo([...viejasPrimero].reverse(), viejasPrimero.length);
const textos = (r: { filas: Fila[] }) => r.filas.map((f) => f.contenido.replace(/\.+$/, ""));

// ── Una sola charla: igual que antes, sin marcas ──────────────────────────────────────────────────────────────────────────────────
const sola = modelo(charla(8, 21, "h"));
igual("una charla: la ventana anclada (21 mensajes)", sola.filas.length, largoVentana(21));
igual("una charla: sin marcas", sola.marcas, []);
igual("una charla: nada agregado", sola.agregadas, 0);

// ── Charla anterior corta: ya entraba en la ventana; sólo se agregan las marcas ──────────────────────────────────────────────────
const corta = modelo([...charla(7, 6, "a"), ...charla(8, 3, "h")]);
igual("anterior corta: todo seguido", textos(corta), ["a0", "a1", "a2", "a3", "a4", "a5", "h0", "h1", "h2"]);
igual("anterior corta: marca al principio y donde empieza hoy", corta.marcas, [0, 6]);
igual("anterior corta: nada agregado (la ventana ya la traía)", corta.agregadas, 0);

// ── Charla anterior más larga que la ventana: entra completa desde su inicio ─────────────────────────────────────────────────────
const larga = modelo([...charla(5, 10, "v"), ...charla(7, 30, "a"), ...charla(8, 1, "h")]);
igual("anterior de 30: entra entera (30 + 1 de hoy)", larga.filas.length, 31);
igual("anterior de 30: arranca en su primer mensaje", textos(larga)[0], "a0");
igual("anterior de 30: no trae la charla de antes", textos(larga).some((t) => t.startsWith("v")), false);
igual("anterior de 30: marcas en su inicio y en el mensaje de hoy", larga.marcas, [0, 30]);
igual("anterior de 30: 14 agregadas (la ventana de 41 traía las últimas 17)", larga.agregadas, 31 - largoVentana(41));

// ── Topes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const porCaracteres = modelo([...charla(7, 40, "a", 300), ...charla(8, 1, "h")]);
const anteriorKept = porCaracteres.filas.filter((f) => f.contenido.startsWith("a"));
igual("tope de caracteres: lo que entra de la anterior no pasa de 8.750",
  anteriorKept.reduce((s, f) => s + f.contenido.length, 0) <= TOPE_ANTERIOR_CARACTERES, true);
// Entran 29 de 300 (8.700); el primero de esos 29 es del bot y se saca porque el historial arranca por el cliente: quedan 28.
igual("tope de caracteres: los últimos 29 de 300, menos el primero que es del bot", [anteriorKept.length, anteriorKept.at(-1)!.contenido.slice(0, 3)], [28, "a39"]);
const porMensajes = modelo([...charla(7, 80, "a"), ...charla(8, 1, "h")]);
igual("tope de mensajes: 60 de la anterior", porMensajes.filas.filter((f) => f.contenido.startsWith("a")).length, TOPE_ANTERIOR_MENSAJES);
const gigante = modelo([...charla(7, 4, "a", 20), { rol: "assistant", contenido: "x".repeat(9000), creado_en: new Date(Date.UTC(2026, 9, 7, 12, 4)).toISOString() },
  ...charla(8, 1, "h")]);
igual("último mensaje de la anterior más largo que el tope: no se agrega nada", gigante.agregadas, 0);

// ── Charla de hoy larga: la anterior, un salto y la ventana ──────────────────────────────────────────────────────────────────────
const salto = modelo([...charla(7, 10, "a"), ...charla(8, 40, "h")]);
igual("salto: la anterior entera y después la ventana", [textos(salto)[0], textos(salto)[9], salto.filas.length], ["a0", "a9", 10 + largoVentana(50)]);
igual("salto: marcas en la anterior y donde retoma la ventana", salto.marcas, [0, 10]);
igual("salto: 10 agregadas", salto.agregadas, 10);

// ── Primer mensaje del bot: se saca (Anthropic y Gemini piden empezar por el cliente) y la marca pasa al siguiente ───────────────
const desdeBot = modelo([...charla(7, 30, "a", 10, true), ...charla(8, 1, "h")]);
igual("arranca por el cliente", desdeBot.filas[0].rol, "user");
igual("la marca queda en el primer mensaje", desdeBot.marcas[0], 0);

// ── Marca: fecha y hora de Argentina ───────────────────────────────────────────────────────────────────────────────────────────
igual("marcaDeTramo en hora de Argentina", marcaDeTramo("2026-10-07T12:30:00Z"), "[Mensajes del 07/10 desde las 09:30]");
igual("marcaDeTramo sin fecha", marcaDeTramo("no es fecha"), "[Mensajes anteriores]");
igual("filas vacías", historialParaElModelo([], 0), { filas: [], marcas: [], agregadas: 0 });
igual("la marca copiada en una respuesta se borra",
  [sinMarcaDeTramo("[Mensajes del 07/10 desde las 09:30]\nAyer me pediste 3 cajas."), sinMarcaDeTramo("Hola.\n[Mensajes anteriores]\nSigo."), sinMarcaDeTramo("[Mensajes del 07/10 desde las 09:30]")],
  ["Ayer me pediste 3 cajas.", "Hola.\nSigo.", ""]);
igual("un corchete común no se toca", sinMarcaDeTramo("Pedido [nota: urgente] del 07/10"), "Pedido [nota: urgente] del 07/10");

// ── Caché: durante la charla de hoy, la charla anterior queda igual de un turno al otro ──────────────────────────────────────────
// Se arma el historial como bot-conversation (marca adelante del texto) y el cuerpo de Anthropic; el prefijo marcado como "historial
// anterior" en un turno tiene que seguir igual en el siguiente.
const tools = [{ name: "consultar_mis_pedidos", description: "a", input_schema: { type: "object", properties: {} } }];
function cuerpoDelTurno(filas: Fila[], nota: string) {
  const r = modelo(filas);
  const conMarca = new Set(r.marcas);
  const h = r.filas.map((f, j) => {
    const text = conMarca.has(j) ? `${marcaDeTramo(f.creado_en)}\n${f.contenido}` : f.contenido;
    return f.rol === "user" ? { role: "user" as const, text } : { role: "assistant" as const, text, toolCalls: [] };
  });
  return cuerpoAnthropic("claude-sonnet-4-6", { estable: "E", variable: nota }, tools, h);
}
// deno-lint-ignore no-explicit-any
const sinCache = (x: any) => JSON.stringify(x, (k, v) => (k === "cache_control" ? undefined : v));
const anterior = charla(7, 25, "a");
let reusos = 0, turnos = 0, anteriorIgual = true;
for (let n = 1; n <= 39; n += 2) {   // hoy: 1, 3, 5 … 39 mensajes (20 turnos)
  const a = cuerpoDelTurno([...anterior, ...charla(8, n, "h")], `turno ${n}`);
  const b = cuerpoDelTurno([...anterior, ...charla(8, n + 2, "h")], `turno ${n + 2}`);
  // deno-lint-ignore no-explicit-any
  const p = a.messages.findIndex((m: any) => Array.isArray(m.content) && m.content.at(-1)?.cache_control);
  turnos++;
  if (p >= 0 && p < a.messages.length - 1 && sinCache(a.messages.slice(0, p + 1)) === sinCache(b.messages.slice(0, p + 1))) reusos++;
  if (sinCache(a.messages.slice(0, 25)) !== sinCache(b.messages.slice(0, 25))) anteriorIgual = false;
}
igual("caché: la charla anterior (25 mensajes) es igual en los 20 turnos de hoy", anteriorIgual, true);
igual("caché: el turno siguiente reusa el historial en 17 de 20 turnos", reusos, 17);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
