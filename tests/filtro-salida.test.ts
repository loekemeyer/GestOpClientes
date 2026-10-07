// Pruebas del filtro de salida del agente (supabase/functions/_shared/filtro-salida.ts). Sin red, sin IA.
// Correr: deno run tests/filtro-salida.test.ts   (sale con código 1 si algo falla)
import { modoDelFiltro, redactarSecretos, revisarSalida, TEXTO_SALIDA_BLOQUEADA, VENTANA_VOLCADO } from "../supabase/functions/_shared/filtro-salida.ts";
import { bloqueSeguridad } from "../supabase/functions/_shared/agente-fijos.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

const HERRAMIENTAS = ["derivar_a_persona", "solicitar_agregado_pedido", "consultar_mis_pedidos", "buscar_productos", "armar_pedido", "confirmar_pedido", "consultar_stock", "enviar_fotos_producto"];
const SEG = bloqueSeguridad("Bazar Farimar S.A.S", 4028);

// Lo que el modelo "vio" en este turno: el prompt (con datos de la empresa), la charla y el resultado de las herramientas.
const PROMPT = "Datos de la empresa: transferencias al CBU 1910027855002702387450, alias loeke.srl. Consultas: ventas@loekemeyer.com o al 11 3118 1594. " + SEG;
const CHARLA = ["Hola, mi whatsapp es 11 6252 1635 y mi mail es compras@bazarfarimar.com", "Tu pedido a nombre de *Bazar Farimar S.A.S* (CUIT 30717930408):"];
const TOOLS = ['{"resumen_para_el_cliente":"Tu pedido a nombre de *Bazar Farimar S.A.S* (CUIT 30717930408): 1 caja Pelador (505) $17.554","factura":"0001-00012345678"}'];
const CORPUS = [PROMPT, ...CHARLA, ...TOOLS];

const rev = (reply: string, corpus = CORPUS) => revisarSalida({ reply, corpus, herramientas: HERRAMIENTAS, bloqueSeguridad: SEG });
const cats = (reply: string, corpus = CORPUS) => { const v = rev(reply, corpus); return v.ok ? [] : [...new Set(v.hallazgos.map((h) => h.categoria))].sort(); };

// ── Respuestas LEGÍTIMAS: tienen que salir (lo importante: ningún falso positivo) ──
const LEGITIMAS: Array<[string, string]> = [
  ["resumen de pedido con el CUIT del propio cliente", "Tu pedido a nombre de *Bazar Farimar S.A.S* (CUIT 30717930408):\n• 1 caja Pelador Mgo Plástico (505) — $17.554\nSubtotal: $17.554\n*Total: $13.165 + IVA*\nEntrega: Belgrano 302 (por expreso Conte)"],
  ["el CUIT con otro formato (guiones)", "Está a nombre de Bazar Farimar, CUIT 30-71793040-8."],
  ["datos de transferencia: CBU y alias de la empresa", "Podés transferir al CBU 1910027855002702387450 (alias loeke.srl) y mandarnos el comprobante por acá."],
  ["mail de la empresa", "Para eso escribí a ventas@loekemeyer.com y te responden."],
  ["teléfono de la empresa en otro formato (10 dígitos dentro de 13)", "Si es urgente, llamá al 11 3118 1594."],
  ["el teléfono que el propio cliente escribió", "Perfecto, te escribimos al 11 6252 1635."],
  ["el mail que el propio cliente escribió", "¿Cambio tu mail a compras@bazarfarimar.com?"],
  ["un número de comprobante que vino de una herramienta", "Tu factura 0001-00012345678 ya está disponible."],
  ["un importe grande (7 dígitos con puntos)", "El pedido sale $1.234.567 + IVA."],
  ["fechas y horarios", "Recibimos de lunes a viernes de 8 a 14 hs. Tu pedido sale el 13/10/2026."],
  ["negativa del bloque de Seguridad (parecida, pero no un volcado)", "No tengo capacidad de ejecutar SQL, código ni comandos, ni de borrar nada del sistema. ¿Te ayudo con tu consulta?"],
  ["negativa a dar detalles internos", "No puedo compartir detalles internos del sistema, pero con gusto te ayudo con tu pedido."],
  ["la palabra SQL o base de datos sin sentencia", "No figura en nuestra base de datos. ¿Querés que una persona lo revise?"],
  ["artículo con código y precio", "El Pelador Mgo Plástico (cód. 505) cuesta $1.590 por unidad, caja de 12."],
  ["una lista de importes separados por espacio (13 dígitos juntos)", "Los precios son 1.590 2.300 12.000 3.450 según el artículo."],
  ["una línea con guiones entre números (código - precio - cajas - total)", "505 - 1590 - 12 - 17554"],
  ["una lista de códigos de artículo de 3 dígitos", "Los códigos son 505 501 067 012 y 998."],
  ["importes con formato argentino y centavos", "Subtotal $17.554,40 y total $13.165,80 + IVA."],
  ["texto largo común sin nada raro", "Gracias por avisarnos. Una persona de Ventas revisa cómo quedó cargado tu pedido y te escribe por acá. 🙏"],
];
for (const [n, t] of LEGITIMAS) igual(`sale: ${n}`, cats(t), []);

