// Pruebas de decidirPromocion (_shared/plantillas-version.ts): cuándo templates_promover activa una versión nueva de una plantilla.
// Pablo Olejavetzky, 13/10/2026: "Si es marketing, quedate con la vieja". Sin red, sin IA.
// Correr: deno run tests/plantillas-version.test.ts   (sale con código 1 si algo falla)
const { decidirPromocion } = await import("../supabase/functions/_shared/plantillas-version.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${JSON.stringify(real)}\n   esperado: ${JSON.stringify(esperado)}`); }
}

igual("en revisión: espera", decidirPromocion("PENDING", "UTILITY", "UTILITY"), "esperar");
igual("rechazada: espera (no se activa)", decidirPromocion("REJECTED", "UTILITY", "UTILITY"), "esperar");
igual("no existe en Meta: espera", decidirPromocion("NO_EXISTE", null, "UTILITY"), "esperar");
igual("aprobada como UTILITY: se activa (caso del 13/10: las 3 formales)", decidirPromocion("APPROVED", "UTILITY", "UTILITY"), "promover");
igual("aprobada pero MARKETING con la vieja UTILITY: sigue la vieja", decidirPromocion("APPROVED", "MARKETING", "UTILITY"), "descartar_marketing");
igual("categoría en minúscula también cuenta", decidirPromocion("APPROVED", "marketing", "utility"), "descartar_marketing");
igual("la vieja ya era MARKETING: se activa igual (no empeora el costo)", decidirPromocion("APPROVED", "MARKETING", "MARKETING"), "promover");
igual("sin dato de la vieja y nueva MARKETING: sigue la vieja", decidirPromocion("APPROVED", "MARKETING", null), "descartar_marketing");
igual("nueva UTILITY y vieja MARKETING: se activa (baja el costo)", decidirPromocion("APPROVED", "UTILITY", "MARKETING"), "promover");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
else console.log("\ntodo bien");
