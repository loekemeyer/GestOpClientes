// Guardrail de cruce de cliente en el corte de salida (Pablo Olejavetzky, 14/10/2026, tarea de Planify 5801, sql/156).
// Un aviso de un cliente no puede salir al teléfono de OTRO cliente real. El productor declara el cliente con los headers
// x-lk-cuit / x-lk-cod-cliente en su fetch a Meta, wa-guard los lee, los saca del pedido y le pregunta a la base wa_puede_enviar_a.
// Sin red: la base y Meta son un fetch falso. Lo que decide wa_puede_enviar_a / wa_destino_cruzado se probó contra la base real (sql/156).
// Correr: deno run --allow-env --allow-read tests/wa-guard-destino.test.ts   (sale con código 1 si algo falla)
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");

// Fetch falso ANTES de importar wa-guard: el guard lo toma como su "fetch real".
type Llamada = { url: string; init?: RequestInit };
const llamadas: Llamada[] = [];
let rpcRespuesta: { status: number; cuerpo: unknown } = { status: 200, cuerpo: true };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  llamadas.push({ url, init });
  if (url.includes("/rest/v1/rpc/")) return new Response(JSON.stringify(rpcRespuesta.cuerpo), { status: rpcRespuesta.status });
  return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
}) as typeof fetch;

