// Pablo Olejavetzky, 14/10/2026 (P5, caso mp05 con Haiku 5.5): «Pasame la foto del 441 y decime si hay stock». consultar_stock ya avisa a una
// persona cuando no hay stock, pero el agente además llamaba a derivar_a_persona y contestaba sólo «una persona te escribe», sin el stock ni la
// foto. Prueba del TEXTO de las dos herramientas (no prueba al modelo): que no se pierdan las dos indicaciones.
// Correr: node --experimental-strip-types --no-warnings tests/derivar-sin-tapar.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";

const conv = readFileSync(new URL("../supabase/functions/_shared/bot-conversation.ts", import.meta.url), "utf8");
let fallas = 0;
function ok(nombre: string, cond: boolean) {
  if (cond) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}`); }
}
ok("derivar_a_persona pide incluir lo ya averiguado y no reemplazarlo por el aviso",
  /Tu respuesta tiene que incluir TAMBIÉN todo lo que ya averiguaste/.test(conv) && /no lo reemplaces por el aviso/.test(conv));
ok("consultar_stock, si ya avisó a una persona, dice que no se derive de nuevo",
  /const avisado = stockNecesitaHumano\(st, cajas\)/.test(conv) && /Esta consulta YA quedó avisada a una persona: NO llames a derivar_a_persona por el stock/.test(conv));
if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
