// Pruebas de la compuerta de foto (supabase/functions/_shared/compuerta-foto.ts). Sin red, sin IA.
// Correr: deno run tests/compuerta-foto.test.ts   (sale con código 1 si algo falla)
import { debeForzarFoto, fotosAEnviar, MAX_FOTOS_COMPUERTA, pideFoto } from "../supabase/functions/_shared/compuerta-foto.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// pideFoto: el cliente pide ver una foto/imagen.
igual("tenés foto", pideFoto("tenes stock del 654, cuanto vale? tenes foto?"), true);
igual("mandame una foto", pideFoto("mandame una foto del 505"), true);
igual("pasame la imagen", pideFoto("pasame la imagen"), true);
igual("fotos (plural)", pideFoto("tenes fotos?"), true);
igual("sin la palabra: no", pideFoto("cuanto vale el 505?"), false);
igual("«sin foto» no pide foto", pideFoto("mandalo sin foto"), false);
igual("«no quiero foto» no pide foto", pideFoto("no quiero foto, solo el precio"), false);
igual("«fotocopia» no dispara (palabra pegada)", pideFoto("necesito una fotocopia de la factura"), false);

// debeForzarFoto: pidió foto, no se llamó a enviar_fotos_producto, no es turno de pedido.
igual("pidió foto y no se mandó: forzar", debeForzarFoto("tenes foto del 654?", ["consultar_stock", "buscar_productos"], false), true);
igual("ya se llamó a enviar_fotos_producto: no forzar", debeForzarFoto("tenes foto del 654?", ["enviar_fotos_producto"], false), false);
igual("no pidió foto: no forzar", debeForzarFoto("cuanto vale el 654?", [], false), false);
igual("turno de pedido: no forzar (tiene sus compuertas)", debeForzarFoto("tenes foto del 654?", [], true), false);

// fotosAEnviar: saca el código del texto del bot, del cliente o del artículo en curso.
igual("código en la respuesta del bot", fotosAEnviar("La Bombilla Autolimpiante Inox (cód. 654) tiene stock.", "tenes foto?", []), ["654"]);
igual("código en el mensaje del cliente", fotosAEnviar("Claro.", "tenes foto del 505?", []), ["505"]);
igual("sin código en ningún lado: no inventa", fotosAEnviar("Claro.", "tenes foto?", []), []);
igual(`tope de ${MAX_FOTOS_COMPUERTA}`, fotosAEnviar("cód. 501, cód. 502, cód. 503, cód. 504, cód. 505", "fotos", []).length, MAX_FOTOS_COMPUERTA);

if (fallas) { console.error(`\n${fallas} fallas`); Deno.exit(1); }
console.log("\ntodo ok");
