// Pruebas de supabase/functions/_shared/respaldo-texto.ts (Pablo Olejavetzky, 07/10/2026): cuando el modelo termina el turno sin texto, el respaldo depende de si se derivó.
// Sin red. Correr: deno run --allow-env tests/respaldo-texto.test.ts   (sale con código 1 si algo falla)
import { cierreSinTerminar, RESPALDO_DERIVADO, RESPALDO_SIN_TERMINAR, RESPALDO_SIN_TEXTO, textoDeRespaldo } from "../supabase/functions/_shared/respaldo-texto.ts";
import { sinCierreGenerico } from "../supabase/functions/_shared/cierre.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const ok = JSON.stringify({ ok: true, mensaje: "Listo: quedó derivado. Decile al cliente que una persona del equipo le escribe por acá." });
const error = JSON.stringify({ error: "Este tema lo responde el bot: no lo derives. Resolvelo con las herramientas de consulta y la información que tenés." });

igual("el texto aprobado por Pablo", RESPALDO_DERIVADO, "Gracias por avisarnos. Una persona del equipo te escribe por acá. 🙏");
igual("el de siempre no cambia", RESPALDO_SIN_TEXTO, "Contame un poco más tu consulta así te ayudo.");
igual("sin herramientas: el de siempre", textoDeRespaldo([]), RESPALDO_SIN_TEXTO);
igual("derivó con éxito: el de derivación", textoDeRespaldo([{ nombre: "derivar_a_persona", resultado: ok }]), RESPALDO_DERIVADO);
igual("m7: consultó los pedidos y derivó", textoDeRespaldo([{ nombre: "consultar_mis_pedidos", resultado: "{}" }, { nombre: "derivar_a_persona", resultado: ok }]), RESPALDO_DERIVADO);
igual("derivó a Cobranzas (con datos_cobranzas): el de derivación", textoDeRespaldo([{ nombre: "derivar_a_persona", resultado: JSON.stringify({ ok: true, mensaje: "Listo: quedó derivado a Cobranzas.", datos_cobranzas: {} }) }]), RESPALDO_DERIVADO);
igual("derivar_a_persona con error (lo responde el bot): no derivó", textoDeRespaldo([{ nombre: "derivar_a_persona", resultado: error }]), RESPALDO_SIN_TEXTO);
igual("sólo consultó los pedidos: el de siempre", textoDeRespaldo([{ nombre: "consultar_mis_pedidos", resultado: "{\"pedidos\":[]}" }]), RESPALDO_SIN_TEXTO);
igual("otra herramienta con ok:true no cuenta", textoDeRespaldo([{ nombre: "solicitar_nueva_sucursal", resultado: ok }]), RESPALDO_SIN_TEXTO);
igual("el filtro de cierres no toca el texto de derivación", sinCierreGenerico(RESPALDO_DERIVADO), RESPALDO_DERIVADO);
igual("ni en un turno de pedido", sinCierreGenerico(RESPALDO_DERIVADO, true), RESPALDO_DERIVADO);

// Pablo, 08/10: 5 vueltas sin contestar → pasa a una persona (salvo que ya se haya derivado en el turno), sin pedirle que reformule.
igual("5 vueltas buscando: deriva y avisa que le escriben", cierreSinTerminar([{ nombre: "buscar_productos", resultado: "{}" }]), { texto: RESPALDO_SIN_TERMINAR, derivar: true });
igual("5 vueltas pero ya derivó bien: no deriva de nuevo", cierreSinTerminar([{ nombre: "derivar_a_persona", resultado: ok }]).derivar, false);
igual("5 vueltas y la derivación dio error: deriva", cierreSinTerminar([{ nombre: "derivar_a_persona", resultado: error }]).derivar, true);
igual("el texto no le pide al cliente que reformule", /reformul/i.test(RESPALDO_SIN_TERMINAR), false);
igual("el filtro de cierres no toca ese texto", sinCierreGenerico(RESPALDO_SIN_TERMINAR), RESPALDO_SIN_TERMINAR);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
