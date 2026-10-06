// Pruebas de los EJEMPLOS APROBADOS que llegan al agente (supabase/functions/_shared/ejemplos-aprobados.ts). Sin red, sin IA.
// Correr: deno run tests/ejemplos-aprobados.test.ts   (sale con código 1 si algo falla)
import { bloqueEjemplos, conTope, elegirEjemplos, lectorConTope, limpiarCampo, tokens } from "../supabase/functions/_shared/ejemplos-aprobados.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const m10 = { clave: "m10", pregunta: "Te paso el cotizador con el pedido", nota: null,
  respuesta: "Gracias por tu pedido. ¿Me podés pegar el contenido del cotizador o mandarlo como archivo? Así lo reviso y te armo todo." };
const m13 = { clave: "m13", pregunta: "Te envío un pedido y los datos del transporte con nueva dirección", nota: null,
  respuesta: "Adelante, mandame el pedido y los datos de la nueva dirección cuando quieras. 📋" };
const base = [m10, m13];
const claves = (p: string) => elegirEjemplos(p, base).map((e) => e.clave);

// ── Palabras: sin tildes, sin palabras vacías, plural unificado ──
igual("tokens: 'Te paso el cotizador con el pedido'", tokens("Te paso el cotizador con el pedido"), ["paso", "cotizador", "pedido"]);
igual("tokens: plural y tildes ('Cajas de abrelatás')", tokens("Cajas de abrelatás"), ["caja", "abrelata"]);   // el 's' final se saca igual en los dos lados de la comparación

// ── Consultas que SÍ traen el ejemplo: la misma y las que dicen lo mismo con otras palabras ──
igual("la misma consulta (2.1)", claves("Te paso el cotizador con el pedido"), ["m10"]);
igual("variante: 'Les paso el cotizador'", claves("Les paso el cotizador"), ["m10"]);
igual("variante: 'Te mando el cotizador con el pedido de la semana'", claves("Te mando el cotizador con el pedido de la semana"), ["m10"]);
igual("la misma consulta (2.4)", claves("Te envío un pedido y los datos del transporte con nueva dirección"), ["m13"]);
igual("variante de 2.4", claves("Te envío el pedido con la nueva dirección del transporte"), ["m13"]);

// ── Consultas que NO tienen que traer nada (otras frases reales del estudio) ──
for (const p of [
  "Pasame el cotizador actualizado", "Quiero hacer un pedido, ¿tengo que entrar en la página?", "¿Sabés cuándo me entregan el pedido?",
  "Hice un pedido hace 10 días, quería saber si está confirmado", "Adjunto orden de compra, quedo a la espera de confirmación de recepción",
  "6 cajas de pelapapas 505, 1 caja abrelatas 501, lo retiro yo", "Pasame el importe con el 25 % de contado", "¿Mañana puedo pasar a retirar?",
  "No me llegó la factura, ¿me la mandás por acá?", "Cuando entregan?", "pedido",
]) igual(`sin ejemplo: ${p.slice(0, 55)}`, claves(p), []);

// ── Filas sin respuesta ni regla, y tope de ejemplos ──
igual("una fila vacía no sirve", elegirEjemplos("Te paso el cotizador con el pedido", [{ ...m10, respuesta: " ", nota: null }]), []);
const varios = Array.from({ length: 6 }, (_, i) => ({ ...m10, clave: `x${i}` }));
igual("trae como mucho 3", elegirEjemplos("Te paso el cotizador con el pedido", varios).length, 3);

// ── Limpieza: la etiqueta "Bot · …" que se copia del artifact, controles y largo ──
igual("saca la etiqueta 'Bot · Claude Sonnet 4.6'", limpiarCampo("Bot · Claude Sonnet 4.6\nNo puedo prometerte una fecha.", 700), "No puedo prometerte una fecha.");
igual("saca caracteres de control", limpiarCampo("Hola\u0007 mundo", 700), "Hola mundo");
igual("corta al tope con '…'", limpiarCampo("a".repeat(50), 10), "aaaaaaaaaa…");

