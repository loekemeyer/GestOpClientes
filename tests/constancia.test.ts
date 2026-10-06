// Constancia de inscripción de ARCA (supabase/functions/_shared/constancia.ts + el flujo en _shared/alta.ts). Sin red de Supabase, sin IA, US$ 0.
// Correr: deno run --allow-env --allow-net --allow-read tests/constancia.test.ts   (sale con código 1 si algo falla; --allow-net sólo para bajar pdf-lib y unpdf)
//
// ⚠ Los PDF de acá son SINTÉTICOS (se arman con pdf-lib). Ninguna constancia real pasó por este lector todavía: cuando haya una,
// agregarla como caso (sin subirla al repo, que es público: sólo el texto con datos inventados).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
// Base simulada: toda lectura devuelve [] (salvo las tablas de `filasPorTabla`) y toda escritura 201; se anotan las llamadas.
const llamadas: Array<{ metodo: string; url: string; body: string }> = [];
const filasPorTabla: Record<string, unknown[]> = {};
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const get = req.method === "GET";
  llamadas.push({ metodo: req.method, url: req.url, body: get ? "" : await req.clone().text() });
  const fila = get ? Object.entries(filasPorTabla).find(([t]) => req.url.includes(`/rest/v1/${t}?`)) : undefined;
  if (fila) return new Response(JSON.stringify(fila[1]), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(get ? "[]" : "", { status: get ? 200 : 201, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { agruparLineas, leerConstancia, parseConstancia, textoConfirmaConstancia } = await import("../supabase/functions/_shared/constancia.ts");
const { validaCuit } = await import("../supabase/functions/_shared/cuit.ts");
const { ALTA_INTRO, MSG_CUIT_YA_CLIENTE, handleAltaStep, procesarConstancia, promptActual } = await import("../supabase/functions/_shared/alta.ts");
const { SIM } = await import("../supabase/functions/_shared/simulacion.ts");
const { PDFDocument, StandardFonts } = await import("https://esm.sh/pdf-lib@1.17.1");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const cuitCon = (pre: string) => { let dv = 0; while (!validaCuit(`${pre}${dv}`)) dv++; return `${pre}${dv}`; };
const CUIT_J = cuitCon("3071234567");   // persona jurídica (30-…)
const CUIT_F = cuitCon("2012345678");   // persona física (20-…)
const guiones = (c: string) => `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;

// ── agruparLineas: lo que está a la misma altura es una línea, de izquierda a derecha ──
igual("agrupa por altura y ordena por x", agruparLineas([
  { str: "EJEMPLO S.A.", transform: [1, 0, 0, 1, 200, 700.4] }, { str: "Razón Social:", transform: [1, 0, 0, 1, 40, 700] },
  { str: "CUIT:", transform: [1, 0, 0, 1, 40, 740] }, { str: "  ", transform: [1, 0, 0, 1, 90, 740] }, { str: guiones(CUIT_J), transform: [1, 0, 0, 1, 80, 739] },
]), [`CUIT: ${guiones(CUIT_J)}`, "Razón Social: EJEMPLO S.A."]);

// ── parseConstancia: varios diseños posibles ──
const CABA = "Ciudad Autónoma de Buenos Aires";
igual("diseño 'Etiqueta: valor' (jurídica, IVA, domicilio en una línea, CABA)", parseConstancia([
  "Constancia de Inscripción", `CUIT: ${guiones(CUIT_J)}`, "Razón Social: EJEMPLO COMERCIAL S.A.",
  "Domicilio Fiscal: AV EJEMPLO 1234 - CIUDAD AUTONOMA BUENOS AIRES - 1425", "Impuestos Registrados", "30 - IVA", "Actividades",
]), { cuit: CUIT_J, razonSocial: "EJEMPLO COMERCIAL S.A.", condicionIva: "Responsable inscripto",
  domicilio: { calle: "Av Ejemplo 1234", localidad: CABA, provincia: CABA, codigoPostal: "1425" }, vigenteHasta: null });

igual("diseño con la etiqueta sola y el valor abajo (SRL, interior)", parseConstancia([
  "Constancia de Inscripción", "CUIT:", guiones(CUIT_J), "Razón Social", "EJEMPLO S.R.L.", "Domicilio Fiscal",
  "CALLE FALSA 123 - ROSARIO - SANTA FE - 2000", "IVA EXENTO",
]), { cuit: CUIT_J, razonSocial: "EJEMPLO S.R.L.", condicionIva: "Exento",
  domicilio: { calle: "Calle Falsa 123", localidad: "Rosario", provincia: "Santa Fe", codigoPostal: "2000" }, vigenteHasta: null });

igual("persona física, monotributo, domicilio con campos etiquetados", parseConstancia([
  "Constancia de Inscripción", "Apellido y Nombre: PEREZ JUAN CARLOS", `CUIT: ${guiones(CUIT_F)}`, "Tipo de Persona: FISICA", "Domicilio Fiscal",
  "Dirección: SAN MARTIN 456", "Localidad: GODOY CRUZ", "Provincia: MENDOZA", "Código Postal: 5501", "Impuestos", "20 - MONOTRIBUTO",
]), { cuit: CUIT_F, razonSocial: "PEREZ JUAN CARLOS", condicionIva: "Monotributo",
  domicilio: { calle: "San Martin 456", localidad: "Godoy Cruz", provincia: "Mendoza", codigoPostal: "5501" }, vigenteHasta: null });

igual("el nombre solo, arriba del CUIT y sin etiqueta", parseConstancia([
  "AFIP", "Constancia de Inscripción", "EJEMPLO COMERCIAL S.A.", `CUIT: ${guiones(CUIT_J)}`,
])?.razonSocial, "EJEMPLO COMERCIAL S.A.");

igual("sin domicilio ni IVA legibles: igual devuelve CUIT y razón social", parseConstancia([
  "Constancia de Inscripción", `CUIT: ${guiones(CUIT_J)}`, "Razón Social: EJEMPLO S.A.",
]), { cuit: CUIT_J, razonSocial: "EJEMPLO S.A.", condicionIva: null, domicilio: null, vigenteHasta: null });

igual("el valor termina donde empieza la etiqueta siguiente (misma línea)", parseConstancia([
  "Constancia de Inscripción", `Razón Social: EJEMPLO S.A.   CUIT: ${guiones(CUIT_J)}`,
])?.razonSocial, "EJEMPLO S.A.");

// ── el diseño de una constancia REAL de ARCA (06/10; los datos de acá son inventados) ──
// "<NOMBRE> CUIT: …" en una sola línea (el nombre va antes del CUIT, sin etiqueta), "DOMICILIO FISCAL - ARCA", "<CP>-<PROVINCIA>" y la vigencia.
const LINEAS_REALES = (nombre: string, cuit: string, impuestos: string[], domicilio: string[], vigencia = "06-10-2026 a 05-11-2026") => [
  "6/10/26, 15:13 Formulario de Impresión de Constancia de Inscripción", "AGENCIA DE RECAUDACION Y CONTROL ADUANERO", "CONSTANCIA DE INSCRIPCION",
  `${nombre} CUIT: ${guiones(cuit)}`, "IMPUESTOS/REGIMENES NACIONALES REGISTRADOS Y FECHA DE ALTA", ...impuestos,
  "****************************************************",
  "Contribuyente no amparado en los beneficios promocionales INDUSTRIALES establecidos por Ley 22021 y sus modificatorias 22702 y 22973, a la",
  "fecha de emision de la presente constancia.", "Esta constancia no da cuenta de la inscripción en:",
  "- Impuesto Bienes Personales y Exteriorización - Ley 26476: de corresponder, deberán solicitarse en la dependencia donde se encuentra",
  "- Impuesto a las Ganancias: la condición de exenta, para las entidades enunciadas en los incisos b), d), e), f), g), m) y r) del Art. 20 de la",
  "DOMICILIO FISCAL - ARCA", ...domicilio,
  `Vigencia de la presente constancia: ${vigencia} Hora 15:12:50 Verificador 123456789012`,
  "Los datos contenidos en la presente constancia deberán ser validados por el receptor de la misma en la página institucional de ARCA http://www.arca.gob.ar .",
  "https://seti.afip.gob.ar/padron-puc-constancia-internet/ConsultaConstanciaAction.do 1/1",
];
igual("constancia real: persona física sin impuestos (nombre antes del CUIT, CP-provincia, Piso:/Dpto:, vigencia)", parseConstancia(
  LINEAS_REALES("PEREZ JUAN CARLOS", CUIT_F, ["No registra impuestos activos"], ["AV EJEMPLO 57 Piso:4 Dpto:C", "1414-CIUDAD AUTONOMA BUENOS AIRES"])),
  { cuit: CUIT_F, razonSocial: "PEREZ JUAN CARLOS", condicionIva: null,
    domicilio: { calle: "Av Ejemplo 57 Piso 4 Dpto C", localidad: CABA, provincia: CABA, codigoPostal: "1414" }, vigenteHasta: "2026-11-05" });
igual("constancia real: sociedad con IVA registrado y domicilio en el interior", parseConstancia(
  LINEAS_REALES("EJEMPLO COMERCIAL S.A.", CUIT_J, ["IVA 03-2010", "GANANCIAS SOCIEDADES 03-2010"], ["CALLE FALSA 123", "2000-ROSARIO - SANTA FE"])),
  { cuit: CUIT_J, razonSocial: "EJEMPLO COMERCIAL S.A.", condicionIva: "Responsable inscripto",
    domicilio: { calle: "Calle Falsa 123", localidad: "Rosario", provincia: "Santa Fe", codigoPostal: "2000" }, vigenteHasta: "2026-11-05" });
igual("constancia real: monotributista", parseConstancia(
  LINEAS_REALES("PEREZ JUAN CARLOS", CUIT_F, ["MONOTRIBUTO 05-2018"], ["SAN MARTIN 456", "5501-GODOY CRUZ - MENDOZA"]))?.condicionIva, "Monotributo");
igual("el texto legal de la constancia ('exenta' de Ganancias) no la vuelve IVA exento", parseConstancia(
  LINEAS_REALES("PEREZ JUAN CARLOS", CUIT_F, ["No registra impuestos activos"], ["AV EJEMPLO 57", "1414-CIUDAD AUTONOMA BUENOS AIRES"]))?.condicionIva, null);

// ── lo que NO es una constancia ──
igual("una factura (con CUIT y razón social) no es una constancia", parseConstancia(["FACTURA A", `CUIT: ${guiones(CUIT_J)}`, "Razón Social: EJEMPLO S.A."]), null);
igual("CUIT con dígito verificador inválido", parseConstancia(["Constancia de Inscripción", "CUIT: 30-71234567-0", "Razón Social: EJEMPLO S.A."].map((l) => l.replace("-0", CUIT_J.endsWith("0") ? "-1" : "-0"))), null);
igual("sin razón social", parseConstancia(["Constancia de Inscripción", `CUIT: ${guiones(CUIT_J)}`]), null);
igual("texto vacío", parseConstancia([]), null);

// ── PDF de punta a punta (pdf-lib arma el PDF, unpdf lo lee, el parser lo interpreta) ──
async function pdf(lineas: Array<[string, string?]>) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const fuente = await doc.embedFont(StandardFonts.Helvetica);
  lineas.forEach(([a, b], i) => {
    page.drawText(a, { x: 40, y: 780 - i * 22, size: 11, font: fuente });
    if (b) page.drawText(b, { x: 230, y: 780 - i * 22, size: 11, font: fuente });   // el valor en una columna aparte, a la misma altura
  });
  return new Uint8Array(await doc.save());
}
const esperado = { cuit: CUIT_J, razonSocial: "EJEMPLO COMERCIAL S.A.", condicionIva: "Responsable inscripto",
  domicilio: { calle: "Av Ejemplo 1234", localidad: CABA, provincia: CABA, codigoPostal: "1425" }, vigenteHasta: null };

igual("PDF: etiqueta y valor en la misma línea", await leerConstancia(await pdf([
  ["Constancia de Inscripción"], [`CUIT: ${guiones(CUIT_J)}`], ["Razón Social: EJEMPLO COMERCIAL S.A."],
  ["Domicilio Fiscal: AV EJEMPLO 1234 - CIUDAD AUTONOMA BUENOS AIRES - 1425"], ["Impuestos"], ["30 - IVA"],
])), esperado);

igual("PDF: etiquetas a la izquierda y valores en una segunda columna", await leerConstancia(await pdf([
  ["Constancia de Inscripción"], ["CUIT", guiones(CUIT_J)], ["Razón Social", "EJEMPLO COMERCIAL S.A."],
  ["Domicilio Fiscal", "AV EJEMPLO 1234 - CIUDAD AUTONOMA BUENOS AIRES - 1425"], ["Impuestos", "30 - IVA"],
])), esperado);

igual("PDF con el diseño real (datos inventados): de punta a punta", (await leerConstancia(await pdf(
  LINEAS_REALES("PEREZ JUAN CARLOS", CUIT_F, ["No registra impuestos activos"], ["AV EJEMPLO 57 Piso:4 Dpto:C", "1414-CIUDAD AUTONOMA BUENOS AIRES"]).map((l) => [l.slice(0, 118)] as [string]))))
  ?.razonSocial, "PEREZ JUAN CARLOS");
igual("PDF que no es una constancia (una factura)", await leerConstancia(await pdf([["FACTURA A"], [`CUIT: ${guiones(CUIT_J)}`], ["Razón Social: EJEMPLO S.A."], ["Total: $ 1.000"]])), null);
{
  const doc = await PDFDocument.create(); doc.addPage([595, 842]);   // una hoja sin texto, como un escaneo o una foto
  igual("PDF sin texto (escaneo): null, sigue como siempre", await leerConstancia(new Uint8Array(await doc.save())), null);
}
igual("bytes que no son un PDF: null", await leerConstancia(new TextEncoder().encode("esto no es un pdf, ".repeat(10))), null);
igual("archivo vacío: null", await leerConstancia(new Uint8Array(0)), null);

// ── el flujo con el cliente (base simulada) ──
SIM.activo = true;   // el alta no pide vinculaciones reales ni crea la alerta de Tareas
const datos = parseConstancia(["Constancia de Inscripción", `CUIT: ${guiones(CUIT_J)}`, "Razón Social: EJEMPLO COMERCIAL S.A.",
  "Domicilio Fiscal: AV EJEMPLO 1234 - ROSARIO - SANTA FE - 2000", "30 - IVA"])!;
const tel = "5490000000001";
const escrituras = (tabla: string, metodo: string) => llamadas.filter((c) => c.metodo === metodo && c.url.includes(`/rest/v1/${tabla}`));
const enviados: string[] = [];
const send = async (r: string) => { enviados.push(r); };
const ult = () => enviados[enviados.length - 1];
const nuevo = () => { llamadas.length = 0; enviados.length = 0; };
const pendiente = (extra: Record<string, unknown> = {}) => ({ id: 7, cuit: null, razon_social: null, condicion_iva: null, direccion: null, alta_step: 0, updated_at: new Date().toISOString(),
  raw_messages: [{ role: "user", content: "x" }, { role: "constancia", estado: "pendiente", datos, archivo: "p/a.pdf", desdeConstancia: false, ts: "t" }], ...extra });

ALTA_INTRO.includes("constancia de inscripción") ? igual("el alta ofrece mandar la constancia", true, true) : igual("el alta ofrece mandar la constancia", false, true);

// Llega la constancia y no hay alta: se abre con el CUIT y se le muestra lo leído.
nuevo(); filasPorTabla["wa_prospect_leads"] = [];
await procesarConstancia(tel, datos, "p/a.pdf", send);
igual("sin alta: le muestra lo que leyó y pide el sí", [ult().includes("Leí tu constancia"), ult().includes("EJEMPLO COMERCIAL S.A."), ult().includes(guiones(CUIT_J)), ult().includes("Responsable inscripto")], [true, true, true, true]);
igual("sin alta: abre el lead con el CUIT y la constancia pendiente", escrituras("wa_prospect_leads", "POST").some((c) => c.body.includes(CUIT_J) && c.body.includes('"pendiente"') && c.body.includes("desdeConstancia\":true")), true);

// Constancia vencida (valen 30 días): no se usa, y se le dice qué hacer.
nuevo(); filasPorTabla["wa_prospect_leads"] = [];
await procesarConstancia(tel, { ...datos, vigenteHasta: "2020-01-31" }, null, send);
igual("constancia vencida: avisa la fecha y no abre ningún alta", [ult().includes("venció el 31/01/2020"), ult().includes("registrarme"), escrituras("wa_prospect_leads", "POST").length], [true, true, 0]);
nuevo(); filasPorTabla["wa_prospect_leads"] = [{ id: 7, cuit: null, alta_step: 0, raw_messages: [], updated_at: new Date().toISOString() }];
await procesarConstancia(tel, { ...datos, vigenteHasta: "2020-01-31" }, null, send);
igual("constancia vencida con un alta en curso: repite la pregunta pendiente y no guarda nada", [ult().includes("venció"), ult().includes("CUIT"), escrituras("wa_prospect_leads", "PATCH").length], [true, true, 0]);
nuevo(); filasPorTabla["wa_prospect_leads"] = [];
await procesarConstancia(tel, { ...datos, vigenteHasta: "2099-12-31" }, null, send);
igual("constancia vigente: se lee normal", ult().includes("Leí tu constancia"), true);

// Con un alta en curso: se suma al lead, sin crear otro.
nuevo(); filasPorTabla["wa_prospect_leads"] = [{ id: 7, cuit: null, alta_step: 0, raw_messages: [], updated_at: new Date().toISOString() }];
await procesarConstancia(tel, datos, "p/a.pdf", send);
igual("con alta en curso: la suma al mismo lead", [escrituras("wa_prospect_leads", "POST").length, escrituras("wa_prospect_leads", "PATCH").some((c) => c.body.includes('"pendiente"'))], [0, true]);

// El CUIT de la constancia no es el que ya había pasado.
nuevo(); filasPorTabla["wa_prospect_leads"] = [{ id: 7, cuit: CUIT_F, alta_step: 0, raw_messages: [], updated_at: new Date().toISOString() }];
await procesarConstancia(tel, datos, null, send);
igual("CUIT distinto al que ya pasó: lo avisa y no guarda nada", [ult().includes("no es el que me pasaste antes"), escrituras("wa_prospect_leads", "PATCH").length], [true, 0]);

// El CUIT ya es cliente (Loekemeyer o sólo Chef): vinculación, no alta.
for (const [tabla, que] of [["customers", "Loekemeyer"], ["bot_cuentas", "sólo Chef"]] as const) {
  nuevo(); filasPorTabla["wa_prospect_leads"] = [{ id: 7, cuit: null, alta_step: 0, raw_messages: [], updated_at: new Date().toISOString() }]; filasPorTabla[tabla] = [{ id: "c1" }];
  await procesarConstancia(tel, datos, null, send);
  igual(`el CUIT ya es cliente de ${que}: corta el alta y va a revisión humana`, [ult() === MSG_CUIT_YA_CLIENTE, escrituras("wa_prospect_leads", "PATCH").some((c) => c.body.includes("cancelled"))], [true, true]);
  delete filasPorTabla[tabla];
}
filasPorTabla["wa_prospect_leads"] = [];

// Confirma ("sí"): completa CUIT, razón social e IVA y sigue con la primera pregunta que falte.
nuevo();
await handleAltaStep(tel, "Sí", pendiente(), send);
{
  const p = escrituras("wa_prospect_leads", "PATCH")[0];
  const b = p ? JSON.parse(p.body) : {};
  igual("'sí': guarda CUIT, razón social e IVA", [b.cuit, b.razon_social, b.condicion_iva], [CUIT_J, "EJEMPLO COMERCIAL S.A.", "Responsable inscripto"]);
  igual("'sí': salta a 'nombre de contacto' (paso 3) y marca la constancia como aplicada", [b.alta_step, ult().includes("Nombre de contacto"), JSON.stringify(b.raw_messages).includes('"aplicada"')], [3, true, true]);
}
nuevo();
await handleAltaStep(tel, "correcto", pendiente(), send);
igual("'correcto' también confirma", ult().includes("Nombre de contacto"), true);

// Dice que no: se descarta y se sigue a mano (y si el alta nació de la constancia, se saca el CUIT que trajo).
nuevo();
await handleAltaStep(tel, "No", pendiente(), send);
igual("'no': se descarta, no guarda datos y sigue a mano", [ult().startsWith("Listo, seguimos a mano"), escrituras("wa_prospect_leads", "PATCH").some((c) => c.body.includes("razon_social")), ult().includes("CUIT")], [true, false, true]);
nuevo();
await handleAltaStep(tel, "No", pendiente({ cuit: CUIT_J, raw_messages: [{ role: "constancia", estado: "pendiente", datos, desdeConstancia: true, ts: "t" }] }), send);
igual("'no' en un alta que nació de la constancia: saca el CUIT y vuelve a pedirlo", [JSON.parse(escrituras("wa_prospect_leads", "PATCH")[0].body).cuit, ult().includes("CUIT")], [null, true]);
nuevo();
await handleAltaStep(tel, "Mi razón social es otra", pendiente(), send);
igual("contesta otra cosa: deja la constancia de lado y repregunta (no lo toma como respuesta)", [ult().startsWith("Dejo la constancia de lado"), escrituras("wa_prospect_leads", "PATCH").some((c) => c.body.includes('"razon_social":"Mi'))], [true, false]);

// Una constancia ya aplicada no se vuelve a aplicar con un "sí" posterior (otra pregunta).
nuevo();
await handleAltaStep(tel, "Juan Pérez", { id: 7, cuit: CUIT_J, razon_social: "EJEMPLO COMERCIAL S.A.", condicion_iva: "Responsable inscripto", alta_step: 3, updated_at: new Date().toISOString(),
  raw_messages: [{ role: "constancia", estado: "aplicada", datos, ts: "t" }, { role: "user", content: "Sí" }] }, send);
igual("después de aplicada, la respuesta siguiente va al paso en curso (nombre de contacto)", [JSON.parse(escrituras("wa_prospect_leads", "PATCH")[0].body).nombre_contacto, ult().includes("Teléfono")], ["Juan Pérez", true]);

// Domicilio fiscal: se propone al llegar a la dirección de entrega.
const enDireccion = (extra: Record<string, unknown> = {}) => ({ id: 7, cuit: CUIT_J, razon_social: "EJEMPLO COMERCIAL S.A.", condicion_iva: "Responsable inscripto", nombre_contacto: "Juan", telefono: "1", mail: "a@b.co",
  direccion: null, alta_step: 6, updated_at: new Date().toISOString(), raw_messages: [{ role: "constancia", estado: "aplicada", datos, ts: "t" }, { role: "user", content: "a@b.co" }], ...extra });
igual("la pregunta de la dirección propone el domicilio fiscal", [promptActual(enDireccion())?.includes("domicilio fiscal"), promptActual(enDireccion())?.includes("Av Ejemplo 1234, Rosario, Santa Fe (CP 2000)")], [true, true]);
igual("sin constancia, la pregunta es la de siempre", promptActual(enDireccion({ raw_messages: [] })), "📍 Dirección de *entrega*: ¿calle y número?");
nuevo();
await handleAltaStep(tel, "Sí", enDireccion(), send);
{
  const b = JSON.parse(escrituras("wa_prospect_leads", "PATCH")[0].body);
  igual("'sí' al domicilio: llena dirección, localidad, provincia y CP, y salta 4 pasos", [b.direccion, b.localidad, b.provincia, b.codigo_postal, b.alta_step, ult().includes("expreso")], ["Av Ejemplo 1234", "Rosario", "Santa Fe", "2000", 10, true]);
}
nuevo();
await handleAltaStep(tel, "no", enDireccion(), send);
igual("'no' al domicilio: pide la dirección de entrega y no guarda nada", [ult().includes("dirección de *entrega*"), escrituras("wa_prospect_leads", "PATCH").length], [true, 0]);
nuevo();
await handleAltaStep(tel, "Mitre 500", enDireccion(), send);
{
  const b = JSON.parse(escrituras("wa_prospect_leads", "PATCH")[0].body);
  igual("otra dirección: la guarda y sigue con la localidad", [b.direccion, b.localidad, b.alta_step, ult().includes("Localidad")], ["Mitre 500", undefined, 7, true]);
}

// El texto de confirmación sin IVA no inventa la línea.
igual("confirmación sin IVA legible: no muestra la línea de IVA", textoConfirmaConstancia({ ...datos, condicionIva: null }).includes("IVA"), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
