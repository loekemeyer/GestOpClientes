// Pruebas de supabase/functions/_shared/mail-facturas.ts (Pablo Olejavetzky, 07/10/2026, corrección m68): "Nos llegó al mail las facturas, ¿lo entregan hoy?" → se pregunta a qué mail
// y se compara con el de la ficha. Módulo puro, sin red. Correr: deno run tests/mail-facturas.test.ts   (sale con código 1 si algo falla)
import { avisaFacturaPorMail, compararMails, mailsEscritos, mailsRegistrados, PREGUNTA_MAIL_FACTURAS, TEXTO_MAIL_COINCIDE, TEXTO_MAIL_NO_COINCIDE, TEXTO_MAIL_SIN_REGISTRO } from "../supabase/functions/_shared/mail-facturas.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── el detector: la frase de m68 sí; lo demás no ──
for (const t of ["Nos llegó al mail las facturas, ¿lo entregan hoy?", "Ya nos llegaron las facturas por mail, ¿cuándo pasan a entregar?", "Recibimos la factura por correo. ¿Mañana retiramos el pedido?",
  "me llegó la factura al mail, ¿cuándo llega la mercadería?"]) igual(`detecta: ${t}`, avisaFacturaPorMail(t), true);
for (const t of ["No me llegó la factura por mail, ¿me la reenvían?", "No nos llegó al mail la factura, ¿cuándo entregan?", "Nos llegó la factura por mail, gracias", "Nos llegó al mail las facturas",
  "¿Me pueden mandar la factura por mail?", "¿Cuándo llega mi pedido?", "Me facturaron el mismo pedido dos veces", "Hola, buen día", "Mi mail es prueba@example.com y quiero saber del pedido"])
  igual(`no detecta: ${t}`, avisaFacturaPorMail(t), false);

// ── los mails que escribe el cliente ──
igual("un mail", mailsEscritos("Nos llegan a Compras@Cliente.com.ar"), ["compras@cliente.com.ar"]);
igual("dos mails, repetido uno", mailsEscritos("ventas@x.com y compras@x.com, ventas@X.com"), ["ventas@x.com", "compras@x.com"]);
igual("sin mail", mailsEscritos("no sé a cuál"), []);
igual("mail con punto final de la oración", mailsEscritos("Es info@cliente.com."), ["info@cliente.com"]);

// ── los mails de la ficha (coma, punto y coma, espacios, mayúsculas, sin arroba) ──
igual("ficha con uno", mailsRegistrados("Compras@Cliente.com.ar"), ["compras@cliente.com.ar"]);
igual("ficha con varios separados por coma y punto y coma", mailsRegistrados("a@x.com; b@x.com, c@x.com"), ["a@x.com", "b@x.com", "c@x.com"]);
igual("ficha con espacios", mailsRegistrados("  a@x.com   b@x.com "), ["a@x.com", "b@x.com"]);
igual("ficha sin arroba (16 de 1.263): no cuenta", mailsRegistrados("sin mail"), []);
igual("ficha vacía / null / undefined", [mailsRegistrados(""), mailsRegistrados(null), mailsRegistrados(undefined)], [[], [], []]);
igual("ficha con punto final", mailsRegistrados("a@x.com."), ["a@x.com"]);

// ── la comparación ──
igual("coincide", compararMails(["a@x.com"], ["a@x.com", "b@x.com"]), { tipo: "coincide" });
igual("coincide con varios dichos, todos en la ficha", compararMails(["a@x.com", "b@x.com"], ["a@x.com", "b@x.com"]), { tipo: "coincide" });
igual("no coincide", compararMails(["z@y.com"], ["a@x.com"]), { tipo: "no_coincide", distintos: ["z@y.com"] });
igual("uno de dos no está: no coincide, con el que falta", compararMails(["a@x.com", "z@y.com"], ["a@x.com"]), { tipo: "no_coincide", distintos: ["z@y.com"] });
igual("ficha sin mail: sin registro (no dice 'no coincide')", compararMails(["a@x.com"], []), { tipo: "sin_registro" });

// ── los textos aprobados por Pablo (opción A) ──
igual("la pregunta", PREGUNTA_MAIL_FACTURAS, "¿A qué mail te llegaron las facturas? Lo chequeo.");
igual("coincide: texto", TEXTO_MAIL_COINCIDE, "Perfecto, es el mismo que tenemos registrado.");
igual("no coincide: texto", TEXTO_MAIL_NO_COINCIDE, "Ese mail no coincide con el que tenemos registrado. Una persona de Ventas lo revisa y te escribe por acá.");
igual("sin registro: texto (el de la opción B)", TEXTO_MAIL_SIN_REGISTRO, "Gracias, se lo paso a Ventas para que lo chequee.");
igual("ningún texto de respuesta muestra un mail", [TEXTO_MAIL_COINCIDE, TEXTO_MAIL_NO_COINCIDE, TEXTO_MAIL_SIN_REGISTRO].some((x) => x.includes("@")), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
