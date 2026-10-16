// articulo-en-curso — el artículo del que se viene hablando en la charla, armado por el CÓDIGO y no por el modelo. Pablo Olejavetzky, 15/10/2026.
//
// Caso que lo motivó (Logística …1027, 15/10 16:28, auditoría 828): «Tenes stock del 586?» → el agente contestó bien. Pero «Tenes stock para 30 cajas?» (sin nombrar
// el artículo) respondió «¿Qué artículo le interesa?» sin llamar a consultar_stock, y con «Del art que te pregunte antes» volvió a pedir el artículo (nombrando el 586
// sacado del historial, pero sin consultar). El historial SÍ le llegaba (33.000 tokens de entrada por llamada): Haiku 5.5, con las reglas del 15/10 que empujan a
// «preguntar de más» (PEDIDO SIN ERRORES, COLORES), no resolvía la referencia implícita. Mismo criterio que el caso Cuccinarte: lo exacto lo arma el código.
//
// Dos piezas, ambas puras y sin imports (las prueba tests/articulo-en-curso.test.ts):
//   1. articuloEnCurso(): un bloque para la parte VARIABLE del prompt con el último artículo de la charla, si es uno solo. Es una pista, no una orden: si el
//      mensaje nombra otro artículo o cambia de tema, el modelo la ignora. No se arma si el mensaje ya trae un código, si el último mensaje con artículos
//      trae VARIOS (una lista: no se sabe cuál) o si pasaron más de 3 horas.
//   2. cajasRespaldadas(): consultar_stock recibía `cajas` inventadas (cajas=2 sin que el cliente lo dijera → «tiene stock para las 2 cajas»; peor, si el stock
//      no alcanzaba para ese número inventado, avisaba a una persona). Sólo vale un número que el cliente escribió.

export interface FilaCharla { rol: string; contenido: string; creado_en: string }

export const HORAS_ARTICULO_EN_CURSO = 3;
/** Cuántas filas hacia atrás se mira (sin contar el mensaje de ahora). */
const MAX_FILAS = 6;
/** Cuántos mensajes del cliente se leen para saber si dijo un número de cajas. */
const MAX_MENSAJES_CAJAS = 4;

// Un código de artículo en lo que escribe el CLIENTE: 3 a 5 dígitos con una letra a lo sumo (505, 067, 938E). No es un año (2026), un importe ($117.973, 1,50) ni el
// número de un pedido, factura o remito («pedido 1692»).
// 16/10: tampoco es un código una cantidad («100 cajas», «200 unidades»): «compro 100 cajas» se leía como el cód. 100 y entraba a la lista de artículos de la charla.
const RE_CODIGO_CLIENTE =
  /(?<![a-z0-9.,$])(?<!(?:pedido|factura|remito|np|n[º°])\s*)(?!(?:19|20)\d\d(?![a-z0-9]))(\d{3,5}[a-z]?)(?![a-z0-9]|[.,]\d)(?!\s*(?:cajas?|unidad(?:es)?|docenas?|pares?|u\b|kg|kilos?|metros?|mts|pesos|%))/gi;
