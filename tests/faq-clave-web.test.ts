// Pruebas de cuándo un cliente PIDE la clave de la web (supabase/functions/_shared/faq.ts, pideClave) y de cómo se arma y se
// tapa el mensaje con los datos de acceso (_shared/clave-web.ts). Sin red.
// Pablo Olejavetzky y Thomy, 07/10/2026: teléfono agendado → usuario (CUIT) + clave (el PIN de customers), sin generar una nueva.
// No agendado → no se da. El PIN lo pone el webhook al mandar: handleFaq devuelve el texto tapado.
// Correr: deno run --allow-env tests/faq-clave-web.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { pideClave } = await import("../supabase/functions/_shared/faq.ts");
const { taparClave, textoAccesoWeb, TEXTO_ACCESO_TAPADO, TEXTO_CLAVE_NO_AGENDADO } = await import("../supabase/functions/_shared/clave-web.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// La pide (o no puede entrar): las 10 que ya agarraba RE_CLAVE y las 8 que se escapaban el 07/10.
for (const t of [
  "me olvidé la contraseña", "cual es mi contraseña?", "no me acuerdo la clave", "pasame la clave de la pagina", "necesito la contraseña",
  "no puedo entrar a la web", "hola, quería saber la contraseña", "no me deja ingresar", "cambié de celular y no tengo la clave",
  "Olvidé mi usuario",
  // las 8 que se escapaban
  "me podés pasar la contraseña?", "me das la contraseña", "contraseña?", "la clave para entrar a la web porfa", "me mandás la clave?",
  "no me anda la contraseña", "me podrías enviar usuario y contraseña", "me reenviás la contraseña?",
  // otras formas
  "Hola, la clave?", "Buen día, me pasan la clave de la web por favor", "No me toma la clave", "Necesito usuario y clave para hacer el pedido",
  "Me pueden generar una clave nueva?", "Quiero cambiar la contraseña", "cambié la contraseña y ahora no me deja entrar",
  "no pude entrar a la web", "La contraseña no me funciona", "Me bloqueó el usuario", "no me deja entrar a la web para cargar el pedido del 512",
]) igual(`la pide: ${t}`, pideClave(t), true);

// No la pide: otra clave (ARCA, CBU, home banking), ya la tiene, "clave" como adjetivo, problema de sucursal u otra consulta.
for (const t of [
  "no tengo la clave fiscal", "¿me pasás la clave fiscal?", "pasame el CBU", "¿cuál es la clave bancaria uniforme?", "no me anda el home banking",
  "ya pude entrar, gracias", "ya cambié la contraseña", "ahora sí anda la clave, gracias", "gracias por la clave", "listo, ya entré",
  "es clave que llegue el lunes", "quiero aclarar algo clave del pedido",
  "no me deja elegir la sucursal", "el usuario no me deja elegir la sucursal",
  "Hola", "Quiero 5 cajas del 512", "¿Me pasás la lista de precios?", "¿Cuándo llega mi pedido?", "me bloqueó la página",
]) igual(`no la pide: ${t}`, pideClave(t), false);

// El mensaje: usuario y clave en líneas propias, y la clave tapada en el historial.
const msg = textoAccesoWeb("20123456789", "4815162");
igual("mensaje: usuario", msg.includes("Usuario: 20123456789"), true);
igual("mensaje: clave", msg.includes("Clave: 4815162"), true);
igual("tapada: sin el PIN", taparClave(msg).includes("4815162"), false);
igual("tapada: con el usuario", taparClave(msg).includes("Usuario: 20123456789"), true);
igual("tapada: igual a la de handleFaq salvo el usuario", taparClave(msg).replace("20123456789", "tu CUIT"), TEXTO_ACCESO_TAPADO);
// Lo que ven el Simulador y el chat de prueba nunca trae dígitos de un PIN.
igual("handleFaq devuelve el texto sin números", /\d/.test(TEXTO_ACCESO_TAPADO), false);
igual("no agendado: no da clave", /Clave:/.test(TEXTO_CLAVE_NO_AGENDADO), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
