// Pruebas de _shared/envios-bot.ts: cómo se le nombra al agente y a una persona cada cosa que el bot mandó (sql/140, P6 del plan de los 8 puntos).
// Pablo Olejavetzky, 13/10/2026. Sin red, sin IA.
// Correr: deno run --allow-env tests/envios-bot.test.ts   (sale con código 1 si algo falla)
// envios-bot.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { descripcionDeEnvio, wamidDeRespuesta, registrarEnvioBot } = await import("../supabase/functions/_shared/envios-bot.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── Descripción por tipo de envío (los cuerpos son los que arma _shared/wa-api.ts) ──
igual("foto con caption (enviar_fotos_producto): «cód — nombre»",
  descripcionDeEnvio({ messaging_product: "whatsapp", to: "5491131181594", type: "image", image: { link: "https://x/505.jpg", caption: "505 — Pelador Mgo Plástico" } }),
  { tipo: "image", descripcion: "la foto «505 — Pelador Mgo Plástico»", plantilla: null });
igual("foto sin caption", descripcionDeEnvio({ type: "image", image: { link: "https://x/1.jpg" } }), { tipo: "image", descripcion: "una foto", plantilla: null });
igual("texto: las primeras 60 letras y puntos suspensivos",
  descripcionDeEnvio({ type: "text", text: { body: "¡Listo! Te mandé la foto del Pelador Mgo Plástico (cód. 505). Si necesitás otra cosa, decime." } }),
  { tipo: "text", descripcion: "el mensaje «¡Listo! Te mandé la foto del Pelador Mgo Plástico (cód. 505)…»", plantilla: null });
igual("texto corto: entero, sin puntos suspensivos", descripcionDeEnvio({ type: "text", text: { body: "Hola" } }),
  { tipo: "text", descripcion: "el mensaje «Hola»", plantilla: null });
igual("texto con saltos de línea: una sola línea", descripcionDeEnvio({ type: "text", text: { body: "Hola\n\n¿Cómo  estás?" } }).descripcion,
  "el mensaje «Hola ¿Cómo estás?»");
igual("archivo: por nombre", descripcionDeEnvio({ type: "document", document: { link: "https://x/f.pdf", filename: "Factura_A_0003-00012345.pdf" } }),
  { tipo: "document", descripcion: "el archivo «Factura_A_0003-00012345.pdf»", plantilla: null });
igual("plantilla: por nombre, y el nombre queda aparte (los aviso_equipo* no dejan alerta en el trigger)",
  descripcionDeEnvio({ type: "template", template: { name: "aviso_equipo_v3", language: { code: "es_AR" } } }),
  { tipo: "template", descripcion: "el aviso «aviso_equipo_v3»", plantilla: "aviso_equipo_v3" });
igual("plantilla con un nombre raro se limpia", descripcionDeEnvio({ type: "template", template: { name: "pedido recibido<x>" } }).plantilla, "pedidorecibidox");
igual("tipo desconocido", descripcionDeEnvio({ type: "sticker" }), { tipo: "otro", descripcion: "un mensaje de tipo sticker", plantilla: null });
igual("el marcado de leído (sin type) no es un envío", descripcionDeEnvio({ status: "read", message_id: "wamid.x" }), { tipo: "otro", descripcion: "un mensaje", plantilla: null });

// ── El wamid de la respuesta de Meta ──
igual("wamid de una respuesta aceptada", wamidDeRespuesta({ messaging_product: "whatsapp", contacts: [{ wa_id: "5491131181594" }], messages: [{ id: "wamid.HBgN…" }] }), "wamid.HBgN…");
igual("respuesta sin mensajes (marcar leído devuelve {success:true})", wamidDeRespuesta({ success: true }), null);
igual("respuesta vacía", wamidDeRespuesta({}), null);
igual("id que no es un wamid", wamidDeRespuesta({ messages: [{ id: "123" }] }), null);

// ── Sin wamid no se escribe nada (no hay base en la prueba: si intentara, fallaría o colgaría) ──
const t0 = Date.now();
await registrarEnvioBot("5491131181594", { type: "text", text: { body: "Hola" } }, { success: true });
igual("sin wamid: vuelve en el acto sin tocar la base", Date.now() - t0 < 200, true);
// Con wamid y una base que no contesta: nunca lanza y no pasa del tope (1,5 s).
const t1 = Date.now();
await registrarEnvioBot("5491131181594", { type: "text", text: { body: "Hola" } }, { messages: [{ id: "wamid.prueba" }] });
igual("base caída: no lanza y no demora más que el tope", Date.now() - t1 < 2500, true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
else console.log("\ntodo bien");
