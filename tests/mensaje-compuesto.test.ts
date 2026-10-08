// Pruebas de cuándo un mensaje pide varias cosas o repite una respuesta fija (supabase/functions/_shared/mensaje-compuesto.ts) y de cómo lo usa la capa
// fija (faq.ts: handleFaq devuelve null con un mensaje compuesto). Sin red.
// Pablo Olejavetzky, 08/10/2026 (Chef 411, tres audios a las 09:32): "Quería saber cuándo sale mi pedido y si podés tener 200 docenas de artículo 505 de
// entrega inmediata" salió con "Ventas revisa si se puede acelerar la entrega", y "¿Tenés hieleras? … Y del 505, cuántas unidades hay por caja" con la
// lista de precios en la web, el mismo texto de 24 s antes. "Tiene que tener una respuesta más natural, tenés que entender mejor todo el contexto."
// Correr: deno run --allow-env --allow-read tests/mensaje-compuesto.test.ts   (sale con código 1 si algo falla)
// faq.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const mc = await import("../supabase/functions/_shared/mensaje-compuesto.ts");
const { handleFaq } = await import("../supabase/functions/_shared/faq.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── Los tres mensajes de Chef 411 ────────────────────────────────────────────────────────────────────────────────
const M1 = "Pasame el precio, por favor.";
const M2 = "Hola, buen día. Quería saber cuándo sale mi pedido y si podés tener 200 docenas de artículo 505 de entrega inmediata.";
const M3 = "¿Tenés hieleras? Estoy necesitando una hielera. Si tenés hieleras, decime y pasame precio. Y del 505, quiero saber cuántas unidades hay por caja.";
igual("Chef 1: un solo pedido", mc.mensajeCompuesto(M1), false);
igual("Chef 2: compuesto (estado del pedido + stock del 505)", mc.pedidosDelMensaje(M2),
  ["Quería saber cuándo sale mi pedido", "si podés tener 200 docenas de artículo 505 de entrega inmediata"]);
igual("Chef 3: compuesto (hieleras, precio, unidades por caja)", mc.pedidosDelMensaje(M3).length, 5);
igual("Chef 3: la última parte es la del 505", mc.pedidosDelMensaje(M3).at(-1), "del 505, quiero saber cuántas unidades hay por caja");

// ── Otros compuestos ─────────────────────────────────────────────────────────────────────────────────────────────
for (const t of [
  "Quería saber el precio del 505 y si hay stock",
  "¿Cuándo llega mi pedido? Y pasame el alias para transferir",
  "Te paso el comprobante, además quería saber cuándo sale el pedido",
  "¿Tienen coladores? ¿Cuánto sale la caja del 501?",
  "Necesito la factura del pedido del 25/09. ¿Me pasás el CBU?",
]) igual(`compuesto: ${t}`, mc.mensajeCompuesto(t), true);

// ── Un solo pedido aunque tenga varias oraciones o preguntas: NO es compuesto ─────────────────────────────────────
// Todas las consultas del artifact "Respuestas del bot por causa" (wa_agente_evals, leídas el 08/10) que contesta la capa fija, más las de una sola consulta.
for (const t of [
  "¿Sabés cuándo me entregan el pedido?", "Hace 10 días hice un pedido, quería saber el estado", "¿Hoy entregan el pedido?",
  "En el caso que se confirme, ¿hay posibilidades de entrega rápida?", "Quería consultar qué período de tiempo están contemplando actualmente para entregas",
  "Paso un pedidito. ¿Puede estar para el viernes?", "Pasé por mail un pedido para un cliente pero me vino dos veces rechazado. ¿Te llegó a vos?",
  "Anulá todo el pedido", "Apreté confirmar varias veces pero es un solo pedido", "El jueves lo retiro", "¿Mañana puedo pasar a retirar?",
  "¿En qué horario cierran para almorzar?", "Estoy llegando, ¿me esperan?", "Llegaron 59 aceiteras de 60, pido la NC", "Tengo un faltante en el remito, código 323E 4 cajas",
  "No me llegó la factura, ¿me la mandás por acá?", "En las últimas facturas no veo el descuento que siempre tuvimos", "Me facturaron el mismo pedido dos veces",
  "Hola, ¿cómo están? Todavía no recibí las NC 🙁", "Vamos a devolver unas cucharas que no pedimos, es el código 208 y son 48 unidades",
  "Nos llegó al mail las facturas, ¿lo entregan hoy?", "¿Son estas cuatro facturas? ¿Cuánto debo pagar? El total de estas cuatro facturas es lo que debo pagar, ¿verdad?",
  "Me pasás el cotizador actualizado", "¿Sigue vigente la lista de septiembre 2025?", "Te consulto, ¿me dirías el precio de lista? Me refiero al automate",
  "Adjunto comprobante de pago", "¿Recibieron el pago?", "Hola, ¿se podrá efectuar el pago el próximo viernes?", "¿Me pasás el CBU o alias?",
  "Buen día, ¿me pasás la factura así podemos abonar?", "Hice un pedido hace 10 días, quería saber si está confirmado", "¿Tienen tostadores enlozados en stock?",
  "Ya soy cliente y quiero saber mi contraseña", "Me dice que el CUIT o contraseña son incorrectos", "No me deja seleccionar la sucursal",
  "¿Puedo hacer el pedido directo de la web? ¿Mismos precios, mismo todo?", "¿Cuál es el mínimo de compra?", "Los coladores de fideos vinieron todos rotos",
  "Vinieron 7 unidades rotas, están para que las retiren", "Cuando entregan?", "Te llegó mi pedido?", "No recuerdo la contraseña para cargar el pedido",
  "Adjunto orden de compra, quedo a la espera de confirmación de recepción", "Cargué todo por unidad y después lo edité por caja",
  "Por favor recuerden que recibimos hasta las 14 hs, por lo que deben llegar un ratito antes", "¿Hay forma de pasarla a Excel?",
  // continúa el mismo pedido con un pronombre
  "Buenas tardes, quería hacer otra consulta sobre mi pedido, que no me llegó la factura y necesito que me la manden por mail",
  // saludo con pregunta + una consulta
  "Buenas tardes, ¿cómo va? ¿Tenés stock del 505?", "Hola, ¿qué tal? Quería saber el estado del pedido", "Quería también saber el precio del 505",
  M1,
]) igual(`un solo pedido: ${t}`, mc.mensajeCompuesto(t), false);

// ── No repetir una respuesta fija ─────────────────────────────────────────────────────────────────────────────────
const LISTA = "La lista de precios vigente está en la web, con catálogo y novedades:\n\n🔗 loekemeyer.com | chefsrl.com\n\nEntrá desde \"Pedidos Mayorista\" con tu CUIT y contraseña.";
igual("ya la dijo (con el saludo delante)", mc.yaLoDijo(LISTA, ["¡Hola Chef S.R.L.! 👋\n\n" + LISTA]), true);
igual("ya la dijo (espacios distintos)", mc.yaLoDijo(LISTA, [LISTA.replace(/\n/g, " ")]), true);
igual("no la dijo", mc.yaLoDijo(LISTA, ["Una persona de Ventas revisa si se puede acelerar la entrega y te escribe por acá en un momento."]), false);
igual("sin mensajes recientes", mc.yaLoDijo(LISTA, []), false);
igual("una respuesta corta no cuenta", mc.yaLoDijo("¿De qué artículo?", ["¿De qué artículo?"]), false);
const ahora = Date.parse("2026-10-08T12:33:04Z");
igual("recientes: sólo del bot y de los últimos 30 min", mc.respuestasRecientes([
  { rol: "assistant", contenido: "hace 31 min", creado_en: "2026-10-08T12:02:00Z" },
  { rol: "assistant", contenido: "hace 24 s", creado_en: "2026-10-08T12:32:40Z" },
  { rol: "user", contenido: "del cliente", creado_en: "2026-10-08T12:33:03Z" },
], ahora), ["hace 24 s"]);

// ── Cantidad con unidad (entrega inmediata = stock, no adelantar) ─────────────────────────────────────────────────
for (const t of ["200 docenas", "6 cajas", "48 unidades", "3 bultos", "10 u"]) igual(`cantidad: ${t}`, mc.RE_CANTIDAD_CON_UNIDAD.test(t), true);
for (const t of ["el 505", "entrega inmediata", "el viernes 10"]) igual(`no es cantidad: ${t}`, mc.RE_CANTIDAD_CON_UNIDAD.test(t), false);

// ── Pistas para el agente ─────────────────────────────────────────────────────────────────────────────────────────
igual("sin pistas, bloque vacío", mc.bloquePistas([]), "");
const b = mc.bloquePistas([mc.pistaDeParte("pasame precio", LISTA, null), mc.pistaRepetida(LISTA)]);
igual("el bloque dice que conteste todo en un mensaje", b.includes("contestá TODO lo que el cliente pide en este mensaje, en UN solo mensaje"), true);
igual("el bloque pide no saltear partes (Chef 411 con Haiku: 'cuándo sale mi pedido' quedó sin contestar)",
  b.includes("Cada parte lleva su respuesta, aunque sea que no hay dato") && b.includes("nunca saltees una parte"), true);
igual("el bloque trae la respuesta fija", b.includes("«pasame precio», la respuesta fija aprobada es: «La lista de precios vigente"), true);
igual("la pista repetida pide no repetir", mc.pistaRepetida(LISTA).includes("No se la repitas igual"), true);
igual("la pista avisa la derivación", mc.pistaDeParte("x", "y", "entrega").endsWith("(además deriva a una persona: motivo entrega)."), true);

// ── handleFaq (cliente falso, sin red) ────────────────────────────────────────────────────────────────────────────
const cliente = { id: "x", cod_cliente: 411, business_name: "Prueba", dto_vol: 0 };
igual("Chef 2 no tiene respuesta fija (va al agente)", await handleFaq(M2, cliente), null);
igual("stock para ya de una cantidad no es 'acelerar la entrega'", await handleFaq("¿Podés tener 200 docenas del 505 de entrega inmediata?", cliente), null);
igual("entrega rápida sin cantidad sigue derivando (m59)",
  (await handleFaq("En el caso que se confirme, ¿hay posibilidades de entrega rápida?", cliente))?.intent, "entrega_rapida");
igual("como parte de una pista, el compuesto no se vuelve a partir",
  (await handleFaq("En el caso que se confirme, ¿hay posibilidades de entrega rápida? ¿Tienen el 505?", cliente, { parte: true }))?.intent, "entrega_rapida");

// ── Guardas sobre el código ───────────────────────────────────────────────────────────────────────────────────────
const faqSrc = await Deno.readTextFile(new URL("../supabase/functions/_shared/faq.ts", import.meta.url));
const iClave = faqSrc.indexOf("if (pideClave(text))");
const iGuarda = faqSrc.indexOf("if (customer && !opts.parte && mensajeCompuesto(text)) return null;");
igual("la guarda de compuesto existe", iGuarda > 0, true);
igual("la clave de la web va ANTES de la guarda (el PIN sólo lo da la capa fija)", iClave > 0 && iClave < iGuarda, true);
const hook = await Deno.readTextFile(new URL("../supabase/functions/lk_whatsapp-webhook/index.ts", import.meta.url));
igual("el webhook decide con decidirCapaFija", hook.includes("await decidirCapaFija(text, faqCustomer, faq,"), true);
igual("el webhook le pasa las pistas al agente", hook.includes('"lk_whatsapp-webhook",\n    { pistas },'), true);
const sim = await Deno.readTextFile(new URL("../supabase/functions/lk_bot-simular/index.ts", import.meta.url));
igual("el Simulador hace lo mismo", sim.includes("await decidirCapaFija(text, cli, faq,") && sim.includes('"lk_bot-simular", { pistas }'), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
