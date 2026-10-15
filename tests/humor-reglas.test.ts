// Pruebas de _shared/humor-reglas.ts (auditoría 829, Pablo Olejavetzky, 15/10/2026): un mensaje cortés con varias preguntas se tomaba por cliente molesto.
// Funciones puras, sin red, sin IA, US$ 0. Reproduce el mensaje real de Logística (…1027) del 15/10 16:42.
// Correr: deno run tests/humor-reglas.test.ts   (sale con código 1 si algo falla)
import { esUrgente, estaMolesto } from "../supabase/functions/_shared/humor-reglas.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── El caso real: tres consultas en un mensaje, cuatro «?» sueltos ──
const CASO = "Hola, como estas? tenes stock del 586? que valor tiene? Tenes stock para 20 cajas?";
igual("el mensaje real de Logística NO es un cliente molesto", estaMolesto(CASO), false);
igual("ni es urgente", esUrgente(CASO), false);

// ── Varias frases con signos separados no son un grito, con o sin tildes ──
igual("saludo con «!» y preguntas repartidas", estaMolesto("Hola! Buen día! Tenés stock del 505? Y del 586? Gracias!"), false);
igual("cinco preguntas seguidas, cada una con su «?»", estaMolesto("precio del 505? y del 586? y del 600? y del 700? y del 800?"), false);
igual("un «Hola!!!» amistoso (3 signos pegados)", estaMolesto("Hola!!! buen día, tenés stock del 505"), false);
igual("un mensaje largo y normal con varias preguntas y exclamaciones", estaMolesto("Buenas tardes! Necesito saber si hay stock del 505? Cuánto sale la caja? Me lo pueden mandar a Caseros? Gracias!"), false);

// ── Lo que sí sigue siendo un grito o un enojo ──
igual("cuatro signos pegados: «????»", estaMolesto("dónde está mi pedido????"), true);
igual("cuatro signos pegados: «!!!!»", estaMolesto("contesten por favor!!!!"), true);
igual("signos mezclados pegados: «?!?!»", estaMolesto("qué pasa?!?!"), true);
igual("MAYÚSCULAS con un signo", estaMolesto("TENGO UN PROBLEMA CON MI PEDIDO!"), true);
igual("insulto", estaMolesto("son unos boludos"), true);
igual("queja fuerte: «una vergüenza»", estaMolesto("es una vergüenza lo de ustedes"), true);
igual("queja fuerte: «nadie me contesta»", estaMolesto("nadie me contesta nada"), true);
igual("la frase de Pablo en la misma charla: «que pasa que no entendes?» NO es un insulto ni una queja de las listas", estaMolesto("Si, ese, que pasa que no entendes?"), false);

// ── Urgente: lo suyo no cambió ──
igual("urgente por palabra de apuro", esUrgente("necesito el pedido urgente"), true);
igual("urgente por problema con la entrega", esUrgente("el pedido vino roto"), true);
igual("un molesto también es urgente", esUrgente("es una vergüenza!!!!"), true);

// ── Guarda de código: el detector ya no cuenta los signos sueltos ──
const fuente = await Deno.readTextFile(new URL("../supabase/functions/_shared/humor-reglas.ts", import.meta.url));
igual("grita() ya no usa «signos >= 4» (cuenta todos los signos del mensaje)", /signos\s*>=\s*4/.test(fuente), false);
igual("grita() pide los signos pegados", /\[!\?\]\{4,\}/.test(fuente), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
