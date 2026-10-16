// Pruebas del split de la respuesta del agente en varios mensajes (supabase/functions/_shared/partir-respuesta.ts). Sin red, sin IA.
// Correr: deno run tests/partir-respuesta.test.ts   (sale con código 1 si algo falla)
import { MARCADOR_CORTE, MAX_PARTES_RESPUESTA, partirRespuesta } from "../supabase/functions/_shared/partir-respuesta.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const C = MARCADOR_CORTE;

// Sin marcador: un solo mensaje, igual que hasta hoy (cero regresión).
igual("respuesta normal, sin marcador: un solo mensaje", partirRespuesta("Hay stock del 654. Te queda $57.024 por caja."), ["Hay stock del 654. Te queda $57.024 por caja."]);
igual("respuesta con saltos de línea pero sin marcador: NO se parte", partirRespuesta("Así va tu pedido:\n\nprogramado para el martes 20/10."), ["Así va tu pedido:\n\nprogramado para el martes 20/10."]);
igual("vacío: ninguna parte", partirRespuesta(""), []);
igual("sólo espacios: ninguna parte", partirRespuesta("   \n  "), []);

// Con marcador: un mensaje por respuesta, sin el marcador y recortado.
igual("dos respuestas", partirRespuesta(`Hay stock del 654.${C}Te queda $57.024 por caja.`), ["Hay stock del 654.", "Te queda $57.024 por caja."]);
igual("el marcador en su propia línea", partirRespuesta(`uno\n${C}\ndos`), ["uno", "dos"]);
igual("marcador al final: no deja parte vacía", partirRespuesta(`uno${C}`), ["uno"]);
igual("marcador al principio: no deja parte vacía", partirRespuesta(`${C}uno`), ["uno"]);
igual("el marcador nunca queda en el texto", partirRespuesta(`a${C}b`).some((p) => p.includes(C)), false);

// Tope: lo que pasa del tope se pega a la última, no se pierde ni inunda.
const nueve = Array.from({ length: 9 }, (_, i) => `r${i + 1}`).join(C);
const r = partirRespuesta(nueve);
igual("9 respuestas se recortan a MAX_PARTES_RESPUESTA mensajes", r.length, MAX_PARTES_RESPUESTA);
igual("la última junta las que sobran (r8 y r9)", r[r.length - 1], "r8\n\nr9");
igual("no se pierde ninguna respuesta", r.join(" ").includes("r9"), true);

if (fallas) { console.error(`\n${fallas} fallas`); Deno.exit(1); }
console.log("\ntodo ok");
