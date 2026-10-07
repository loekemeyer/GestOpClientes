// Pruebas de supabase/functions/_shared/formas-pago.ts (Pablo Olejavetzky, 07/10/2026, corrección m12): las formas de pago se muestran numeradas 1, 2, 3… sin los códigos internos
// (8, 9, 10…) y sin "Prefiero no decidir ahora". Módulo puro, sin red. Correr: deno run tests/formas-pago.test.ts   (sale con código 1 si algo falla)
import { CODIGOS_FORMA_DE_PAGO, formasDePago } from "../supabase/functions/_shared/formas-pago.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const todas = formasDePago(false);
igual("seis opciones, numeradas 1 a 6, con los textos del 06/10 y el código interno aparte", todas, [
  { opcion: 1, texto: "Contado (25% de descuento)", condicion_code: 8 }, { opcion: 2, texto: "15 a 30 días (20%)", condicion_code: 9 },
  { opcion: 3, texto: "31 a 45 días (15%)", condicion_code: 10 }, { opcion: 4, texto: "46 a 60 días (10%)", condicion_code: 11 },
  { opcion: 5, texto: "E-cheq a 90 días (5%)", condicion_code: 12 }, { opcion: 6, texto: "E-cheq a 120 días (sin descuento)", condicion_code: 13 },
]);
igual("no ofrece 'Prefiero no decidir ahora' (código 18)", todas.some((f) => f.condicion_code === 18 || /decidir/i.test(f.texto)), false);
igual("el 18 se sigue aceptando en armar_pedido si el cliente lo pide", CODIGOS_FORMA_DE_PAGO.includes(18), true);
igual("ningún texto lleva el código interno delante", todas.some((f) => /^\d+\s*[-–.]/.test(f.texto)), false);
igual("la numeración es 1..n sin saltos", todas.map((f) => f.opcion), [1, 2, 3, 4, 5, 6]);
igual("cuenta sólo de contado: una opción, la 1, con el código 8", formasDePago(true), [{ opcion: 1, texto: "Contado (25% de descuento)", condicion_code: 8 }]);
igual("todos los códigos que se ofrecen son aceptados por armar_pedido", todas.every((f) => (CODIGOS_FORMA_DE_PAGO as readonly number[]).includes(f.condicion_code)), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