await import("../supabase/functions/_shared/wa-guard.ts");
const { separarDestinatario, headersDestinatario } = await import("../supabase/functions/_shared/wa-guard-destino.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const META = "https://graph.facebook.com/v21.0/123456/messages";
const cuerpo = JSON.stringify({ messaging_product: "whatsapp", to: "5491131181594", type: "template" });
const rpcs = () => llamadas.filter((l) => l.url.includes("/rest/v1/rpc/"));
const aMeta = () => llamadas.filter((l) => l.url.includes("graph.facebook.com"));
const reset = () => { llamadas.length = 0; rpcRespuesta = { status: 200, cuerpo: true }; };

// ── separarDestinatario (pura) ──
{
  const r = separarDestinatario({ method: "POST", body: "x", headers: { Authorization: "Bearer t", "X-LK-CUIT": " 30-68575625-7 ", "x-lk-cod-cliente": "411" } });
  igual("objeto de headers: lee el CUIT sin importar mayúsculas y lo recorta", r.destinatario, { cuit: "30-68575625-7", codCliente: "411" });
  igual("objeto de headers: los saca y deja el resto", r.init?.headers, { Authorization: "Bearer t" });
  igual("conserva el método y el cuerpo", [r.init?.method, r.init?.body], ["POST", "x"]);
}
{
  const h = new Headers({ Authorization: "Bearer t", "x-lk-cuit": "30685756257" });
  const r = separarDestinatario({ headers: h });
  igual("Headers: lee el CUIT", r.destinatario, { cuit: "30685756257", codCliente: "" });
  const limpio = r.init?.headers as Headers;
  igual("Headers: los saca y deja Authorization", [limpio.has("x-lk-cuit"), limpio.get("authorization")], [false, "Bearer t"]);
  igual("Headers: no modifica el original", h.has("x-lk-cuit"), true);
}
{
  const r = separarDestinatario({ headers: [["Authorization", "Bearer t"], ["x-lk-cod-cliente", "411"]] });
  igual("arreglo de pares: lee el código", r.destinatario, { cuit: "", codCliente: "411" });
  igual("arreglo de pares: lo saca", r.init?.headers, [["Authorization", "Bearer t"]]);
}
igual("sin headers de cliente: no hay destinatario", separarDestinatario({ headers: { Authorization: "Bearer t" } }).destinatario, null);
igual("headers de cliente vacíos: no hay destinatario", separarDestinatario({ headers: { "x-lk-cuit": "  ", "x-lk-cod-cliente": "" } }).destinatario, null);
igual("sin init: no hay destinatario y no revienta", separarDestinatario(undefined), { init: undefined, destinatario: null });
igual("headersDestinatario: sólo manda lo que tiene", [headersDestinatario({ cuit: "3068", codCliente: "" }), headersDestinatario({ codCliente: 411 }), headersDestinatario(null), headersDestinatario({ cuit: null })],
  [{ "x-lk-cuit": "3068" }, { "x-lk-cod-cliente": "411" }, {}, {}]);

// ── El guard en el fetch ──
reset();
{
  const r = await fetch(META, { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json", "x-lk-cuit": "30685756257" }, body: cuerpo });
  igual("con cliente declarado y permitido: sale (200)", r.status, 200);
  igual("con cliente declarado: pregunta wa_puede_enviar_a con teléfono y CUIT", [rpcs().length, rpcs()[0]?.url.endsWith("/rpc/wa_puede_enviar_a"), JSON.parse(String(rpcs()[0]?.init?.body))],
    [1, true, { p_phone: "5491131181594", p_cuit: "30685756257", p_cod_cliente: null }]);
  const aMetaInit = aMeta()[0]?.init;
  igual("a Meta llega sin los headers de cliente y con el resto", aMetaInit?.headers, { Authorization: "Bearer t", "Content-Type": "application/json" });
  igual("a Meta llega el mismo cuerpo", aMetaInit?.body, cuerpo);
}
reset();
{
  rpcRespuesta = { status: 200, cuerpo: false };
  const r = await fetch(META, { method: "POST", headers: { "x-lk-cuit": "30999999999", "x-lk-cod-cliente": "4210" }, body: cuerpo });
  const d = await r.json();
  igual("cruce de cliente: 403 con forma de error de Meta y no llama a Meta", [r.status, d?.error?.type, aMeta().length], [403, "LkWaGuard", 0]);
  igual("cruce de cliente: el motivo nombra el cruce", /cruce de cliente/.test(String(d?.error?.message)), true);
  igual("manda CUIT y código a la base", JSON.parse(String(rpcs()[0]?.init?.body)), { p_phone: "5491131181594", p_cuit: "30999999999", p_cod_cliente: "4210" });
}
reset();
{
  const r = await fetch(META, { method: "POST", headers: { Authorization: "Bearer t" }, body: cuerpo });
  igual("sin cliente declarado: sale como siempre", r.status, 200);
  igual("sin cliente declarado: usa wa_puede_enviar, sin CUIT", [rpcs()[0]?.url.endsWith("/rpc/wa_puede_enviar"), JSON.parse(String(rpcs()[0]?.init?.body))], [true, { p_phone: "5491131181594" }]);
}
reset();
{
  rpcRespuesta = { status: 200, cuerpo: false };
  const r = await fetch(META, { method: "POST", headers: { Authorization: "Bearer t" }, body: cuerpo });
  const d = await r.json();
  igual("sin cliente declarado y la llave cerrada: 403 sin hablar de cruce", [r.status, /cruce/.test(String(d?.error?.message)), aMeta().length], [403, false, 0]);
}
reset();
{
  rpcRespuesta = { status: 500, cuerpo: { message: "boom" } };
  const r = await fetch(META, { method: "POST", headers: { "x-lk-cuit": "30685756257" }, body: cuerpo });
  igual("si la base falla, no sale (falla cerrada)", [r.status, aMeta().length], [403, 0]);
}
reset();
{
  const r = await fetch("https://example.com/otra-cosa", { method: "POST", headers: { "x-lk-cuit": "30685756257" }, body: "{}" });
  igual("una llamada que no es a Meta pasa entera, sin tocar los headers", [r.status, rpcs().length, (llamadas[0]?.init?.headers as Record<string, string>)["x-lk-cuit"]], [200, 0, "30685756257"]);
}
reset();
{
  const r = await fetch(META, { method: "POST", headers: { "x-lk-cuit": "30685756257" }, body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: "wamid.Y" }) });
  igual("marcar como leído (sin destinatario) no consulta a la base ni se bloquea", [r.status, rpcs().length, aMeta().length], [200, 0, 1]);
}

// ── Que los productores y la base sigan cableados (la lógica de la base se probó contra la base real) ──
const leer = (p: string) => Deno.readTextFileSync(new URL(`../${p}`, import.meta.url));
const factura = leer("supabase/functions/lk_factura-check/index.ts");
igual("lk_factura-check declara el cliente en sus 3 envíos", (factura.match(/enviarWhatsapp\([^;]*\{ cuit(: body\.cuit)? \}\)/g) ?? []).length, 3);
igual("lk_factura-check manda sólo el CUIT (el código es ambiguo entre LK y Chef)", /codCliente:/.test(factura.replace(/cliente\?: \{[^}]*\}/, "")), false);
const sql = leer("sql/156_wa_guardrail_cruce_cliente.sql");
for (const f of ["wa_claves_de_cliente", "wa_claves_del_telefono", "wa_telefono_de_prueba", "wa_destino_cruzado", "wa_puede_enviar_a"]) {
  igual(`sql/156 crea ${f} y el rollback la borra`, [sql.includes(`function public.${f}(`), leer("sql/rollback/156_wa_guardrail_cruce_cliente.sql").includes(`drop function if exists public.${f}(`)], [true, true]);
}
igual("sql/156: bot_flush_outbox retiene el cruce con el mismo estado que la llave y deja el motivo en error",
  /update wa_outbox o\s+set status = 'held_no_whitelist',\s+error\s+= x\.motivo[\s\S]*?wa_destino_cruzado\(\s*o2\.phone, null,\s*case when o2\.context = 'recordatorio_dto' then split_part\(o2\.ref_id, '\|', 1\) end,\s*ord\.customer_id\)/.test(sql), true);
igual("sql/156: avisos de un pedido (order_created, retiro_listo, tracking_*) y el recordatorio de descuento (recordatorio_dto), con cast seguro del ref_id",
  /o2\.context in \('order_created', 'retiro_listo', 'recordatorio_dto'\) or o2\.context like 'tracking\\_%'/.test(sql)
  && /case when o2\.context <> 'recordatorio_dto' and o2\.ref_id ~ '\^\\d\{1,15\}\$' then o2\.ref_id::bigint end/.test(sql), true);
igual("recordatorio_dto: el cliente es el cod de ref_id y ese contexto es el que arma lk_recordatorio-descuento con ref cod|fecha|condicion|dias",
  /ref: `\$\{gr\.cod\}\|\$\{gr\.fecha\}\|\$\{gr\.condicion\}\|\$\{e\.dias\}`/.test(leer("supabase/functions/lk_recordatorio-descuento/index.ts"))
  && /const CONTEXTO = "recordatorio_dto"/.test(leer("supabase/functions/lk_recordatorio-descuento/index.ts")), true);
igual("el rollback devuelve bot_flush_outbox sin el guardrail", leer("sql/rollback/156_wa_guardrail_cruce_cliente.sql").includes("wa_destino_cruzado(o2.phone"), false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
