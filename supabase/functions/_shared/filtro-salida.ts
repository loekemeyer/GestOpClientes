// Filtro de salida del agente: revisa EN CÓDIGO lo que el modelo va a mandarle al cliente (Pablo Olejavetzky, 06/10/2026, medida 3 de la
// lista de seguridad). 0 tokens, sin red: módulo PURO, se prueba en tests/filtro-salida.test.ts.
//
// POR QUÉ: el bloque de Seguridad del prompt (agente-fijos.ts) le pide buena conducta a un modelo, y un jailbreak lo rompe. Este filtro es la
// única defensa que sigue en pie si el modelo se rinde: mira la respuesta ya escrita y, si trae algo que NUNCA debería salir, la reemplaza por un
// texto fijo y avisa a una persona (bot-conversation.ts › filtrarSalida). Cinco categorías, de lo más a lo menos seguro de bloquear:
//   0. canario               el código de control que va dentro del prompt (canario.ts) apareció en la respuesta: el modelo copió el prompt, aunque lo
//                            haya parafraseado o codificado. Cubre lo que la categoría 3 no ve.
//   1. secreto               claves, tokens, JWT, nombres de variables de entorno, hosts de APIs internas. Nunca tienen un uso legítimo en un chat.
//   2. identificador_interno nombres de herramientas, tablas, funciones y modelos, y SQL. Un cliente no tiene por qué ver "armar_pedido" ni "bot_*".
//   3. prompt                un volcado literal del bloque de Seguridad (14 palabras seguidas). Una paráfrasis, traducción o base64 NO la detecta:
//                            para eso está el canario (categoría 0), mientras el modelo copie el código.
//   4. dato_no_respaldado    un número de 10 dígitos o más (CUIT, teléfono, CBU, factura) o un mail que NO está en nada de lo que el modelo vio
//                            en este turno (prompt, mensajes de la charla, resultados de herramientas). Las herramientas ya operan sólo sobre la
//                            cuenta de quien escribe, así que un dato ajeno sólo puede venir de una alucinación o de una fuga: en los dos casos no sale.
//
// Calibrado el 06/10 contra las 895 respuestas reales del bot en bot_historial_chat (34 teléfonos, desde abril): 0 con prefijos internos o
// claves; los números largos que aparecen son el teléfono y el CBU de la empresa, CUITs y teléfonos del propio cliente, y los únicos mails son
// @loekemeyer.com. Falla "abierto" sólo en lo que no se puede juzgar sin corpus: si no se pasa corpus, la categoría 4 no corre.

import { contieneCanario } from "./canario.ts";

export type CategoriaBloqueo = "canario" | "secreto" | "identificador_interno" | "prompt" | "dato_no_respaldado";
export interface Hallazgo { categoria: CategoriaBloqueo; que: string }
export type VeredictoSalida = { ok: true } | { ok: false; hallazgos: Hallazgo[] };

export interface EntradaFiltro {
  /** Lo que el modelo quiere mandar. */
  reply: string;
  /** Todo lo que el modelo vio en este turno: prompt del sistema, mensajes de la charla (cliente y bot) y resultados de herramientas. */
  corpus: string[];
  /** Nombres de las herramientas del agente (se arman con BOT_TOOLS, no se copian acá). */
  herramientas: string[];
  /** Texto del bloque de Seguridad tal como lo recibió el modelo (para detectar un volcado). */
  bloqueSeguridad?: string;
  /** Código de control que va dentro del prompt (canario.ts). Si aparece en la respuesta, el modelo copió el prompt. */
  canario?: string | null;
}

/** Texto fijo que reemplaza una respuesta bloqueada. No dice por qué (no revela el mecanismo) y es verdad: una persona recibe la alerta. */
export const TEXTO_SALIDA_BLOQUEADA =
  "Perdoná, con eso no te puedo ayudar por este medio. Una persona del equipo te escribe por acá para ayudarte.";

// ── 1. Secretos ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SECRETOS: Array<[RegExp, string]> = [
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{6,}/, "clave de Supabase (sb_…)"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, "token JWT"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/, "clave de Anthropic"],
  [/\bsk-[A-Za-z0-9]{24,}/, "clave de API (sk-…)"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "clave de Google"],
  [/\bEAA[A-Za-z0-9]{30,}/, "token de Meta"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/, "encabezado Bearer con token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "clave privada"],
  [/\b(?:service_role|x-lk-secret|META_APP_SECRET|ANTHROPIC_API_KEY|GEMINI_API_KEY|LK_[A-Z_]{4,}|SUPABASE_[A-Z_]{3,})\b/, "nombre de variable secreta"],
  [/\b(?:graph\.facebook\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)\b/i, "host de una API interna"],
];

