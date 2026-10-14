// Pruebas de supabase/functions/_shared/pedidos-sin-pendiente.ts (Pablo Olejavetzky, 14/10/2026, P5, casos mp03 y mp06).
// Sin red. Correr: deno run tests/pedidos-sin-pendiente.test.ts   (sale con código 1 si algo falla)
import { conAvisoSinPendiente, NOTA_SIN_PENDIENTE } from "../supabase/functions/_shared/pedidos-sin-pendiente.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const retirado = { indice: 1, fecha: "30/09", estado: "entregado" };
const viejo = { indice: 2, fecha: "02/09", estado: "entregado" };
const programado = { indice: 1, fecha: "13/10", estado: "programado" };

igual("todos salieron: lista con la indicación", conAvisoSinPendiente([retirado, viejo]), { pedidos: [retirado, viejo], ninguno_pendiente: true, indicacion: NOTA_SIN_PENDIENTE });
igual("uno pendiente: la lista tal cual", conAvisoSinPendiente([programado, retirado]), [programado, retirado]);
igual("sin estado cuenta como pendiente (recibido)", conAvisoSinPendiente([{ indice: 1 }]), [{ indice: 1 }]);
igual("lista vacía: tal cual", conAvisoSinPendiente([]), []);
igual("la indicación pide el listado y no derivar", /pasale este listado/.test(NOTA_SIN_PENDIENTE) && /NO derives/.test(NOTA_SIN_PENDIENTE) && /pedido_no_encontrado/.test(NOTA_SIN_PENDIENTE), true);
igual("el listado va sin importes y pregunta sólo cuál (Haiku 14/10 los mezclaba)", /sin importes/.test(NOTA_SIN_PENDIENTE) && /preguntale s[oó]lo cu[aá]l es/.test(NOTA_SIN_PENDIENTE), true);
igual("sin punto y coma (se escribe por execute_sql en otros lados) ni backticks", /[;`]/.test(NOTA_SIN_PENDIENTE), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
