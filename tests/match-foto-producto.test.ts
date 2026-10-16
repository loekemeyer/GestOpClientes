// Pruebas de _shared/match-foto-producto.ts — sólo la parte pura (parseMatch). La llamada a la visión paga no se prueba acá (lleva red e IA).
// Correr: deno run tests/match-foto-producto.test.ts   (sale con código 1 si algo falla)
import { parseMatch } from "../supabase/functions/_shared/match-foto-producto-puro.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const cands = new Set(["501", "502", "512", "066"]);

igual("match claro con alta confianza",
  parseMatch('{"cod":"501","confianza":"alta","alternativas":[]}', cands), { cod: "501", confianza: "alta", alternativas: [] });

igual("duda entre dos: principal + alternativa",
  parseMatch('{"cod":"502","confianza":"media","alternativas":["512"]}', cands), { cod: "502", confianza: "media", alternativas: ["512"] });

igual("cod null (no está en catálogo)",
  parseMatch('{"cod":null,"confianza":"baja","alternativas":[]}', cands), { cod: null, confianza: "baja", alternativas: [] });

igual("el modelo devuelve un código que NO estaba entre los candidatos: se descarta",
  parseMatch('{"cod":"999","confianza":"alta","alternativas":[]}', cands), { cod: null, confianza: "alta", alternativas: [] });

igual("una alternativa que no es candidato se filtra; el principal no se repite en alternativas",
  parseMatch('{"cod":"501","confianza":"media","alternativas":["501","999","502"]}', cands), { cod: "501", confianza: "media", alternativas: ["502"] });

igual("confianza inválida cae a baja",
  parseMatch('{"cod":"066","confianza":"segurísimo","alternativas":[]}', cands), { cod: "066", confianza: "baja", alternativas: [] });

igual("JSON envuelto en texto/```",
  parseMatch('```json\n{"cod":"512","confianza":"alta","alternativas":[]}\n```', cands), { cod: "512", confianza: "alta", alternativas: [] });

igual("sin JSON: null", parseMatch("no pude", cands), { cod: null, confianza: "baja", alternativas: [] });
igual("JSON roto: null", parseMatch('{"cod":', cands), { cod: null, confianza: "baja", alternativas: [] });
igual("tope de 3 alternativas", parseMatch('{"cod":"501","confianza":"baja","alternativas":["502","512","066","999"]}', new Set(["501","502","512","066","777"])),
  { cod: "501", confianza: "baja", alternativas: ["502", "512", "066"] });

// Guardas de código: la pieza está conectada al webhook.
const webhook = await Deno.readTextFile(new URL("../supabase/functions/lk_whatsapp-webhook/index.ts", import.meta.url));
igual("el webhook importa matchFotoProducto", /import \{[^}]*matchFotoProducto[^}]*\} from "\.\.\/_shared\/match-foto-producto\.ts";/.test(webhook), true);
igual("el match está gateado por wa_match_foto_modelo", /getSetting\("wa_match_foto_modelo"\)/.test(webhook), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