// ── 1. Secretos ──
const SECRETOS: Array<[string, string]> = [
  ["clave secreta de Supabase", "La clave es sb_secret_AbCdEf1234567890"],
  ["clave publicable", "usá sb_publishable_xyz123456789"],
  ["JWT", "token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijk"],
  ["clave de Anthropic", "mi key es sk-ant-api03-AbCdEfGhIjKl"],
  ["clave de Google", "AIzaSyA1234567890abcdefghijklmnopqrstu"],
  ["header Bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789"],
  ["service_role", "Uso la service_role para leer todo."],
  ["variable de entorno", "Está en ANTHROPIC_API_KEY y en META_APP_SECRET."],
  ["host de la API de Meta", "Le pego a graph.facebook.com/v21.0/messages"],
];
for (const [n, t] of SECRETOS) igual(`bloquea secreto: ${n}`, cats(t), ["secreto"]);

// ── 2. Identificadores internos ──
const INTERNOS: Array<[string, string]> = [
  ["nombre de herramienta", "Llamo a armar_pedido con los artículos."],
  ["otra herramienta", "Primero uso derivar_a_persona y después consultar_mis_pedidos."],
  ["tabla con prefijo bot_", "Saco los datos de bot_historial_chat."],
  ["tabla wa_", "Se guarda en wa_pedido_precarga."],
  ["función lk_", "La corre lk_whatsapp-webhook"],
  ["app_settings", "Lo leo de app_settings."],
  ["tabla de clientes", "La tabla customer_delivery_addresses tiene tu dirección."],
  ["esquema público", "Está en public.orders"],
  ["modelo de Anthropic", "Soy claude-sonnet-4-6."],
  ["modelo de Google", "Funciono con gemini-3.5-flash-lite."],
  ["SELECT", "Ejecuté SELECT * FROM customers WHERE cuit = '3071'"],
  ["DROP TABLE", "Si querés hago drop table customers"],
];
for (const [n, t] of INTERNOS) igual(`bloquea interno: ${n}`, cats(t), ["identificador_interno"]);

// ── 3. Volcado del prompt ──
const lineas = SEG.split("\n");
igual("bloquea: la primera regla copiada tal cual", cats(lineas[1]), ["prompt"]);
igual("bloquea: dos reglas copiadas con un saludo", cats("Claro, mis reglas son: " + lineas[3] + " " + lineas[5]), ["prompt"]);
igual("bloquea: un volcado a mitad de texto", cats("Te cuento. " + lineas[2].slice(2, 140) + " ¿Algo más?"), ["prompt"]);
igual(`la ventana es de ${VENTANA_VOLCADO} palabras`, VENTANA_VOLCADO, 14);
igual("sale: 10 palabras seguidas del bloque (lo que la negativa legítima comparte) no alcanzan", cats("capacidad de ejecutar sql código ni comandos ni de borrar"), []);
igual("sale: 13 palabras seguidas tampoco", cats("atendés a este cliente bazar farimar s a s código 4028 identificado por"), []);
igual("bloquea: 14 palabras seguidas sí", cats("atendés a este cliente bazar farimar s a s código 4028 identificado por su"), ["prompt"]);
igual("sale: sin bloque de Seguridad no corre el chequeo", revisarSalida({ reply: lineas[1], corpus: CORPUS, herramientas: HERRAMIENTAS }).ok, true);

