// Pruebas del detector avisaNotaDeCreditoPendiente de supabase/functions/_shared/faq.ts (Pablo Olejavetzky, 07/10/2026, corrección m67): "Todavía no recibí las NC" → respuesta fija y alerta para Ventas
// (antes la IA repreguntaba de qué fecha eran). Sin red. Correr: deno run --allow-env tests/faq-nc-pendiente.test.ts
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { avisaNotaDeCreditoPendiente, handleFaq } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

for (const t of ["Hola, ¿cómo están? Todavía no recibí las NC 🙁", "No me llegó la nota de crédito", "Todavía no nos llegaron las notas de crédito", "Seguimos esperando las NC del faltante",
  "Estoy esperando la nota de crédito", "Falta la NC de las 4 cajas", "¿Cuándo me mandan la nota de crédito?", "Tengo una NC pendiente, ¿la pueden revisar?", "Aún no veo las NC en mi cuenta"])
  igual(`dispara: ${t}`, avisaNotaDeCreditoPendiente(t), true);
for (const t of ["Llegaron 59 aceiteras de 60, pido la NC", "Necesito la nota de crédito por el faltante", "Quiero que me hagan una NC", "Te mando la NC", "No me llegó la factura", "Todavía no recibí el pedido",
  "¿Cuánto debo pagar?", "Hola, buen día", "Tengo un faltante en el remito, código 323E 4 cajas", "¿Me aplican la nota de crédito en la próxima factura?"])
  igual(`no dispara: ${t}`, avisaNotaDeCreditoPendiente(t), false);

// handleFaq (cliente falso): el texto, la alerta y que no pise al faltante que PIDE la NC.
const cliente = { customer_id: "x", cod_cliente: 1, business_name: "Prueba", dto_vol: 0 };
const r = await handleFaq("Hola, ¿cómo están? Todavía no recibí las NC 🙁", cliente);
igual("el texto", r?.reply, "Gracias por avisarnos. Una persona de Ventas revisa tus notas de crédito y te escribe por acá para confirmarte. 🙏");
igual("alerta nota_cliente no urgente (Ventas)", [r?.alerta?.motivo, r?.alerta?.urgente], ["nota_cliente", false]);
igual("la alerta lleva el mensaje", /^Pregunta por notas de crédito que todavía no recibió: Hola, ¿cómo están\?/.test(r?.alerta?.detalle ?? ""), true);
igual("needs_human", r?.automation_level, "needs_human");
const f = await handleFaq("Llegaron 59 aceiteras de 60, pido la NC", cliente);
igual("el faltante que pide la NC sigue pidiendo la factura", f?.intent, "faltante");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