// ── 2. Identificadores internos ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const RE_PREFIJO_INTERNO = /(?<![A-Za-z0-9_])(?:bot|wa|lk|gv|isis|krikos)_[a-z][a-z0-9_]{2,}\b/;
const RE_TABLA_INTERNA = /(?<![A-Za-z0-9_])(?:app_settings|customers?_[a-z_]{3,}|orders?_[a-z_]{3,}|products?_[a-z_]{3,}|public\.[a-z_]{3,})\b/;
const RE_MODELO = /\b(?:claude-(?:sonnet|opus|haiku|fable)[a-z0-9.-]*|gemini-[0-9][a-z0-9.-]*|gpt-[0-9][a-z0-9.-]*)\b/i;
const RE_SQL = /\b(?:select\s+[\s\S]{1,200}?\s+from\s+[a-z_.]+|insert\s+into\s+[a-z_.]+|delete\s+from\s+[a-z_.]+|drop\s+(?:table|schema|function)\s+\S+|truncate\s+table\s+\S+|update\s+[a-z_.]+\s+set\s)/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── 3. Volcado del prompt ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Palabras seguidas, tal cual, del bloque de Seguridad que delatan un volcado. Con 10 una negativa legítima ya daba falso positivo (las
 *  pruebas lo encontraron el 06/10): "No tengo capacidad de ejecutar SQL, código ni comandos, ni de borrar…" comparte 10 palabras con la
 *  regla, y es justo lo que el prompt le pide decir. Una regla copiada entera tiene entre 20 y 40 palabras, así que 14 sigue atrapando un
 *  volcado. */
export const VENTANA_VOLCADO = 14;

function normalizar(texto: string): string[] {
  return String(texto ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function ventanas(palabras: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= palabras.length; i++) out.add(palabras.slice(i, i + n).join(" "));
  return out;
}

// ── 4. Datos no respaldados ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// No cuenta un número pegado a letras o guion bajo (dígitos dentro de una clave tipo sb_secret_…1234567890: ya se bloquea como secreto).
// Un "número largo" son grupos de dígitos unidos por UN solo separador (espacio, punto o guion): "30-71793040-8", "11 3118 1594", "5491162521635".
// Un separador más largo (" - ", ", ") corta el número: "505 - 1590 - 12" son tres números chicos, no uno de 9 dígitos.
// No cuenta un número pegado a letras o guion bajo (dígitos dentro de una clave tipo sb_secret_…1234567890: ya se bloquea como secreto).
const RE_NUMERO_LARGO = /(?<![A-Za-z0-9_])\d+(?:[ .\-]\d+)*(?![A-Za-z0-9_])/g;
/** Un importe con formato argentino ("17.554", "$1.234.567,89"). Una lista de importes separados por espacio sumaría 10 dígitos y parecería un CUIT. */
const RE_IMPORTE = /\$?\s?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?(?![\d])/g;
const RE_MAIL = /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** Desde cuántos dígitos un número se considera un dato personal (CUIT 11, teléfono 10 a 13, CBU 22, comprobante). Un importe no llega. */
export const MIN_DIGITOS = 10;

const soloDigitos = (s: string) => s.replace(/\D/g, "");

/** "505 501 067 012": una lista de códigos de artículo (grupos de exactamente 3 dígitos, tres o más) no es un teléfono ni un CUIT. */
function esListaDeCodigos(token: string): boolean {
  const g = token.split(/[ .\-]/).filter(Boolean);
  return g.length >= 3 && g.every((x) => x.length === 3);
}

/** Los números largos de un texto (sólo dígitos). Los importes de menos de 10 dígitos se sacan antes: "1.590 2.300 12.000" no es un número. */
function numerosLargos(texto: string): string[] {
  const t = String(texto ?? "").replace(RE_IMPORTE, (m) => soloDigitos(m).length < MIN_DIGITOS ? " " : m);
  const out: string[] = [];
  for (const m of t.matchAll(RE_NUMERO_LARGO)) {
    const d = soloDigitos(m[0]);
    if (d.length >= MIN_DIGITOS && !esListaDeCodigos(m[0])) out.push(d);
  }
  return out;
}

function corridasDeDigitos(textos: string[]): string[] {
  return textos.flatMap(numerosLargos);
}

/** Un número queda respaldado si algo que el modelo vio lo contiene o lo contiene a él ("1162521635" dentro de "5491162521635"). */
function numeroRespaldado(d: string, vistas: string[]): boolean {
  return vistas.some((v) => v.includes(d) || d.includes(v));
}

/** Saca de un texto lo que no puede quedar guardado en una alerta (claves, tokens). Se usa para el recorte de la respuesta bloqueada. */
export function redactarSecretos(texto: string): string {
  let t = String(texto ?? "");
  for (const [re] of SECRETOS) t = t.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "[…]");
  return t;
}

