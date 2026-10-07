// Pruebas del detector avisaProspectoSinRespuesta de supabase/functions/_shared/faq.ts (Pablo Olejavetzky, 07/10/2026, corrección m71): un número que no es cliente, interesado en comercializar
// los productos, que escribió por mail y no le respondieron → disculpas y Ventas (en vez de "pasame tu CUIT"). Sin red. Correr: deno run --allow-env tests/faq-prospecto.test.ts
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { avisaProspectoSinRespuesta, handleFaq } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

for (const t of ["Hace un mes nos comunicamos por mail porque estamos interesados en comercializar sus productos. Enviamos el pedido estimativo y no nos respondieron más, ¿qué pasó?",
  "Hola, queremos vender sus productos. Les escribimos por mail hace semanas y nadie nos contestó", "Estamos interesados en revender sus artículos, escribimos y no tuvimos respuesta",
  "Nos interesa trabajar con ustedes, mandamos un mail y sin respuesta hasta ahora"])
  igual(`dispara: ${t.slice(0, 60)}…`, avisaProspectoSinRespuesta(t), true);
for (const t of ["Hola, quiero ser cliente", "Estamos interesados en comercializar sus productos, ¿cómo hacemos?", "No me respondieron el reclamo de la factura", "¿Cuándo llega mi pedido?",
  "No nos respondieron el mail del pedido", "Quiero hacer un pedido", "Hola, buen día"])
  igual(`no dispara: ${t}`, avisaProspectoSinRespuesta(t), false);

// Sólo un número que NO es cliente: handleFaq con customer null responde y deriva; con un cliente no entra por esta rama.
const frase = "Hace un mes nos comunicamos por mail porque estamos interesados en comercializar sus productos. Enviamos el pedido estimativo y no nos respondieron más, ¿qué pasó?";
const r = await handleFaq(frase, null);
igual("no cliente: el texto aprobado por Pablo", r?.reply, "Te pedimos disculpas por la demora en responderte. Le paso tu consulta a Ventas para que te escriban por acá a la brevedad. 🙏");
igual("no cliente: alerta pedido_mail no urgente (Ventas)", [r?.alerta?.motivo, r?.alerta?.urgente], ["pedido_mail", false]);
igual("no cliente: la alerta lleva el mensaje", /^Prospecto sin respuesta: escribió por mail para comercializar sus productos y dice que no le respondieron: Hace un mes/.test(r?.alerta?.detalle ?? ""), true);
igual("no cliente: needs_human", r?.automation_level, "needs_human");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
