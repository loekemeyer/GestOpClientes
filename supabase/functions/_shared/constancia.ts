// Constancia de inscripción de ARCA (ex AFIP): lectura por REGLAS, 0 tokens. Pedido de Pablo Olejavetzky (06/10/2026).
//
// El cliente nuevo manda por WhatsApp el PDF que baja de ARCA y el bot le salta las preguntas que la constancia ya contesta (CUIT,
// razón social, condición frente al IVA y, si él lo confirma, el domicilio). Sólo lee PDF con texto; una foto o un escaneo no se leen
// (no hay IA acá: leerla costaría) y el bot sigue como siempre.
//
// Validado con UNA constancia real (06/10, persona física sin impuestos activos, impresa desde el navegador). Su diseño es:
//   "<fecha> Formulario de Impresión de Constancia de Inscripción" / "AGENCIA DE RECAUDACION Y CONTROL ADUANERO" / "CONSTANCIA DE INSCRIPCION" /
//   "<NOMBRE> CUIT: 20-…" (el nombre va antes del CUIT, en la misma línea, sin etiqueta) / "IMPUESTOS/REGIMENES NACIONALES REGISTRADOS Y FECHA DE ALTA" /
//   "No registra impuestos activos" / … / "DOMICILIO FISCAL - ARCA" / "<calle> Piso:4 Dpto:C" / "<CP>-<PROVINCIA>" /
//   "Vigencia de la presente constancia: 06-10-2026 a 05-11-2026 …". Todavía NO se vio una de persona jurídica ni una con IVA o monotributo:
//   esas partes (condición de IVA, razón social de una sociedad) siguen siendo suposiciones. Por eso el bot SIEMPRE le muestra al cliente lo que
//   leyó y espera su "sí", y si algo no cierra (sin CUIT válido, sin razón social) devuelve null y todo sigue como antes.
import { extractCuit, formatoCuit } from "./cuit.ts";

export interface DomicilioFiscal { calle: string; localidad: string; provincia: string; codigoPostal: string }
export type CondicionIva = "Responsable inscripto" | "Monotributo" | "Exento";
export interface ConstanciaDatos {
  /** 11 dígitos, con dígito verificador válido. */
  cuit: string;
  razonSocial: string;
  condicionIva: CondicionIva | null;
  domicilio: DomicilioFiscal | null;
  /** Último día de vigencia (AAAA-MM-DD): las constancias de ARCA valen 30 días. null si no la trae. */
  vigenteHasta: string | null;
}

const MAX_PDF_BYTES = 3_000_000;
const MAX_PAGINAS = 3;
const TIMEOUT_MS = 10_000;

const sinAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const limpio = (s: string) => s.replace(/\s+/g, " ").trim();
/** Mayúsculas, sin acentos y sin puntos ("C.A.B.A." → "CABA"): para buscar palabras sin depender de cómo vengan escritas. */
const norm = (s: string) => limpio(sinAcentos(s).toUpperCase().replace(/\./g, ""));

// ── PDF → líneas ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// pdf.js entrega fragmentos de texto con su posición. Con `mergePages` de unpdf el texto sale TODO en una línea (se probó el 06/10),
// así que las líneas se rearman por la coordenada vertical: lo que está a la misma altura es una línea (etiqueta y valor juntos).

export interface FragmentoTexto { str: string; transform: number[] }

export function agruparLineas(items: FragmentoTexto[]): string[] {
  const conTexto = items.filter((i) => typeof i.str === "string" && i.str.trim() && Array.isArray(i.transform));
  // De arriba hacia abajo (y mayor = más arriba en pdf.js) y, dentro de la línea, de izquierda a derecha.
  conTexto.sort((a, b) => (b.transform[5] - a.transform[5]) || (a.transform[4] - b.transform[4]));
  const lineas: Array<{ y: number; frags: FragmentoTexto[] }> = [];
  for (const it of conTexto) {
    const y = it.transform[5];
    const ult = lineas[lineas.length - 1];
    if (ult && Math.abs(ult.y - y) <= 2.5) ult.frags.push(it);
    else lineas.push({ y, frags: [it] });
  }
  return lineas
    .map((l) => limpio(l.frags.sort((a, b) => a.transform[4] - b.transform[4]).map((f) => f.str).join(" ")))
    .filter(Boolean);
}

