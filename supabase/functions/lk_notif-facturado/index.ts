// lk_notif-facturado — Aviso proactivo WhatsApp "mañana sale tu pedido por $XXX (IVA incl.)"
// Edge Function en proyecto PaginaLK (kwkclwhmoygunqmlegrg), verify_jwt=false.
//
// Lo dispara un trigger de Virgilio (Facturacion_NP) cuando la operadora tilda "facturó":
// Virgilio hace net.http_post acá con { np, cod_cliente, razon_social, total, fecha_salida }.
// total = neto × 1,21 (ya con IVA), calculado en Virgilio desde vista_facturacion_neto.
//
// Acá: resuelve el WhatsApp del cliente (bot_customer_whatsapps por cod_cliente), deduplica
// por NP (bot_facturado_avisos) y encola en wa_outbox con un TEMPLATE aprobado por Meta.
// El envío real lo hace el flush (lk_whatsapp-webhook?action=flush) vía bot_flush_outbox.
//
// ⚠ Requiere un template de WhatsApp APROBADO en Meta (ej. "pedido_facturado_sale", es_AR)
//    con 3 parámetros de body: {{1}}=fecha (DD/MM/AAAA), {{2}}=N° pedido, {{3}}=monto.
//    Hasta que exista y esté aprobado, el mensaje se encola pero Meta lo rechaza al enviarlo.
//
// Auth: header x-sync-secret (mismo secret que virgilio-entrega-sync).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SECRET = "8dctbyZWNKfIq88ZKRjb_j_udAgdULGAAMXEFpsA5ww";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TEMPLATE = "pedido_facturado_sale";   // nombre del template en Meta (crear+aprobar)

// ⚠ MODO PRUEBA — mientras este número esté seteado, TODO aviso se redirige SOLO acá y
// NUNCA llega a un WhatsApp de cliente/empresa. Para salir a producción (mandar al cliente
// real): poner "" (cadena vacía). No borres esto sin confirmación explícita.
const TEST_REDIRECT_PHONE = "5491162521635";

function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}
function json(o: unknown, status: number) {
  return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
}
// $ con separador de miles (sin decimales). 911307.2 -> "$911.307"
function fmtMonto(n: number): string {
  const r = Math.round(Number(n) || 0);
  return "$" + r.toLocaleString("es-AR").replace(/ /g, "");
}
// "2026-09-02" -> "02/09/2026" (sin parsear a Date, evita corrimientos de zona)
function fmtFecha(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(ymd || "");
}
function canonPhone(p: string): string { return String(p || "").replace(/\D/g, ""); }

Deno.serve(async (req) => {
  if (req.method === "GET") return new Response("ok", { status: 200 });
  if (req.headers.get("x-sync-secret") !== SECRET) return json({ error: "forbidden" }, 403);

  // deno-lint-ignore no-explicit-any
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const np = String(b.np ?? "").trim().replace(/\.0+$/, "");
  const cc = String(b.cod_cliente ?? "").trim();
  const total = Number(b.total);
  const fechaSalida = String(b.fecha_salida ?? "");
  if (!np || !cc) return json({ skipped: "falta_np_o_cliente" }, 200);
  if (!Number.isFinite(total) || total <= 0) return json({ skipped: "sin_monto" }, 200);

  // 1) Resolver WhatsApp del cliente (primario). Fallback a wa_clientes_telefono.
  let phone = "";
  const waRes = await rest(
    `bot_customer_whatsapps?select=whatsapp,is_primary&cod_cliente=eq.${encodeURIComponent(cc)}&whatsapp=not.is.null&order=is_primary.desc.nullslast&limit=1`,
  );
  const waRows = waRes.ok ? await waRes.json() : [];
  if (Array.isArray(waRows) && waRows.length) phone = canonPhone(waRows[0].whatsapp);
  if (!phone) {
    const altRes = await rest(
      `wa_clientes_telefono?select=telefono&cod_cliente=eq.${encodeURIComponent(cc)}&limit=1`,
    );
    const altRows = altRes.ok ? await altRes.json() : [];
    if (Array.isArray(altRows) && altRows.length) phone = canonPhone(altRows[0].telefono);
  }
  // Destino: en MODO PRUEBA todo se redirige al teléfono de prueba (nunca al cliente);
  // en producción (TEST_REDIRECT_PHONE = "") va al WhatsApp real del cliente.
  const destPhone = TEST_REDIRECT_PHONE || phone;
  if (!destPhone) return json({ skipped: "sin_telefono", cod_cliente: cc }, 200);

  // 2) Blacklist / opt-out
  const blRes = await rest(`wa_blacklist?select=id&phone=eq.${encodeURIComponent(destPhone)}&limit=1`);
  const blRows = blRes.ok ? await blRes.json() : [];
  if (Array.isArray(blRows) && blRows.length) return json({ skipped: "blacklist", phone: destPhone }, 200);

  // 3) Dedup por NP (una sola vez). 409 = ya avisado.
  const dedup = await rest("bot_facturado_avisos", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ np, cod_cliente: cc, total }),
  });
  if (dedup.status === 409) return json({ skipped: "ya_avisado", np }, 200);
  if (!dedup.ok) return json({ error: "dedup_fallo", detail: (await dedup.text()).slice(0, 300) }, 500);

  // 4) Encolar en wa_outbox con el template. Params posicionales {{1}} fecha, {{2}} NP, {{3}} monto.
  const ins = await rest("wa_outbox", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      phone: destPhone,
      template_name: TEMPLATE,
      template_params: { "1": fmtFecha(fechaSalida), "2": np, "3": fmtMonto(total) },
      status: "pending",
    }),
  });
  const insBody = await ins.json();
  if (!ins.ok) return json({ error: "outbox_fallo", detail: insBody }, 500);
  return json({
    enqueued: true, outbox_id: insBody?.[0]?.id ?? true,
    phone: destPhone, cliente_phone: phone || null,
    test_mode: !!TEST_REDIRECT_PHONE, np, monto: fmtMonto(total),
  }, 200);
});
