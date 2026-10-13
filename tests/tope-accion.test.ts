// Pruebas de los topes por acción (supabase/functions/_shared/tope-accion.ts). Sólo la parte pura: los números,
// el mensaje y el contexto de la alerta. El contador vive en la base (bot_accion_tope, sql/142) y no se prueba acá.
// Sin red, sin IA. Correr: deno run tests/tope-accion.test.ts   (sale con código 1 si algo falla)
import { contextoTopeAccion, MSG_TOPE_ACCION, TOPES_ACCION } from "../supabase/functions/_shared/tope-accion.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Las 5 acciones que le dan trabajo a una persona o cargan algo tienen tope.
igual("topea las 5 acciones esperadas", Object.keys(TOPES_ACCION).sort(),
  ["armar_pedido", "confirmar_pedido", "derivar_a_persona", "solicitar_agregado_pedido", "solicitar_nueva_sucursal"]);

// Todos los límites son enteros positivos (un 0 bloquearía la acción siempre).
igual("todos los límites son enteros > 0",
  Object.values(TOPES_ACCION).filter((n) => !Number.isInteger(n) || n <= 0), []);

// Una consulta (no es acción) NO está topeada acá: la cubre el tope de 20/h.
igual("consultar_mis_pedidos no tiene tope de acción", TOPES_ACCION["consultar_mis_pedidos"], undefined);

// El mensaje al cliente no filtra nada interno (sin nombres de tablas, herramientas ni teléfonos).
igual("el mensaje al cliente no nombra herramientas ni tablas",
  /wa_|bot_|derivar_a_persona|armar_pedido|tope/i.test(MSG_TOPE_ACCION), false);

// El contexto de la alerta lleva el motivo fijo y nombra la acción y el límite.
const ctx = contextoTopeAccion("derivar_a_persona", 8);
igual("el contexto de la alerta tiene motivo tope_accion", ctx.motivo, "tope_accion");
igual("el detalle nombra la acción y el límite",
  /derivar_a_persona/.test(String(ctx.detalle)) && /8/.test(String(ctx.detalle)), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