/** Texto del PDF por líneas, o null si no se pudo (muy grande, sin texto —foto o escaneo—, dañado o tardó más de 10 s). */
export async function leerLineasPdf(bytes: Uint8Array): Promise<string[] | null> {
  if (!bytes.length || bytes.length > MAX_PDF_BYTES) return null;
  try {
    // Import dinámico: el webhook no paga el costo de cargar pdf.js salvo cuando llega un PDF de un no-cliente.
    const { getDocumentProxy } = await import("https://esm.sh/unpdf@1.4.0");
    const trabajo = (async () => {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));   // copia: pdf.js se queda con el buffer
      const lineas: string[] = [];
      for (let p = 1; p <= Math.min(pdf.numPages, MAX_PAGINAS); p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        const items = (tc.items as Array<Record<string, unknown>>).filter((i) => "str" in i) as unknown as FragmentoTexto[];
        lineas.push(...agruparLineas(items));
      }
      return lineas;
    })();
    const lineas = await Promise.race([trabajo, new Promise<null>((r) => setTimeout(() => r(null), TIMEOUT_MS))]);
    return lineas && lineas.join(" ").replace(/\s/g, "").length >= 40 ? lineas : null;
  } catch (e) {
    console.error("[constancia] no se pudo leer el PDF:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ── líneas → datos ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Etiquetas que terminan un valor cuando vienen pegadas en la misma línea ("Razón Social: ACME S.A.  CUIT: 30-…"). Sólo cuentan con ":".
const RE_ETIQUETA = /\b(CUIT|CUIL|CDI|Raz[oó]n\s+Social|Apellido\s+y\s+Nombre|Denominaci[oó]n|Domicilio(?:\s+Fiscal)?|Tipo\s+(?:de\s+)?Persona|Estado(?:\s+de\s+la\s+Clave)?|Fecha\s+de\s+[A-Za-zóÓ\s]+|Impuestos?|Actividad(?:es)?(?:\s+Principal)?|Forma\s+Jur[ií]dica|Mes\s+de\s+Cierre|Provincia|Localidad|C[oó]digo\s+Postal|Direcci[oó]n)\s*:/i;

const RE_ETIQUETA_NOMBRE =
  /(?:apellido\s*(?:y|,)?\s*nombre|raz[oó]n\s+social|denominaci[oó]n)(?:\s*(?:o|\/)\s*(?:raz[oó]n\s+social|apellido\s*y\s*nombre))?\s*:?/i;

/** Valor que sigue a una etiqueta: en la misma línea, o (si la etiqueta está sola) en la línea de abajo. */
function valorDe(lineas: string[], re: RegExp): string | null {
  for (let i = 0; i < lineas.length; i++) {
    const m = re.exec(lineas[i]);
    if (!m) continue;
    let v = limpio(lineas[i].slice(m.index + m[0].length)).replace(/^[:\-–]\s*/, "");
    if (!v) {
      const sig = lineas.slice(i + 1).find((l) => limpio(l));
      if (sig && !RE_ETIQUETA.test(sig)) v = limpio(sig);
    }
    const corte = v.search(RE_ETIQUETA);
    if (corte === 0) v = ""; else if (corte > 0) v = v.slice(0, corte);
    v = limpio(v);
    if (v) return v;
  }
  return null;
}

const PROVINCIAS: Array<[string, string]> = [
  ["CIUDAD AUTONOMA DE BUENOS AIRES", "Ciudad Autónoma de Buenos Aires"], ["CIUDAD AUTONOMA BUENOS AIRES", "Ciudad Autónoma de Buenos Aires"],
  ["CAPITAL FEDERAL", "Ciudad Autónoma de Buenos Aires"], ["CABA", "Ciudad Autónoma de Buenos Aires"],
  ["BUENOS AIRES", "Buenos Aires"], ["CATAMARCA", "Catamarca"], ["CHACO", "Chaco"], ["CHUBUT", "Chubut"], ["CORDOBA", "Córdoba"],
  ["CORRIENTES", "Corrientes"], ["ENTRE RIOS", "Entre Ríos"], ["FORMOSA", "Formosa"], ["JUJUY", "Jujuy"], ["LA PAMPA", "La Pampa"],
  ["LA RIOJA", "La Rioja"], ["MENDOZA", "Mendoza"], ["MISIONES", "Misiones"], ["NEUQUEN", "Neuquén"], ["RIO NEGRO", "Río Negro"],
  ["SALTA", "Salta"], ["SAN JUAN", "San Juan"], ["SAN LUIS", "San Luis"], ["SANTA CRUZ", "Santa Cruz"], ["SANTA FE", "Santa Fe"],
  ["SANTIAGO DEL ESTERO", "Santiago del Estero"], ["TIERRA DEL FUEGO", "Tierra del Fuego"], ["TUCUMAN", "Tucumán"],
].sort((a, b) => b[0].length - a[0].length) as Array<[string, string]>;   // los largos primero: "CIUDAD AUTONOMA BUENOS AIRES" antes que "BUENOS AIRES"

const MINUSCULAS = new Set(["DE", "DEL", "LA", "LAS", "LOS", "Y", "E", "EL"]);
function titulo(s: string): string {
  return limpio(s).toLowerCase().split(" ")
    .map((w, i) => /\d/.test(w) ? w.toUpperCase() : (i > 0 && MINUSCULAS.has(w.toUpperCase()) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Provincia que nombra un texto ya normalizado (`norm`): la última que aparece; las más largas primero y lo reconocido se tapa. */
function provinciaEn(N: string): string | null {
  let trabajo = N;
  let mejor = -1;
  let nombre: string | null = null;
  for (const [pat, nom] of PROVINCIAS) {
    for (const m of trabajo.matchAll(new RegExp(`\\b${pat}\\b`, "g"))) {
      const idx = m.index ?? -1;
      if (idx > mejor) { mejor = idx; nombre = nom; }
    }
    trabajo = trabajo.replace(new RegExp(`\\b${pat}\\b`, "g"), (x) => " ".repeat(x.length));
  }
  return nombre;
}

/** El domicilio fiscal: con sus campos etiquetados (Dirección / Localidad / Provincia / Código postal) o en una sola línea. */
function parseDomicilio(lineas: string[]): DomicilioFiscal | null {
  const sub = (re: RegExp) => valorDe(lineas, re);
  let calle = sub(/^(?:direcci[oó]n|calle)\s*:/i);
  let localidad = sub(/^localidad\s*:/i);
  let provincia = sub(/^provincia\s*:/i);
  let cp = sub(/^c[oó]d(?:igo)?\.?\s*postal\s*:|^CP\s*:/i);

  if (!calle || !provincia || !cp) {
    // En una sola línea: "AV EJEMPLO 1234 - LOCALIDAD - PROVINCIA - 1425" (puede seguir en la línea de abajo).
    const i = lineas.findIndex((l) => /domicilio\s+fiscal/i.test(l));
    if (i < 0 && !calle) return null;
    if (i >= 0) {
      // El título real es "DOMICILIO FISCAL - ARCA" (antes "- AFIP"): el " - ARCA" no es parte de la dirección.
      const partes = [lineas[i].replace(/^.*?domicilio\s+fiscal\s*(?:[-–]\s*(?:ARCA|AFIP))?\s*:?/i, "")];
      // El domicilio puede seguir en la línea de abajo, pero sólo mientras le falte la provincia o el código postal: si ya está
      // completo, lo que sigue es otra sección ("Impuestos Registrados", "Actividades") y no se mezcla.
      const completo = () => { const n = norm(partes.join(" ")); return !!provinciaEn(n) && /\b\d{4}\b/.test(n); };
      for (let j = i + 1; j < lineas.length && partes.length < 3 && !completo(); j++) {
        const l = limpio(lineas[j]);
        if (!l) continue;
        if (RE_ETIQUETA.test(l)) break;
        partes.push(l);
      }
      let texto = limpio(partes.filter((x) => limpio(x)).join(" - "));
      const corte = texto.search(RE_ETIQUETA);
      if (corte >= 0) texto = texto.slice(0, corte);
      // "1414-CIUDAD AUTONOMA BUENOS AIRES" (código postal pegado con guion) y "Piso:4 Dpto:C" (dos puntos de más) como vienen en el PDF.
      const N = norm(texto)
        .replace(/\b(\d{4})\s*-\s*(?=[A-Z])/g, "$1 - ")
        .replace(/\b(PISO|DPTO|DEPTO|OFICINA|OF|LOCAL|TORRE|UF|MONOBLOCK)\s*:\s*/g, "$1 ");
      if (!provincia) provincia = provinciaEn(N);
      const segmentos = N.split(/\s+-\s+|\s*,\s*|\s*\/\s*/).map(limpio).filter(Boolean);
      if (!calle) calle = segmentos[0] ? titulo(segmentos[0]) : null;
      const resto = segmentos.slice(1);
      if (!cp) {
        const m = N.match(/\b(?:CP|CODIGO POSTAL)\s*:?\s*([A-Z]?\d{4}[A-Z]{0,3})\b/)
          ?? resto.join(" ").match(/\b([A-Z]\d{4}[A-Z]{3})\b/)
          ?? [...resto.join(" ").matchAll(/\b(\d{4})\b/g)].pop();
        cp = m ? m[1] : null;
      }
      if (!localidad) {
        const esProv = (s: string) => PROVINCIAS.some(([pat]) => s === pat);
        const cand = resto.find((s) => !esProv(s) && !/^(?:CP|CODIGO POSTAL)?\s*:?\s*[A-Z]?\d{4}[A-Z]{0,3}$/.test(s));
        localidad = cand ? titulo(cand.replace(/\b(?:CP|CODIGO POSTAL)\b.*$/, "")) : null;
      }
    }
  }
  if (provincia) provincia = PROVINCIAS.find(([pat]) => pat === norm(provincia!))?.[1] ?? titulo(provincia);
  if (cp) cp = (norm(cp).match(/[A-Z]?\d{4}[A-Z]{0,3}/) ?? [null])[0];
  // En CABA la constancia no trae una localidad aparte: se usa la propia ciudad.
  if (!localidad && provincia === "Ciudad Autónoma de Buenos Aires") localidad = provincia;
  if (!calle || !localidad || !provincia || !cp) return null;
  // Los campos con etiqueta vienen como en el PDF (todo en mayúsculas): se presentan como un domicilio normal.
  const conTitulo = (x: string) => { const l = limpio(x); return l === l.toUpperCase() ? titulo(l) : l; };
  return { calle: conTitulo(calle), localidad: conTitulo(localidad), provincia, codigoPostal: cp };
}

function parseCondicionIva(texto: string, lineas: string[] = []): CondicionIva | null {
  const T = norm(texto);
  // La sección "IMPUESTOS/REGIMENES NACIONALES REGISTRADOS" (hasta la fila de asteriscos): una línea "IVA …" = responsable inscripto.
  const ini = lineas.findIndex((l) => /IMPUESTOS\s*\/?\s*REGIMENES/i.test(l));
  if (ini >= 0) {
    const fin = lineas.findIndex((l, i) => i > ini && /^\s*\*{3,}/.test(l));
    const seccion = norm(lineas.slice(ini + 1, fin < 0 ? ini + 12 : fin).join("\n"));
    if (/NO REGISTRA IMPUESTOS/.test(seccion)) return null;
    if (/\bIVA\s*(?:-\s*)?EXENTO\b/.test(seccion)) return "Exento";
    if (/(?:^|\n)\s*(?:\d+\s*-\s*)?IVA\b/.test(seccion) && !/NO\s+ALCANZADO|NO\s+INSCRIPTO/.test(seccion)) return "Responsable inscripto";
  }
  if (/RESPONSABLE\s+NO\s+INSCRIPTO|\bNO\s+ALCANZADO\b/.test(T)) return null;
  if (/\bIVA\s*(?:-\s*)?EXENTO\b|\b32\s*-\s*IVA\b/.test(T)) return "Exento";
  if (/RESPONSABLE\s+INSCRIPTO|\b30\s*-\s*IVA\b/.test(T)) return "Responsable inscripto";
  if (/MONOTRIBUT/.test(T)) return "Monotributo";
  return null;
}

/** "Vigencia de la presente constancia: 06-10-2026 a 05-11-2026" → "2026-11-05" (el último día). */
function parseVigenciaHasta(texto: string): string | null {
  const m = /vigencia\s+de\s+la\s+presente\s+constancia\s*:?\s*\d{2}-\d{2}-\d{4}\s*a\s*(\d{2})-(\d{2})-(\d{4})/i.exec(texto);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const RE_TITULO = /constancia\s+de\s+inscripci[oó]n/i;
const RE_NO_ES_NOMBRE = /constancia|inscripci[oó]n|afip|arca\b|agencia|rep[uú]blica|\bwww\b|https?:|c[oó]digo\s+qr|^\W*$/i;

/**
 * Datos de una constancia de inscripción, o null si el texto no parece una (sin título ni etiquetas) o no se puede confiar
 * (sin CUIT con dígito verificador válido o sin razón social). Los campos opcionales salen null y el bot los pregunta.
 */
export function parseConstancia(lineas: string[]): ConstanciaDatos | null {
  if (!lineas.length) return null;
  const todo = lineas.join(" ");

  // CUIT con etiqueta (el primero válido); el número puede estar en la línea de abajo.
  let cuit: string | null = null;
  let iCuit = -1;
  let antesCuit = "";   // lo que va antes de "CUIT:" en esa línea: en la constancia real es el nombre ("OLEJAVETZKY PABLO MARTIN CUIT: 20-…")
  for (let i = 0; i < lineas.length && !cuit; i++) {
    const m = /\b(?:CUIT|CUIL|CDI)\b\s*:?\s*(\d[\d\s\-.]{9,16}\d)?/i.exec(lineas[i]);
    if (!m) continue;
    const c = extractCuit(m[1] ?? lineas[i + 1] ?? "");
    if (c) { cuit = c; iCuit = i; antesCuit = limpio(lineas[i].slice(0, m.index)); }
  }
  if (!cuit) return null;

  // Razón social: (1) con etiqueta; (2) lo que va antes de "CUIT:" en la misma línea (diseño real de ARCA); (3) la línea de arriba del CUIT.
  const plausible = (l: string) => l.length >= 3 && l.length <= 100 && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(l) && !RE_NO_ES_NOMBRE.test(l) && !RE_ETIQUETA.test(l) && !/\d{4,}/.test(l);
  let razonSocial = valorDe(lineas, RE_ETIQUETA_NOMBRE);
  if (!razonSocial && plausible(antesCuit)) razonSocial = antesCuit;
  if (!razonSocial) {
    for (let j = iCuit - 1; j >= Math.max(0, iCuit - 3); j--) {
      const l = limpio(lineas[j]);
      if (l && plausible(l)) { razonSocial = l; break; }
    }
  }
  if (!razonSocial || razonSocial.length < 3 || razonSocial.length > 120 || /\d{8,}/.test(razonSocial)) return null;

  // ¿Es una constancia? Por el título o, si el título es una imagen, por tener razón social y domicilio fiscal con etiqueta.
  const esConstancia = RE_TITULO.test(todo) || (/domicilio\s+fiscal/i.test(todo) && RE_ETIQUETA_NOMBRE.test(todo));
  if (!esConstancia) return null;

  return { cuit, razonSocial, condicionIva: parseCondicionIva(todo, lineas), domicilio: parseDomicilio(lineas), vigenteHasta: parseVigenciaHasta(todo) };
}

/** PDF → datos de la constancia, o null (no es PDF con texto, no es una constancia, o no se puede confiar en lo que dice). */
export async function leerConstancia(bytes: Uint8Array): Promise<ConstanciaDatos | null> {
  const lineas = await leerLineasPdf(bytes);
  return lineas ? parseConstancia(lineas) : null;
}

export const textoDomicilio = (d: DomicilioFiscal) => `${d.calle}, ${d.localidad}, ${d.provincia} (CP ${d.codigoPostal})`;

/** Lo que se le muestra al cliente para que confirme (siempre: nada se usa sin su "sí"). */
export function textoConfirmaConstancia(d: ConstanciaDatos): string {
  return `Leí tu constancia de inscripción. 📄\n\n` +
    `• CUIT: ${formatoCuit(d.cuit)}\n` +
    `• Razón social: ${d.razonSocial}\n` +
    (d.condicionIva ? `• Condición frente al IVA: ${d.condicionIva}\n` : "") +
    `\n¿Son correctos? Respondé *sí* y sigo con el resto de los datos, o *no* y los cargamos a mano.`;
}
