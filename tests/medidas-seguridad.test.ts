// Pruebas de la tabla de medidas de seguridad que muestra el Panel (supabase/functions/_shared/agente-fijos.ts › MEDIDAS_SEGURIDAD).
// Sin red, sin IA. Correr: deno run tests/medidas-seguridad.test.ts   (sale con código 1 si algo falla)
import { fijosParaPanel, MEDIDAS_SEGURIDAD } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

igual("todas tienen medida, que_hace, donde y un estado válido",
  MEDIDAS_SEGURIDAD.filter((m) => !m.medida.trim() || !m.que_hace.trim() || !m.donde.trim() || !["activa", "pendiente"].includes(m.estado)).map((m) => m.medida), []);
igual("no hay dos medidas con el mismo nombre", new Set(MEDIDAS_SEGURIDAD.map((m) => m.medida)).size, MEDIDAS_SEGURIDAD.length);
igual("hay activas y pendientes", [MEDIDAS_SEGURIDAD.some((m) => m.estado === "activa"), MEDIDAS_SEGURIDAD.some((m) => m.estado === "pendiente")], [true, true]);
const estados = MEDIDAS_SEGURIDAD.map((m) => m.estado);
igual("las activas van antes que las pendientes", estados.lastIndexOf("activa") < estados.indexOf("pendiente"), true);
igual("el Panel recibe la misma lista", fijosParaPanel().medidas, MEDIDAS_SEGURIDAD);
igual("la compuerta de confirmar_pedido figura como activa", MEDIDAS_SEGURIDAD.find((m) => m.medida === "Compuerta de confirmar_pedido")?.estado, "activa");
igual("la compuerta de solicitar_cambio_mail figura como activa", MEDIDAS_SEGURIDAD.find((m) => m.medida === "Compuerta de solicitar_cambio_mail")?.estado, "activa");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