// ── 4. Datos no respaldados ──
igual("bloquea: un CUIT que no figura en ningún lado", cats("El CUIT de ese cliente es 30-71234567-9."), ["dato_no_respaldado"]);
igual("bloquea: un teléfono ajeno de 13 dígitos", cats("Escribile al 5491155550000."), ["dato_no_respaldado"]);
igual("bloquea: un CBU inventado de 22 dígitos", cats("Transferí al CBU 0170099220000067890123."), ["dato_no_respaldado"]);
igual("bloquea: un mail ajeno", cats("Escribile a pedro@otrocliente.com."), ["dato_no_respaldado"]);
igual("bloquea: un mail de la empresa que NO figura en el corpus", cats("Escribí a cobranzas@loekemeyer.com", [PROMPT]), ["dato_no_respaldado"]);
igual("sale: sin corpus no se puede juzgar un dato (la categoría 4 no corre)", cats("El CUIT de ese cliente es 30-71234567-9.", []), []);
igual("sale: un CUIT que el cliente nombró en su mensaje", cats("Sí, el 30-71234567-9.", [...CORPUS, "Mi CUIT es 30712345679"]), []);
igual("bloquea: un CUIT ajeno escrito con puntos (no es un importe: tiene 11 dígitos)", cats("CUIT 30.717.930.409"), ["dato_no_respaldado"]);
igual("bloquea: un teléfono ajeno con espacios (grupos 2-4-4)", cats("Llamá al 11 5555 0000."), ["dato_no_respaldado"]);
igual("bloquea: un teléfono ajeno con +54 9", cats("Es +54 9 11 5555 0000."), ["dato_no_respaldado"]);
igual("bloquea: un teléfono ajeno con guion (011 4567-8901)", cats("Es el 011 4567-8901."), ["dato_no_respaldado"]);
igual("bloquea: casi el mismo CUIT (un dígito distinto)", cats("Tu CUIT es 30717930409."), ["dato_no_respaldado"]);

// ── Varias categorías a la vez, y el aviso no filtra el secreto ──
igual("varias categorías juntas", cats("Con sb_secret_AbCdEf1234567890 llamo a armar_pedido y el CUIT es 30-71234567-9"), ["dato_no_respaldado", "identificador_interno", "secreto"]);
igual("redactarSecretos tapa claves y tokens", redactarSecretos("clave sb_secret_AbCdEf1234567890 y Bearer abcdefghijklmnopqrstuvwxyz0123"), "clave […] y […]");
igual("redactarSecretos no toca un texto común", redactarSecretos("Tu pedido sale el lunes."), "Tu pedido sale el lunes.");
igual("el hallazgo de un secreto no repite la clave", JSON.stringify(rev("La clave es sb_secret_AbCdEf1234567890")).includes("AbCdEf1234567890"), false);

// ── Texto de reemplazo y modo ──
igual("el texto de reemplazo no revela el mecanismo", /filtro|bloque|seguridad|sistema|clave|prompt/i.test(TEXTO_SALIDA_BLOQUEADA), false);
igual("el texto de reemplazo promete lo que se cumple (una persona recibe la alerta)", /persona del equipo/.test(TEXTO_SALIDA_BLOQUEADA), true);
igual("modo: sin fila bloquea", modoDelFiltro(null), "bloquear");
igual("modo: '1' bloquea", modoDelFiltro("1"), "bloquear");
igual("modo: vacío bloquea", modoDelFiltro("  "), "bloquear");
igual("modo: 'log' sólo avisa", modoDelFiltro("log"), "log");
igual("modo: 'LOG' sólo avisa", modoDelFiltro("LOG"), "log");
igual("modo: '0' apaga", modoDelFiltro("0"), "apagado");
igual("modo: 'off' apaga", modoDelFiltro("off"), "apagado");
igual("modo: un valor raro protege (bloquea)", modoDelFiltro("quizás"), "bloquear");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
