// Tiempo de punta a punta de cada respuesta (supabase/functions/_shared/tiempos-turno.ts y el gancho en wa-api.ts › waPost).
// Pablo Olejavetzky, 09/10/2026: medir si el bot contesta en 3 a 6 s. Sin red, sin IA, US$ 0.
// Correr: deno run --allow-env --allow-read tests/tiempos-turno.test.ts   (sale con código 1 si algo falla)
import { abrirTurno, cerrarTurno, clave, filaTurno, guardarTurno, iaEmpieza, iaTermina, registrarEnvio } from "../supabase/functions/_shared/tiempos-turno.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── Un turno simple: llega, la IA tarda, salen dos mensajes ──
const T0 = Date.UTC(2026, 9, 9, 15, 0, 0);
const t = abrirTurno({ wamid: "w1", phone: "5491131181594", tipo: "text", metaTimestamp: String(T0 / 1000 - 2), recibidoMs: T0 });
igual("el timestamp de Meta (segundos) pasa a ms", t.metaTs, T0 - 2000);
iaEmpieza("5491131181594", T0 + 100);
iaTermina("5491131181594", T0 + 4100);
registrarEnvio("1131181594", T0 + 4200, T0 + 4500);       // otro formato del mismo número: misma clave
registrarEnvio("5491131181594", T0 + 4600, T0 + 4800);
registrarEnvio("5491100000000", T0 + 4600, T0 + 4800);    // otro número: no se cuenta
const f = filaTurno(t, T0 + 5000);
igual("envíos al mismo número", f.envios, 2);
igual("primer envío = cuando Meta aceptó el primero", f.primer_envio_at, new Date(T0 + 4500).toISOString());
igual("último envío", f.ultimo_envio_at, new Date(T0 + 4800).toISOString());
igual("tiempo dentro de los POST a Meta", f.envio_ms, 500);
igual("tiempo de la IA", f.ia_ms, 4000);
igual("pasó por la IA", f.ia, true);
igual("no concurrente", f.concurrente, false);
igual("meta_at", f.meta_at, new Date(T0 - 2000).toISOString());
cerrarTurno(t);
registrarEnvio("5491131181594", 1, 2);
igual("cerrado: un envío posterior no lo toca", t.envios, 2);

// ── Sin turno abierto (lk_outbox-flush, lk_templates…): no hace nada ni lanza ──
registrarEnvio("5491199999999", 1, 2);
igual("sin turno abierto no pasa nada", true, true);

// ── Timestamp de Meta inválido ──
const sinTs = abrirTurno({ wamid: "w2", phone: "5491122223333", tipo: "text", metaTimestamp: "", recibidoMs: T0 });
igual("sin timestamp de Meta → null", filaTurno(sinTs, T0).meta_at, null);
igual("sin IA ni envíos", [filaTurno(sinTs, T0).ia, filaTurno(sinTs, T0).envios, filaTurno(sinTs, T0).primer_envio_at], [false, 0, null]);
cerrarTurno(sinTs);

// ── Ráfaga: dos mensajes del mismo número a la vez ──
const a = abrirTurno({ wamid: "a", phone: "5491144445555", tipo: "text", recibidoMs: T0 });
const b = abrirTurno({ wamid: "b", phone: "5491144445555", tipo: "text", recibidoMs: T0 + 300 });
registrarEnvio("5491144445555", T0 + 1000, T0 + 1200);
igual("los dos quedan marcados concurrentes", [a.concurrente, b.concurrente], [true, true]);
igual("el envío va al más reciente", [a.envios, b.envios], [0, 1]);
cerrarTurno(b);
registrarEnvio("5491144445555", T0 + 2000, T0 + 2100);
igual("cerrado el más reciente, el siguiente envío va al anterior", a.envios, 1);
cerrarTurno(a);

// ── La IA empezó y lanzó antes de terminar: igual cuenta como IA ──
const c = abrirTurno({ wamid: "c", phone: "5491166667777", tipo: "text", recibidoMs: T0 });
iaEmpieza("5491166667777", T0);
igual("IA sin terminar → ia true, ia_ms 0", [filaTurno(c, T0).ia, filaTurno(c, T0).ia_ms], [true, 0]);
cerrarTurno(c);

// ── El error se corta a 300 caracteres ──
const d = abrirTurno({ wamid: "d", phone: "5491188889999", tipo: "text", recibidoMs: T0 });
igual("error recortado", (filaTurno(d, T0, "x".repeat(500)).error as string).length, 300);
cerrarTurno(d);

igual("clave: últimos 10 dígitos", clave("+54 9 11 3118-1594"), "1131181594");

// ── guardarTurno: inserta en wa_turno_tiempos, cierra el turno y nunca lanza ──
const insertados: Array<{ tabla: string; fila: Record<string, unknown> }> = [];
const sbOk = { from: (tabla: string) => ({ insert: (fila: Record<string, unknown>) => { insertados.push({ tabla, fila }); return Promise.resolve({ error: null }); } }) };
const e = abrirTurno({ wamid: "e", phone: "5491100001111", tipo: "text", recibidoMs: T0 });
await guardarTurno(sbOk, e);
igual("guarda en wa_turno_tiempos", [insertados[0]?.tabla, insertados[0]?.fila.wamid], ["wa_turno_tiempos", "e"]);
registrarEnvio("5491100001111", 1, 2);
igual("guardado = cerrado", e.envios, 0);
const sbRoto = { from: () => ({ insert: () => { throw new Error("sin base"); } }) };
let lanzo = false;
try { await guardarTurno(sbRoto, abrirTurno({ wamid: "f", phone: "5491100002222", tipo: "text", recibidoMs: T0 })); } catch { lanzo = true; }
igual("si la base falla, no lanza", lanzo, false);

// ── El gancho en waPost: cuenta lo que Meta aceptó con `to`, no el "leído" ni un rechazo ──
// wa-guard toma el fetch que encuentra al cargar: se le da uno falso que autoriza el envío y contesta como Meta.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
let metaRechaza = false;
globalThis.fetch = (async (input: Request | URL | string) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/rpc/wa_puede_enviar")) return new Response("true", { status: 200 });
  if (metaRechaza) return new Response(JSON.stringify({ error: { message: "no", code: 131026 } }), { status: 400 });
  return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 });
}) as typeof fetch;
const { sendText, markRead } = await import("../supabase/functions/_shared/wa-api.ts");
const g = abrirTurno({ wamid: "g", phone: "5491131181594", tipo: "text", recibidoMs: Date.now() });
await sendText("123", "tok", "5491131181594", "hola");
await markRead("123", "tok", "wamid.entrante");
metaRechaza = true;
try { await sendText("123", "tok", "5491131181594", "rechazado"); } catch { /* waPost lanza en !res.ok */ }
igual("waPost: cuenta el texto aceptado, no el leído ni el rechazado", g.envios, 1);
igual("waPost: primer envío anotado", g.primerEnvioMs !== null, true);
cerrarTurno(g);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
