// Pruebas de cómo se presenta el bot cuando le preguntan qué es (supabase/functions/_shared/presentacion.ts, faq.ts y la regla PRESENTACIÓN de agente-fijos.ts). Sin red.
// Pablo Olejavetzky y Damián, 08/10/2026 (Chef 411, 09:42): «Vos sos un bote, un agente o una persona» salía con «Le paso tu mensaje a un asesor» (FAQ #33 por la palabra
// «una persona») y una alerta, y después la IA decía «Sí, soy un bot 😄». Damián: presentarse como un agente especializado en la relación comercial. Pablo: «Si hacelo».
// Correr: deno run --allow-env --allow-read tests/faq-presentacion.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { preguntaQueEs, TEXTO_PRESENTACION } = await import("../supabase/functions/_shared/presentacion.ts");
const { handleFaq, pideClave } = await import("../supabase/functions/_shared/faq.ts");
const { reglasOperativas } = await import("../supabase/functions/_shared/agente-fijos.ts");
const { mensajeCompuesto } = await import("../supabase/functions/_shared/mensaje-compuesto.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

igual("el texto que aprobó Pablo", TEXTO_PRESENTACION,
  "Soy el agente de Loekemeyer, especializado en tu cuenta: te ayudo con tus pedidos, tus compras, tus facturas, el stock y los productos que te pueden servir. " +
  "Si algo necesita a una persona del equipo, le aviso y te escribe por acá.");
igual("el texto no dice que es una persona ni que es un bot", /\b(soy una persona|soy humano|bot)\b/i.test(TEXTO_PRESENTACION), false);

// Pregunta qué es: los de Damián y otras formas.
for (const t of [
  "Vos Sos un bote, un agente o una persona", "Te preguntaba si lo que me respondió hasta ahora es un boot, o un agente", "¿Sos un bot?", "sos un robot?",
  "¿Estoy hablando con una persona?", "¿Sos una persona o una máquina?", "¿Eres una IA?", "¿Sos humano?", "Che, ¿es un bot esto?", "¿Sos bot o persona?",
]) igual(`pregunta qué es: ${t}`, preguntaQueEs(t), true);

// No: pedir hablar con una persona (eso sigue en la FAQ #33), otra cosa con «persona», un elogio, o sólo la palabra.
for (const t of [
  "Quiero hablar con una persona", "¿Puedo hablar con una persona?", "Pasame con un humano", "¿Es una persona la que me va a llamar?", "Sos un genio",
  "Boot", "Quise decir", "Vos sos un robot jaja", "Necesito un vendedor", "¿Quién es mi agente de ventas?", "Hola, buen día", "¿Cuándo sale mi pedido?",
]) igual(`no pregunta qué es: ${t}`, preguntaQueEs(t), false);

// handleFaq (cliente falso, sin red): el texto, sin alerta.
const cliente = { id: "x", cod_cliente: 411, business_name: "Prueba", dto_vol: 0 };
const r = await handleFaq("Vos Sos un bote, un agente o una persona", cliente);
igual("cliente: contesta la presentación", r?.reply, TEXTO_PRESENTACION);
igual("cliente: sin alerta ni derivación", [r?.alerta ?? null, r?.automation_level], [null, "full_auto"]);
igual("«¿sos un bot?» no es un mensaje compuesto", mensajeCompuesto("Vos Sos un bote, un agente o una persona"), false);
igual("la clave de la web sigue antes («¿sos un bot? pasame la clave»)", pideClave("¿Sos un bot? Pasame la clave de la web"), true);

// La regla del agente (para cuando lo pregunta de otra forma o dentro de otra charla).
for (const [modo, txt] of [["con pedidos por WhatsApp", reglasOperativas(true)], ["sin pedidos por WhatsApp", reglasOperativas(false)]] as const) {
  igual(`${modo}: la regla está, una sola línea`, txt.split("\n").filter((l) => l.startsWith("- PRESENTACIÓN (Pablo y Damián, 08/10)")).length, 1);
  igual(`${modo}: con el texto aprobado`, txt.includes(`respondé: «${TEXTO_PRESENTACION}»`), true);
  igual(`${modo}: nunca dice que es una persona y no deriva por la pregunta`,
    txt.includes("Nunca digas ni insinúes que sos una persona") && txt.includes("no derives por ella"), true);
  igual(`${modo}: sin backticks`, txt.includes("`"), false);
}

// Guardas sobre el código: la regla fija va después de la clave y la FAQ #33 se saltea con esta pregunta (no clientes).
const src = await Deno.readTextFile(new URL("../supabase/functions/_shared/faq.ts", import.meta.url));
igual("la presentación va después de la clave de la web", src.indexOf("if (pideClave(text))") < src.indexOf("if (customer && preguntaQueEs(text))"), true);
igual("la FAQ #33 no contesta «¿sos una persona?»", src.includes('if (top.category === "contacto_vendedor" && preguntaQueEs(text)) return null;'), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