export function revisarSalida(e: EntradaFiltro): VeredictoSalida {
  const reply = String(e.reply ?? "");
  const hallazgos: Hallazgo[] = [];
  const agregar = (categoria: CategoriaBloqueo, que: string) => { if (!hallazgos.some((h) => h.categoria === categoria && h.que === que)) hallazgos.push({ categoria, que }); };

  // 0. Canario: el código de control del prompt en la respuesta, tal cual o disfrazado (base64, hex, al revés…). Es la señal más fuerte de todas.
  const can = contieneCanario(reply, e.canario);
  if (can.hallado) agregar("canario", `código de control del prompt copiado (${can.como})`);

  // 1. Secretos
  for (const [re, que] of SECRETOS) if (re.test(reply)) agregar("secreto", que);

  // 2. Identificadores internos: herramientas (nombres exactos), tablas, modelos, SQL
  const nombres = e.herramientas.filter((n) => n.length >= 4);
  if (nombres.length) {
    const re = new RegExp(`(?<![A-Za-z0-9_])(?:${nombres.map(esc).join("|")})(?![A-Za-z0-9_])`);
    const m = reply.match(re);
    if (m) agregar("identificador_interno", `herramienta: ${m[0]}`);
  }
  const pref = reply.match(RE_PREFIJO_INTERNO) ?? reply.match(RE_TABLA_INTERNA);
  if (pref) agregar("identificador_interno", `tabla o función interna: ${pref[0]}`);
  const mod = reply.match(RE_MODELO);
  if (mod) agregar("identificador_interno", `modelo de IA: ${mod[0]}`);
  if (RE_SQL.test(reply)) agregar("identificador_interno", "sentencia SQL");

  // 3. Volcado literal del bloque de Seguridad
  if (e.bloqueSeguridad) {
    const delReply = normalizar(reply);
    if (delReply.length >= VENTANA_VOLCADO) {
      const delPrompt = ventanas(normalizar(e.bloqueSeguridad), VENTANA_VOLCADO);
      for (let i = 0; i + VENTANA_VOLCADO <= delReply.length; i++) {
        if (delPrompt.has(delReply.slice(i, i + VENTANA_VOLCADO).join(" "))) { agregar("prompt", `volcado del bloque de Seguridad (${VENTANA_VOLCADO} palabras seguidas)`); break; }
      }
    }
  }

  // 4. Números largos y mails que no están en nada de lo que el modelo vio (sólo si hay corpus: sin él no se puede juzgar)
  if (e.corpus.length) {
    const vistas = corridasDeDigitos(e.corpus);
    for (const d of numerosLargos(reply)) {
      if (!numeroRespaldado(d, vistas)) { agregar("dato_no_respaldado", `número de ${d.length} dígitos que no figura en la charla ni en los datos del cliente`); break; }
    }
    const corpusMin = e.corpus.join("\n").toLowerCase();
    for (const m of reply.matchAll(RE_MAIL)) {
      if (!corpusMin.includes(m[0].toLowerCase())) { agregar("dato_no_respaldado", "mail que no figura en la charla ni en los datos del cliente"); break; }
    }
  }

  return hallazgos.length ? { ok: false, hallazgos } : { ok: true };
}

/** Modo del filtro (`app_settings.wa_filtro_salida`): "1" o sin fila = bloquea y avisa; "log" = sólo avisa y deja salir la respuesta (para
 *  mirar falsos positivos sin cortarle nada a un cliente); "0" = apagado. Cualquier otro valor se toma como "1": ante la duda, protege. */
export type ModoFiltro = "bloquear" | "log" | "apagado";
export function modoDelFiltro(valor: string | null | undefined): ModoFiltro {
  const v = String(valor ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "apagado") return "apagado";
  if (v === "log" || v === "solo_log" || v === "aviso") return "log";
  return "bloquear";
}

/** Qué hacer con lo que encontró el filtro, según el modo. El canario bloquea SIEMPRE, también en modo "log": no tiene falsos positivos que
 *  mirar, y dejarlo salir le entregaría el código al cliente. Su alerta es propia (`origen: canario`) para que un aviso menor del filtro, dentro
 *  de la misma hora, no la tape. */
export function decidirSalida(modo: ModoFiltro, hallazgos: Hallazgo[]): { bloquea: boolean; hayCanario: boolean; origen: "canario" | "filtro_salida"; urgente: boolean } {
  const hayCanario = hallazgos.some((h) => h.categoria === "canario");
  const bloquea = modo === "bloquear" || hayCanario;
  return { bloquea, hayCanario, origen: hayCanario ? "canario" : "filtro_salida", urgente: bloquea };
}
