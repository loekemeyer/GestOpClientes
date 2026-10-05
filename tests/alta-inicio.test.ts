// Pruebas de cuándo un no-cliente arranca el alta (supabase/functions/_shared/alta.ts). Sin red, sin IA, US$ 0.
// Correr: deno run --allow-env tests/alta-inicio.test.ts   (sale con código 1 si algo falla)
// alta.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
// Base simulada: toda lectura devuelve [] y toda escritura 201; se anotan las llamadas para ver qué habría escrito el flujo.
const llamadas: Array<{ metodo: string; url: string; body: string }> = [];
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const get = req.method === "GET";
  llamadas.push({ metodo: req.method, url: req.url, body: get ? "" : await req.clone().text() });
  return new Response(get ? "[]" : "", { status: get ? 200 : 201, headers: { "content-type": "application/json" } });
}) as typeof fetch;
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { ALTA_INTRO, atenderNoCliente, MSG_CUIT_INVALIDO, RE_ALTA_START, esAfirmacion, iniciaAlta, MSG_NO_CLIENTE, validaCuit } = await import("../supabase/functions/_shared/alta.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// Lo que dijo el bot en cada caso: el saludo de un no-cliente (wa_faq saludo_inicial, sql/053), el "no te tengo" y otros.
const SALUDO = "¡Hola! 👋 No te tengo registrado como cliente. Decime si querés que te registre —así podés ver precios y hacer pedidos— o si tenés alguna consulta en la que te pueda ayudar.";
const PIDE_CUIT = "Encontré la cuenta de *Chef S.R.L.*. 👍\n\nPor seguridad, un asesor tiene que confirmar que este número es de la empresa antes de vincularlo.";

// ── Pedir ser cliente con palabras propias (el primer mensaje de la captura del 05/10) ──
for (const t of ["Hola me gustaria ser cliente", "Hola, me gustaría ser cliente", "quisiera ser cliente", "me interesa ser cliente",
  "¿Cómo hago para ser cliente?", "quiero hacerme cliente", "quiero que me registren", "necesitamos que nos den de alta", "quiero solicitar el alta",
  // los que ya andaban no se rompen
  "Si, registrame por favor", "quiero ser cliente", "soy nuevo", "no soy cliente", "darme de alta", "quiero abrir una cuenta", "somos distribuidora"])
  igual(`pide alta: ${t}`, RE_ALTA_START.test(t), true);

// ── Quien ya es cliente o pregunta otra cosa NO arranca el alta ──
for (const t of ["Hola", "Buen día", "¿Cuándo llega mi pedido?", "Tengo una consulta", "ya soy cliente", "soy cliente de Chef", "quiero ver mi pedido",
  "necesito la factura", "cuenta corriente", "quiero dejar de recibir mensajes", "me pasás el precio del 501"])
  igual(`no es alta: ${t}`, RE_ALTA_START.test(t), false);

// ── Afirmación corta ──
for (const t of ["Sí", "si", "Sí, por favor", "dale", "Dale!", "bueno dale", "de una", "Si quiero", "ok", "Sí, registrame por favor", "👍", "Claro, sí"])
  igual(`afirma: ${t}`, esAfirmacion(t), true);
for (const t of ["no", "No, gracias", "no quiero", "si pero antes una consulta", "sí, tengo una consulta", "gracias", "por favor", "", "   ", "me gustaría saber el precio",
  "dale, ya te paso el cuit", "sí, pero ahora no", "20-12345678-9"])
  igual(`no afirma: ${JSON.stringify(t)}`, esAfirmacion(t), false);

// ── El "sí" sólo arranca el alta si lo último que dijo el bot fue ofrecer el registro ──
igual("Sí tras el saludo del no-cliente (la captura)", iniciaAlta("Si, dale", SALUDO), true);
igual("Sí a secas tras el saludo", iniciaAlta("Sí", SALUDO), true);
igual("Sí tras el 'no te tengo' (ofrece CUIT o registrarme)", iniciaAlta("Sí", MSG_NO_CLIENTE), true);
igual("Sí sin historial", iniciaAlta("Sí", ""), false);
igual("Sí tras un mensaje que no ofrece registro", iniciaAlta("Sí", PIDE_CUIT), false);
igual("'dale, ya te lo paso' tras 'no te tengo' NO arranca (punto 11 de la auditoría)", iniciaAlta("dale, ya te lo paso", MSG_NO_CLIENTE), false);
igual("'no' tras el saludo", iniciaAlta("No, gracias", SALUDO), false);
igual("pide ser cliente aunque el bot no haya ofrecido nada", iniciaAlta("Hola me gustaria ser cliente", ""), true);

// ── El mensaje de 'no te tengo' deja los dos caminos a la vista ──
igual("MSG_NO_CLIENTE ofrece pasar el CUIT", /\*CUIT\*/.test(MSG_NO_CLIENTE), true);
igual("MSG_NO_CLIENTE ofrece registrarme", /\*registrarme\*/.test(MSG_NO_CLIENTE), true);
igual("MSG_NO_CLIENTE (la palabra que sugiere) arranca el alta", RE_ALTA_START.test("registrarme"), true);

// ── El flujo completo (alta.ts › atenderNoCliente), con la base simulada: la conversación de la captura del 05/10 ──
// La respuesta fija del saludo la pone el test (en producción es handleFaq): contesta a cualquier "hola".
const faqSaludo = async (t: string) => /^\s*hola\b/i.test(t) ? { reply: SALUDO, via: "faq" } : null;
const creoLead = () => llamadas.some((c) => c.metodo === "POST" && c.url.includes("wa_prospect_leads"));
const tel = "5490000000001";

llamadas.length = 0;
let r = await atenderNoCliente(tel, "Hola me gustaria ser cliente", { ultimoBot: "", faq: faqSaludo });
igual("captura, mensaje 1: 'Hola me gustaria ser cliente' arranca el alta (antes: respuesta fija del saludo)", [r.respuestas, r.via], [[ALTA_INTRO], "alta (arranca)"]);
igual("captura, mensaje 1: dejó el lead pendiente", creoLead(), true);

llamadas.length = 0;
r = await atenderNoCliente(tel, "Hola", { ultimoBot: "", faq: faqSaludo });
igual("saludo solo: respuesta fija con la oferta de registro", [r.respuestas, r.via], [[SALUDO], "faq"]);
igual("saludo solo: no crea ningún lead", creoLead(), false);

llamadas.length = 0;
r = await atenderNoCliente(tel, "Si, registrame por favor", { ultimoBot: SALUDO, faq: faqSaludo });
igual("captura, mensaje 2: 'Si, registrame por favor' arranca el alta (antes: 'necesito identificarte')", [r.respuestas, r.via], [[ALTA_INTRO], "alta (arranca)"]);
igual("captura, mensaje 2: dejó el lead pendiente", creoLead(), true);

llamadas.length = 0;
r = await atenderNoCliente(tel, "Sí", { ultimoBot: SALUDO, faq: faqSaludo });
igual("'Sí' a la oferta del saludo arranca el alta", [r.respuestas, r.via], [[ALTA_INTRO], "alta (arranca)"]);
igual("'Sí' a la oferta: dejó el lead pendiente", creoLead(), true);

llamadas.length = 0;
r = await atenderNoCliente(tel, "Sí", { ultimoBot: "", faq: faqSaludo });
igual("'Sí' sin oferta previa: no arranca el alta, dice los dos caminos", [r.respuestas, r.via], [[MSG_NO_CLIENTE], "no cliente"]);
igual("'Sí' sin oferta previa: no crea lead", creoLead(), false);

let dv = 0; while (!validaCuit(`3071234567${dv}`)) dv++;
const cuitOk = `3071234567${dv}`;
llamadas.length = 0;
r = await atenderNoCliente(tel, `Mi CUIT es ${cuitOk}`, { ultimoBot: SALUDO, faq: faqSaludo });
igual("CUIT válido que no es cliente: arranca el alta con el CUIT cargado", [r.via, r.respuestas[0].startsWith("No te encontré como cliente con ese CUIT")], ["alta (arranca con CUIT)", true]);
igual("CUIT válido: el lead lleva el CUIT", llamadas.some((c) => c.metodo === "POST" && c.body.includes(cuitOk)), true);

llamadas.length = 0;
r = await atenderNoCliente(tel, "20123456780000", { ultimoBot: "", faq: faqSaludo });
igual("11+ dígitos que no son CUIT: avisa que no es válido", [r.respuestas, r.via], [[MSG_CUIT_INVALIDO], "CUIT inválido"]);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
