// Pruebas de _shared/outbox-imagen.ts: una fila de wa_outbox con media_url sale como mensaje de imagen. Sin red, sin IA.
// Correr: deno run tests/outbox-imagen.test.ts   (sale con código 1 si algo falla)
import { cuerpoImagen, historialImagen } from "../supabase/functions/_shared/outbox-imagen.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const URL = "https://kwkclwhmoygunqmlegrg.supabase.co/storage/v1/object/public/products-images/505.webp";

igual("imagen por link con epígrafe", cuerpoImagen("5491100000000", URL, "Foto del 505"), {
  messaging_product: "whatsapp", to: "5491100000000", type: "image", image: { link: URL, caption: "Foto del 505" },
});
igual("sin epígrafe no manda caption", cuerpoImagen("5491100000000", URL, null), {
  messaging_product: "whatsapp", to: "5491100000000", type: "image", image: { link: URL },
});
igual("epígrafe sólo con espacios = sin caption", (cuerpoImagen("1", URL, "   ")?.image as Record<string, unknown>).caption, undefined);
igual("el epígrafe se corta en 1024 (límite de Meta)",
  ((cuerpoImagen("1", URL, "x".repeat(2000))?.image as Record<string, unknown>).caption as string).length, 1024);
igual("un link http (no https) no se manda", cuerpoImagen("1", "http://ejemplo.com/a.jpg", "x"), null);
igual("un nombre de archivo suelto no se manda (el pozo de products.images)", cuerpoImagen("1", "514E.webp", "x"), null);
igual("link vacío no se manda", cuerpoImagen("1", "", "x"), null);
igual("historial con epígrafe, igual que las fotos del webhook", historialImagen(URL, "Foto del 505"), "[Imagen] Foto del 505");
igual("historial sin epígrafe muestra el link", historialImagen(URL, ""), `[Imagen] ${URL}`);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