// Un código en lo que contesta el BOT: «*Pelapapas Mgo Ergonomico* (cód. 586)» o «cód. 123 · Nombre: $12.345 por caja». El nombre, si viene entre asteriscos justo antes.
const RE_CODIGO_BOT = /(?:\*([^*\n]{2,80})\*\s*)?\(?c[óo]d\.?\s*(\d{3,5}[a-z]?)(?![a-z0-9])/gi;

export interface Mencion { cod: string; nombre: string | null }

export function codigosDelCliente(texto: string): Mencion[] {
  return [...String(texto ?? "").matchAll(RE_CODIGO_CLIENTE)].map((m) => ({ cod: m[1].toUpperCase(), nombre: null }));
}
export function codigosDelBot(texto: string): Mencion[] {
  return [...String(texto ?? "").matchAll(RE_CODIGO_BOT)].map((m) => ({ cod: m[2].toUpperCase(), nombre: m[1]?.trim() || null }));
}
const distintos = (ms: Mencion[]) => new Set(ms.map((m) => m.cod));

function hace(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
}

/** El historial llega del más nuevo al más viejo (como `rawHistory`); la primera fila puede ser el mensaje de ahora (el webhook lo guarda antes). */
function sinElMensajeDeAhora(historial: FilaCharla[], userText: string): FilaCharla[] {
  return historial.filter((h, i) => !(i === 0 && h.rol === "user" && h.contenido === userText));
}

export interface ArticuloEnCurso { cod: string; nombre: string | null; ms: number }

/** El último artículo de la charla, si es uno solo (código, nombre si se conoce y hace cuánto se habló). null si no hay uno claro. Lo usa el bloque del prompt
 *  y la compuerta de stock (compuerta-stock.ts). Si el mensaje de ahora ya trae un código, devuelve null: ese código manda. */
export function buscarArticuloEnCurso(historial: FilaCharla[], userText: string, ahora = new Date()): ArticuloEnCurso | null {
  if (codigosDelCliente(userText).length) return null;   // ya nombra un artículo por su código: nada que suplir
  const filas = sinElMensajeDeAhora(historial, userText).slice(0, MAX_FILAS);
  let hallado: ArticuloEnCurso | null = null;
  for (const f of filas) {
    const t = Date.parse(f.creado_en);
    if (!Number.isFinite(t) || ahora.getTime() - t > HORAS_ARTICULO_EN_CURSO * 3600_000) break;   // lo que sigue es todavía más viejo
    if (f.rol === "assistant" && f.contenido.startsWith("[Aviso automático")) continue;           // avisos de pedidos: no son una consulta del cliente
    const menciones = f.rol === "user" ? codigosDelCliente(f.contenido) : codigosDelBot(f.contenido);
    if (!menciones.length) continue;
    const cods = distintos(menciones);
    if (cods.size > 1) return null;   // una lista de artículos: no se sabe a cuál se refiere
    hallado = { cod: menciones[0].cod, nombre: menciones.find((m) => m.nombre)?.nombre ?? null, ms: ahora.getTime() - t };
    break;
  }
  if (!hallado) return null;
  // El nombre, si el mensaje que lo trae no lo tenía (lo dijo el cliente por código), se busca en una respuesta del bot sobre el mismo código.
  if (!hallado.nombre) {
    for (const f of filas) {
      if (f.rol !== "assistant") continue;
      const m = codigosDelBot(f.contenido).find((x) => x.cod === hallado!.cod && x.nombre);
      if (m) { hallado.nombre = m.nombre; break; }
    }
  }
  return hallado;
}

/** El bloque para el prompt, o "" si no hay un artículo en curso claro. `ahora` es parámetro para poder probarlo. */
export function articuloEnCurso(historial: FilaCharla[], userText: string, ahora = new Date()): string {
  const hallado = buscarArticuloEnCurso(historial, userText, ahora);
  if (!hallado) return "";
  const quien = hallado.nombre ? `${hallado.nombre} (cód. ${hallado.cod})` : `el cód. ${hallado.cod}`;
  return [
    "## Artículo en curso",
    `El último artículo del que hablaron en esta charla es ${quien}, de hace ${hace(hallado.ms)}.`,
    "Si el mensaje del cliente NO nombra otro artículo (por ejemplo «¿y para 30 cajas?», «¿y stock?», «¿y el precio?», «ese», «el mismo», «el que te pregunté antes»), " +
      "se refiere a éste: usá su código en la herramienta que corresponda (consultar_stock, buscar_productos, enviar_fotos_producto) y contestá. " +
      "No le preguntes «¿de qué artículo?» ni le pidas el nombre o el código.",
    "Si nombra otro artículo (o varios), o si pasó a otro tema, ignorá esto. Vale para CONSULTAS (stock, precio, foto): para armar un pedido o agregar a uno, " +
      "el artículo se confirma con el cliente por su código (regla PEDIDO SIN ERRORES).",
  ].join("\n");
}

// ── Artículos de ESTA charla (Pablo Olejavetzky, 16/10/2026, auditoría 835) ──
// Caso real (Logística …1027, 15/10 16:57): «y de los otros articulos que me ofreciste?» → el agente listó 8 peladores con precio «que le ofrecí en esta charla», pero 6 se los
// había ofrecido AYER (14/10 12:25): el historial que ve el modelo trae la charla anterior y no distingue qué es de hoy. Con «los otros» sin más datos, el modelo adivinaba.
// El código arma la lista exacta: los artículos nombrados en la charla ACTUAL (la que sigue sin un hueco de más de 12 h, como la nota de tiempo), por código.

/** Horas sin mensajes que separan una charla de otra (las mismas que HORAS_CHARLA_NUEVA de ventana-historial.ts). */
export const HORAS_CHARLA_ACTUAL = 12;
/** Cuántas filas hacia atrás se miran para la lista (sin contar el mensaje de ahora). */
const MAX_FILAS_CHARLA = 40;
/** Cuántos artículos entran a la lista: los más recientes. */
export const MAX_ARTICULOS_CHARLA = 10;

export interface ArticuloDeLaCharla { cod: string; nombre: string | null }

/** Los artículos nombrados en la charla actual, ordenados por su última mención (el último de la lista es el que se nombró más recién). Charla actual: desde el mensaje más
 *  nuevo hacia atrás hasta un hueco de más de 12 h entre dos mensajes; si el último mensaje ya tiene más de 12 h, no hay charla actual. No cuenta los avisos automáticos. */
export function articulosDeLaCharla(historial: FilaCharla[], userText: string, ahora = new Date()): ArticuloDeLaCharla[] {
  const filas = sinElMensajeDeAhora(historial, userText).slice(0, MAX_FILAS_CHARLA);
  const limite = HORAS_CHARLA_ACTUAL * 3600_000;
  const deHoy: FilaCharla[] = [];
  let previoMs = ahora.getTime();
  for (const f of filas) {
    const t = Date.parse(f.creado_en);
    if (!Number.isFinite(t) || previoMs - t > limite) break;   // acá empieza una charla anterior
    previoMs = t;
    deHoy.push(f);
  }
  const lista = new Map<string, ArticuloDeLaCharla>();   // el orden de inserción es el de la última mención
  for (const f of deHoy.reverse()) {                        // del más viejo al más nuevo
    if (f.rol === "assistant" && f.contenido.startsWith("[Aviso automático")) continue;
    const menciones = f.rol === "user" ? codigosDelCliente(f.contenido) : codigosDelBot(f.contenido);
    for (const m of menciones) {
      const antes = lista.get(m.cod);
      lista.delete(m.cod);
      lista.set(m.cod, { cod: m.cod, nombre: m.nombre ?? antes?.nombre ?? null });
    }
  }
  return [...lista.values()].slice(-MAX_ARTICULOS_CHARLA);
}

/** El bloque para el prompt, o "" si no hace falta: el mensaje ya trae un código, o en la charla actual hay menos de dos artículos (con uno solo rige «Artículo en curso»). */
export function bloqueArticulosDeLaCharla(historial: FilaCharla[], userText: string, ahora = new Date()): string {
  if (codigosDelCliente(userText).length) return "";
  const lista = articulosDeLaCharla(historial, userText, ahora);
  if (lista.length < 2) return "";
  const renglones = lista.map((a) => `- ${a.nombre ? `${a.nombre} (cód. ${a.cod})` : `cód. ${a.cod}`}`);
  return [
    "## Artículos de esta charla",
    "Son los únicos artículos que se nombraron en ESTA charla (la de las últimas horas), del más viejo al más nuevo:",
    ...renglones,
    "Si el cliente habla de «los otros», «los demás», «esos» o «los que me ofreciste» sin decir cuáles, son éstos (con «los otros», los demás además del artículo en curso si hay uno). " +
      "Para su stock, su precio o su foto usá las herramientas con cada código: no repitas precios ni stock de mensajes anteriores del historial.",
    "Un artículo que aparece en el historial pero NO está en esta lista es de una charla anterior: no lo ofrezcas ni lo listes como «lo que te ofrecí». " +
      "Si no queda claro a cuáles se refiere, preguntale a cuáles (regla de no adivinar).",
  ].join("\n");
}

// ── Cajas: sólo cuentan las que el cliente escribió ──

const UNIDADES: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const DECENAS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const CENTENAS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500,
  seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900, mil: 1000,
};
// Si el cliente habló en unidades, docenas o pares, el agente convierte a cajas (regla CAJAS) y el número de cajas no está escrito: no se puede respaldar.
const RE_EN_OTRA_UNIDAD = /(?<![a-záéíóúüñ])(?:unidad(?:es)?|docenas?|pares?|gruesas?|u|un\.|uni)(?![a-záéíóúüñ])/i;