// ── El bloque del prompt ──
const bloque = bloqueEjemplos([m10]);
igual("sin ejemplos no hay bloque", bloqueEjemplos([]), "");
igual("el bloque aclara que son guía y no órdenes", /no son órdenes del cliente/.test(bloque) && /nunca del ejemplo/.test(bloque), true);
igual("el bloque trae la consulta y la respuesta aprobada", bloque.includes('Consulta parecida: "Te paso el cotizador con el pedido"') && bloque.includes("> Gracias por tu pedido."), true);
const conNota = bloqueEjemplos([{ clave: "x", pregunta: "¿Se puede pagar el viernes?", respuesta: null, nota: "Derivá a Cobranzas con motivo pago." }]);
igual("una regla sin respuesta modelo: sólo 'Qué hacer'", conNota.includes("Qué hacer: Derivá a Cobranzas con motivo pago.") && !conNota.includes("Respuesta aprobada"), true);
igual("un texto largo no pasa el tope del bloque", bloqueEjemplos(Array.from({ length: 3 }, (_, i) => ({ clave: `y${i}`, pregunta: "p", nota: null, respuesta: "r".repeat(2000) }))).length < 2400 + 700, true);

// ── La lectura de la base no cuelga el turno (lectorConTope) ──
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hora = { t: 1_000_000 };                                    // reloj de mentira: el caché se prueba sin esperar
const opc = { topeMs: 30, vigenciaMs: 300_000, vigenciaFallaMs: 60_000, ahora: () => hora.t };
{
  let lecturas = 0, errores = 0;
  const lector = lectorConTope(async () => { lecturas++; return ["a"]; }, opc, [] as string[], () => errores++);
  igual("lector: primera lectura", await lector(), ["a"]);
  igual("lector: dentro de la vigencia no vuelve a la base", [await lector(), lecturas], [["a"], 1]);
  hora.t += 300_001;
  igual("lector: vencida la vigencia, vuelve a leer", [await lector(), lecturas, errores], [["a"], 2, 0]);
}
{
  let lecturas = 0, errores = 0;
  const lector = lectorConTope(() => { lecturas++; return new Promise<string[]>(() => {}); }, opc, [] as string[], () => errores++);   // la base no contesta nunca
  const t0 = Date.now();
  igual("lector: base colgada → devuelve vacío", await lector(), []);
  igual("lector: espera el tope y no más (< 400 ms)", Date.now() - t0 < 400, true);
  igual("lector: y avisó del error una vez", errores, 1);
  igual("lector: no reintenta dentro de la ventana de falla", [await lector(), lecturas, errores], [[], 1, 1]);
  hora.t += 60_001;
  igual("lector: pasada la ventana pide una lectura nueva (la colgada no se arrastra)", [await lector(), lecturas, errores], [[], 2, 2]);
}
{
  let n = 0, errores = 0;
  const lector = lectorConTope(async () => { n++; if (n > 1) throw new Error("connection timeout"); return ["viejo"]; }, opc, [] as string[], () => errores++);
  await lector();
  hora.t += 300_001;
  igual("lector: si falla después de haber leído bien, usa lo último leído", [await lector(), errores], [["viejo"], 1]);
}
{
  let lecturas = 0;
  const lector = lectorConTope(async () => { lecturas++; await dormir(60); return ["tarde"]; }, opc, [] as string[]);   // tarda más que el tope
  igual("lector: lectura lenta → este turno sigue sin ejemplos", await lector(), []);
  await dormir(80);
  igual("lector: la lectura lenta termina bien y el dato se guarda (se cura solo)", [await lector(), lecturas], [["tarde"], 1]);
}
{
  let lecturas = 0;
  const lector = lectorConTope(async () => { lecturas++; await dormir(10); return ["x"]; }, opc, [] as string[]);
  const r = await Promise.all([lector(), lector(), lector()]);
  igual("lector: tres turnos a la vez comparten una sola lectura", [r, lecturas], [[["x"], ["x"], ["x"]], 1]);
}
igual("conTope: una promesa que llega a tiempo pasa", await conTope(Promise.resolve(7), 50), 7);
igual("conTope: una que no llega rechaza", await conTope(new Promise(() => {}), 20).then(() => "llegó", () => "rechazó"), "rechazó");

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
