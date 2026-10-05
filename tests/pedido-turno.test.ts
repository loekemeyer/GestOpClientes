// Pruebas de qué turnos son de TOMA DE PEDIDO y se contestan con el modelo fijo (supabase/functions/_shared/pedido-turno.ts). Sin red, sin IA.
// Correr: deno run tests/pedido-turno.test.ts   (sale con código 1 si algo falla)
import { candidatosDePedido, esTurnoDePedido, MODELO_PEDIDOS, modeloFijoDePedidos, ultimoDelBotEsDePedido } from "../supabase/functions/_shared/pedido-turno.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const AHORA = Date.parse("2026-10-05T20:00:00Z");
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();
const sinHistorial: { rol: string; contenido: string; creado_en: string }[] = [];

// ── Frases REALES del estudio de WhatsApp (wa_agente_evals) que tienen que ir al modelo fijo ──
const PIDEN = [
  "Te paso el cotizador con el pedido",                          // 2.1
  "Paso un pedidito. ¿Puede estar para el viernes?",             // 2.2
  "Adjunto orden de compra, quedo a la espera de confirmación de recepción",   // 2.3
  "Te envío un pedido y los datos del transporte con nueva dirección",         // 2.4
  "6 cajas de pelapapas 505, 1 caja abrelatas 501, lo retiro yo", // 2.5
  "Quería agregar 60 unidades del sacacorcho 067 al pedido de ayer",           // 2.7
  "Agregá 3 cajas más de pelapapas 505, que sean 15",            // 2.8
  "Quiero hacer un pedido, ¿tengo que entrar en la página?",     // 2.16
  "Quiero 3 cajas de abrelatas rojos",
  "Necesito pedir 20 cajas del 501",
];
for (const t of PIDEN) igual(`va al modelo fijo: ${t.slice(0, 55)}`, esTurnoDePedido(t, sinHistorial, AHORA), true);

// ── Consultas que NO son de pedido (estado, facturas, stock…): siguen por la cadena ──
const NO_PIDEN = [
  "¿Sabés cuándo me entregan el pedido?",                         // 1.1
  "Hace 10 días hice un pedido, quería saber el estado",          // 1.2
  "Pasé un pedido por la web, ¿lo recibieron?",                   // 7.1
  "Recién cargué un pedido por la página, me avisás cuándo lo puedo pasar a buscar",   // 7.2
  "¿Mañana puedo pasar a retirar?",
  "Pasame el importe con el 25 % de contado",
  "No me llegó la factura, ¿me la mandás por acá?",
  "¿Tienen tostadores enlozados en stock?",
  "¿Cuándo ingresan los artículos nuevos?",
  "Quiero ser cliente",
  "Hola, sí, sí, lo pueden reemplazar",
];
for (const t of NO_PIDEN) igual(`sigue por la cadena: ${t.slice(0, 55)}`, esTurnoDePedido(t, sinHistorial, AHORA), false);

// ── Un "sí" o "contado" es de pedido si lo último que dijo el bot fue parte de la toma de un pedido (en la última hora) ──
const botPregunta = (c: string, min: number) => [{ rol: "user", contenido: "dale", creado_en: hace(0) }, { rol: "assistant", contenido: c, creado_en: hace(min) }];
igual("'sí' después del resumen del pedido", esTurnoDePedido("sí", botPregunta("Este es el resumen de tu pedido: … ¿Lo confirmás con un sí?", 3), AHORA), true);
igual("'contado' después de preguntar la forma de pago", esTurnoDePedido("contado", botPregunta("¿Qué forma de pago preferís?", 2), AHORA), true);
igual("'sí' después de 'Leímos esto' (cotizador)", esTurnoDePedido("sí", botPregunta("Recibimos tu cotizador. Leímos esto: …", 1), AHORA), true);
igual("'sí' después de 61 minutos: ya no es de pedido", esTurnoDePedido("sí", botPregunta("¿Qué forma de pago preferís?", 61), AHORA), false);
igual("'sí' después de una respuesta que no es de pedido", esTurnoDePedido("sí", botPregunta("Tu pedido del 30/09 sale el lunes.", 2), AHORA), false);
igual("mira el último mensaje del BOT aunque el último sea del cliente", ultimoDelBotEsDePedido(botPregunta("¿A dónde lo enviamos?", 4), AHORA), true);
igual("historial vacío", ultimoDelBotEsDePedido(sinHistorial, AHORA), false);

// ── Modelo fijo: el de siempre, cambiable, y apagable ──
igual("sin setting: Sonnet 4.6", modeloFijoDePedidos(null), MODELO_PEDIDOS);
igual("setting vacío: Sonnet 4.6", modeloFijoDePedidos("  "), "claude-sonnet-4-6");
igual("setting con otro modelo", modeloFijoDePedidos("claude-sonnet-5"), "claude-sonnet-5");
igual("setting 'cadena' lo apaga", modeloFijoDePedidos("cadena"), null);
igual("setting 'off' lo apaga", modeloFijoDePedidos("OFF"), null);

// ── Candidatos: SOLO Anthropic, el modelo fijo dos veces (reintento), ids que nunca se marcan caídos ──
const c = candidatosDePedido("claude-sonnet-4-6", "k");
igual("dos candidatos del mismo modelo", c.map((x) => [x.provider, x.model]), [["anthropic", "claude-sonnet-4-6"], ["anthropic", "claude-sonnet-4-6"]]);
igual("ids 0 y -2 (no existen en wa_agente_modelos)", c.map((x) => x.id), [0, -2]);
igual("ninguno es gratis (se registra el costo)", c.some((x) => x.isFreeTier), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); const g = globalThis as { Deno?: { exit(c: number): never }; process?: { exit(c: number): never } }; (g.Deno ?? g.process)!.exit(1); }
else console.log("\ntodo bien");
