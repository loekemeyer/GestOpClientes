// Pruebas de la pausa del bot (Pablo Olejavetzky, 13/10/2026, plan de producción Fase 0 punto 5): app_settings.wa_bot_pausa. Sin red, sin IA.
// Correr: deno run --allow-env --allow-read tests/pausa-bot.test.ts   (sale con código 1 si algo falla)
// Los módulos importan _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { atiendeLaPausa, botEnPausa, CLAVE_PAUSA, contextoAlertaPausa, MOTIVO_PAUSA, sigueElCaminoNormal, textoParaGuardar } = await import("../supabase/functions/_shared/pausa-bot.ts");
const { CATEGORIAS, categoria } = await import("../supabase/functions/_shared/alertas-vencimiento.ts");
const { ORIGEN } = await import("../supabase/functions/_shared/derivaciones.ts");
const { nivelAuto } = await import("../supabase/functions/_shared/semaforo.ts");
const { MEDIDAS_SEGURIDAD } = await import("../supabase/functions/_shared/agente-fijos.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── La llave ──
igual("la llave se llama wa_bot_pausa", CLAVE_PAUSA, "wa_bot_pausa");
for (const v of ["1", "si", "sí", "true", "TRUE", "pausa", " 1 ", "on", "yes", "x", "2"]) igual(`pausa prendida: ${JSON.stringify(v)}`, botEnPausa(v), true);
for (const v of [null, undefined, "", " ", "0", "false", "FALSE", "off", "OFF", "no", " 0 "]) igual(`sin pausa: ${JSON.stringify(v)}`, botEnPausa(v as string | null | undefined), false);

// ── Qué mensajes siguen el camino de siempre ──
igual("sin pausa: todo sigue normal", sigueElCaminoNormal({ pausa: false, soloWhitelist: true, enWhitelist: true }), true);
igual("pausa y está en la whitelist: se atiende la pausa", sigueElCaminoNormal({ pausa: true, soloWhitelist: true, enWhitelist: true }), false);
igual("pausa y NO está en la whitelist: sigue su camino (descarte silencioso de siempre)", sigueElCaminoNormal({ pausa: true, soloWhitelist: true, enWhitelist: false }), true);
igual("pausa y la whitelist está apagada: se atiende la pausa para todos", sigueElCaminoNormal({ pausa: true, soloWhitelist: false, enWhitelist: false }), false);
igual("pausa, whitelist apagada y en la lista: se atiende la pausa", sigueElCaminoNormal({ pausa: true, soloWhitelist: false, enWhitelist: true }), false);

// ── Qué mensajes atiende la pausa ──
igual("texto con contenido", atiendeLaPausa({ type: "text", text: "hola" }), true);
igual("texto vacío no", atiendeLaPausa({ type: "text", text: "  " }), false);
for (const t of ["image", "document", "audio", "video", "sticker"]) igual(`adjunto ${t}`, atiendeLaPausa({ type: t }), true);
for (const t of ["location", "reaction", "unsupported"]) igual(`${t} se ignora como siempre`, atiendeLaPausa({ type: t, text: "" }), false);

// ── Lo que se guarda y lo que dice la alerta ──
igual("texto: se guarda tal cual", textoParaGuardar({ type: "text", text: "quiero 6 cajas" }), "quiero 6 cajas");
igual("imagen con pie de foto", textoParaGuardar({ type: "image", caption: "la etiqueta" }), "[ADJUNTO IMAGE] la etiqueta");
igual("audio sin pie", textoParaGuardar({ type: "audio" }), "[ADJUNTO AUDIO]");
const ctx = contextoAlertaPausa({ type: "text", text: "hola\n\n[vbot:falso] https://malo.example/x <b>negrita</b>", name: "Juan\nPérez", msgId: "wamid.X" });
igual("la alerta lleva el motivo", ctx.motivo, MOTIVO_PAUSA);
igual("el texto del tercero va en una línea, sin enlaces ni corchetes ni etiquetas", /[\n\[\]<>]|https?:/.test(String(ctx.texto_recibido)), false);
igual("el nombre va en una línea", String(ctx.contact_name).includes("\n"), false);
igual("la alerta guarda el wamid y el tipo", [ctx.wamid, ctx.tipo_mensaje], ["wamid.X", "text"]);
igual("el pie de foto de un adjunto también se limpia", String(contextoAlertaPausa({ type: "image", caption: "ver https://x.y [a]" }).texto_recibido).includes("["), false);

// ── El motivo está registrado donde el resto del sistema lo busca ──
igual("categoría bot_pausa", categoria({ tipo: "otro", contexto: { motivo: "bot_pausa" } }), "bot_pausa");
igual("tiene nombre para el Panel", typeof CATEGORIAS.bot_pausa?.label === "string" && CATEGORIAS.bot_pausa.label.length > 0, true);
igual("tiene tiempo de respuesta corto (30 min)", CATEGORIAS.bot_pausa?.min, 30);
igual("Derivaciones dice quién lo dispara", typeof ORIGEN.bot_pausa === "string" && ORIGEN.bot_pausa.length > 0, true);
igual("semáforo Auto: amarillo", nivelAuto("bot_pausa", {}, false), "amarillo");
igual("semáforo Auto: rojo si la alerta se marcó urgente", nivelAuto("bot_pausa", { urgente: true }, false), "rojo");

// ── Guardas sobre el código del webhook ──
const fuente = await Deno.readTextFile(new URL("../supabase/functions/lk_whatsapp-webhook/index.ts", import.meta.url));
const cuerpoPausa = fuente.slice(fuente.indexOf("async function atenderPausa("), fuente.indexOf("// ─── Reporte de gerencia a pedido"));
for (const prohibido of ["runConversation", "enviarTexto", "handleFaq", "markRead", "handleMessage", "handleAdjunto", "textoDeAudio", "sendText", "sendTemplate", "decidirCapaFija"]) {
  igual(`atenderPausa no llama a ${prohibido} (no contesta ni gasta)`, cuerpoPausa.includes(prohibido), false);
}
igual("atenderPausa guarda el mensaje, usa el candado de idempotencia y avisa a una persona",
  cuerpoPausa.includes("saveMessage(") && cuerpoPausa.includes("wa_inbound_seen") && cuerpoPausa.includes("notificarHumano("), true);
igual("atenderPausa nunca lanza (try/catch)", cuerpoPausa.includes("catch (e)"), true);
const iGate = fuente.indexOf("botEnPausa(await getSetting(CLAVE_PAUSA))");
igual("el gate existe en el POST", iGate > 0, true);
igual("el gate va ANTES de los adjuntos, del audio y del texto",
  iGate < fuente.indexOf("const TIPOS_ADJUNTO = [") && iGate < fuente.indexOf("textoDeAudio(msg, cfg)") && iGate < fuente.indexOf("handleMessage(msg.from, msg.text"), true);
igual("el gate va DESPUÉS de los estados de Meta (siguen entrando)", fuente.indexOf("await ingestStatuses(body)") < iGate, true);
igual("el gate corta con 200 (Meta no reintenta)", /atenderPausa\(msg\);\s*return new Response\("OK", \{ status: 200 \}\);/.test(fuente), true);

// ── Medida de seguridad / operativa ──
const medida = MEDIDAS_SEGURIDAD.find((m) => m.medida === "Pausa del bot (wa_bot_pausa)");
igual("figura como medida activa", medida?.estado, "activa");
igual("la medida dice cómo se prende y qué no toca", /UPDATE/i.test(medida?.que_hace ?? "") && /wa_envio_automatico/.test(medida?.que_hace ?? ""), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