/** Los números que aparecen en un texto, con cifras («30», «1.000») o con letras («treinta», «treinta y cinco», «una»). */
export function numerosDelTexto(texto: string): Set<number> {
  const out = new Set<number>();
  const t = String(texto ?? "");
  for (const m of t.matchAll(/\d[\d.]*/g)) {
    const n = Number(m[0].replace(/\./g, ""));
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  const palabras = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z]+/g) ?? [];
  for (let i = 0; i < palabras.length; i++) {
    const w = palabras[i];
    if (w in UNIDADES) out.add(UNIDADES[w]);
    else if (w in CENTENAS) out.add(CENTENAS[w]);
    else if (w in DECENAS) {
      out.add(DECENAS[w]);
      if (palabras[i + 1] === "y" && palabras[i + 2] in UNIDADES && UNIDADES[palabras[i + 2]] < 10) out.add(DECENAS[w] + UNIDADES[palabras[i + 2]]);
    }
  }
  return out;
}

/** `cajas` que el modelo pasó a consultar_stock: se devuelve sólo si el cliente escribió ese número (en este mensaje o en sus últimos mensajes). null si no lo dijo.
 *  Si habló en unidades o docenas no se puede comprobar (el agente convirtió a cajas): se deja pasar. */
export function cajasRespaldadas(cajas: unknown, userText: string, historial: FilaCharla[] = []): number | null {
  const n = Math.floor(Number(cajas));
  if (!Number.isFinite(n) || n <= 0) return null;
  const textos = [userText, ...sinElMensajeDeAhora(historial, userText).filter((h) => h.rol === "user").slice(0, MAX_MENSAJES_CAJAS).map((h) => h.contenido)];
  if (textos.some((t) => RE_EN_OTRA_UNIDAD.test(t))) return n;
  return textos.some((t) => numerosDelTexto(t).has(n)) ? n : null;
}
