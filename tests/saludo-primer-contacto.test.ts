// El saludo del primer contacto del día es «¡Hola!» sin nombre (supabase/functions/lk_whatsapp-webhook/index.ts, conSaludoSiCorresponde). Guarda sobre el código: la función vive en el webhook
// (no se puede importar sin levantar el servidor) y no hay otra forma de que un cambio futuro vuelva a poner la razón social sin que una prueba falle.
// Pablo Olejavetzky, 15/10/2026 (tanda de pruebas, mensaje 1): «Cuanto sale el 505?» recibió «¡Hola Garbarino Franco Tomas!». La base sólo tiene la razón social de 1.264 clientes y la mayoría
// son personas con el apellido primero («Quispe Gabriel Dario Josue»). Pablo: «Sí, cambialo a «¡Hola!» sin nombre».
// Correr: node --experimental-strip-types --no-warnings tests/saludo-primer-contacto.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const hook = readFileSync(new URL("../supabase/functions/lk_whatsapp-webhook/index.ts", import.meta.url), "utf8");

// La definición: dos parámetros (respuesta y teléfono), nada de razón social, y el saludo es «¡Hola!».
const def = hook.match(/async function conSaludoSiCorresponde\(([\s\S]*?)\): Promise<string> \{([\s\S]*?)\n\}\n/);
igual("conSaludoSiCorresponde existe", !!def, true);
igual("sus parámetros son sólo la respuesta y el teléfono", (def?.[1] ?? "").replace(/\s+/g, " ").trim(), "reply: string, phone: string,");
igual("el saludo es «¡Hola!» sin nombre", (def?.[2] ?? "").includes("return `¡Hola!\\n\\n${reply}`;"), true);
igual("no queda ningún nombre dentro del saludo", /¡Hola\s*\$\{/.test(def?.[2] ?? ""), false);

// Los usos: ningún punto de salida le pasa la razón social.
const usos: string[] = [];
for (let i = hook.indexOf("conSaludoSiCorresponde("); i >= 0; i = hook.indexOf("conSaludoSiCorresponde(", i + 1)) {
  if (hook.slice(Math.max(0, i - 15), i).includes("function ")) continue;   // la definición
  let prof = 0, j = i + "conSaludoSiCorresponde".length;
  for (; j < hook.length; j++) { if (hook[j] === "(") prof++; else if (hook[j] === ")" && --prof === 0) break; }
  usos.push(hook.slice(i, j + 1));
}
igual("los 4 puntos de salida con saludo (Chef, respuesta fija, mensajes partidos y agente)", usos.length, 4);
igual("ninguno le pasa la razón social", usos.filter((u) => /business_name|razon_social/.test(u)), []);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
