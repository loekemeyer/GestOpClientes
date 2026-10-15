// Pedido de precios con fotos (Pablo Olejavetzky, 15/10/2026, tanda de pruebas, mensaje 8): «Dame el precio de todos los pelapapas que tengas y fotos» contestó sólo «Le envié las fotos de los 10
// peladores»: sin precios, y la foto del 599E (JPEG CMYK) no llegó. Sin red: prueba que el agente lleve las dos reglas y que la herramienta de fotos mire la imagen antes de mandarla.
// La conducta del modelo con estas reglas se mide en el Simulador y con un mensaje real.
// Correr: node --experimental-strip-types --no-warnings tests/precios-y-fotos.test.ts   (sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import { REGLAS_OPERATIVAS } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const fuente = (p: string) => readFileSync(new URL(`../supabase/functions/_shared/${p}`, import.meta.url), "utf8");

// Las reglas del agente
const reglas = String(REGLAS_OPERATIVAS);
igual("regla PRECIOS Y FOTOS: el texto lleva el precio de cada artículo por caja + IVA", /PRECIOS Y FOTOS[\s\S]*?el texto de la respuesta lleva el precio de CADA artículo por caja «\+ IVA»/.test(reglas), true);
igual("regla PRECIOS Y FOTOS: nunca sólo «te envié las fotos»", /nunca contestes sólo «te envié las fotos»/.test(reglas), true);
igual("regla PRECIOS Y FOTOS: usa el precio del cliente si viene y el ejemplo no es un artículo real", /precio_cliente_por_caja si viene y si no el de lista[\s\S]*?«cód\. 123 · Nombre del artículo: \$12\.345 por caja \+ IVA»/.test(reglas), true);
igual("regla PRECIOS Y FOTOS: si falta una foto (sin_foto) se dice cuál, sin el motivo técnico, y se da el precio igual", /códigos en sin_foto, decile cuáles son \(sin explicar el motivo técnico\) y dale igual el precio/.test(reglas), true);
igual("regla LISTA DE PRECIOS: la lista está en la web, con CUIT y contraseña", /LISTA DE PRECIOS[\s\S]*?loekemeyer\.com[\s\S]*?«Pedidos Mayorista» con su CUIT y contraseña/.test(reglas), true);
igual("regla LISTA DE PRECIOS: nunca decir que no hay una lista", /Nunca digas que no hay una lista de precios/.test(reglas), true);

// La herramienta de fotos
const conv = fuente("bot-conversation.ts");
const caso = conv.slice(conv.indexOf('case "enviar_fotos_producto": {'), conv.indexOf('case "anotar_duda"'));
igual("enviar_fotos_producto importa y usa imagenEnviable", /import \{ imagenEnviable \} from "\.\/imagen-enviable\.ts"/.test(conv) && /imagenEnviable\(x\.url\)/.test(caso), true);
igual("la foto que Meta no acepta se saca de las que se mandan y va a sin_foto", /if \(veredictos\[k\]\.ok\) medias\.push[\s\S]*?else \{ sinFoto\.push\(x\.c\)/.test(caso), true);
igual("si ninguna se puede mandar, el error trae sin_foto", /Ninguno de esos productos tiene fotos que se puedan mandar por WhatsApp\.", sin_foto: sinFoto/.test(caso), true);
igual("con sin_foto el agente recibe una nota para decírselo al cliente", /nota: "De los códigos de sin_foto no se pudo mandar foto: decile al cliente cuáles son/.test(caso), true);
igual("la descripción de la herramienta avisa que las fotos no llevan precio", /las fotos no llevan el precio/.test(conv), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); process.exit(1); }
console.log("\ntodo bien");
