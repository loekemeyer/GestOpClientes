import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { supabase } from "../_shared/supabase.ts";
import { CATEGORIAS, categoria, vencimientos } from "../_shared/alertas-vencimiento.ts";

// lk_fallas-mail — mail de fallas del bot a loekemeyer.n8n@gmail.com. Pedido de Pablo Olejavetzky (28/09).
//
// Lo llama el cron lk_fallas_mail cada 10 min con x-lk-secret (LK_FN_CRON_SECRET). Junta lo NUEVO desde
// el último mail y, si hay algo, manda UN mail resumen (Resend). Si no hay nada, no manda.
//   1. Envíos que Meta rechazó        → wa_message_status.status = 'failed' (llegan por el webhook).
//   2. Envíos que la cola dio por muertos → wa_outbox.status = 'failed' (agotó los reintentos).
//   3. Alertas para humanos vencidas sin atender (mismo vencimiento que 🔔 Alertas; sin whitelist_gate).
// Es un mail interno: NO pasa por la llave de WhatsApp ni le escribe a ningún cliente.
//
// Estado en app_settings.wa_fallas_mail_ultimo = {"hasta": iso, "outbox_ids": [...]}. Sin fila → mira
// los últimos 7 días. El cursor avanza sólo si el mail salió (o si no había nada que mandar).

const DESTINO = "loekemeyer.n8n@gmail.com";
const ESTADO_KEY = "wa_fallas_mail_ultimo";
const SECRET_NAME = "LK_FN_CRON_SECRET";
const PRIMERA_VEZ_DIAS = 7;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function secreto(nombre: string): Promise<string> {
  const env = Deno.env.get(nombre);
  if (env) return env;
  const { data } = await supabase.rpc("krikos_secret", { p_name: nombre });
  return typeof data === "string" ? data : "";
}

async function esLlamadaInterna(req: Request): Promise<boolean> {
  const recibido = req.headers.get("x-lk-secret") ?? "";
  if (!recibido) return false;
  const esperado = await secreto(SECRET_NAME);
  return esperado.length > 0 && recibido === esperado;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const hora = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });

function tabla(titulo: string, cols: string[], filas: string[][]): string {
  if (!filas.length) return "";
  const th = cols.map((c) => `<th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc">${esc(c)}</th>`).join("");
  const tr = filas.map((f) =>
    `<tr>${f.map((v) => `<td style="padding:4px 8px;border-bottom:1px solid #eee;vertical-align:top">${esc(v)}</td>`).join("")}</tr>`
  ).join("");
  return `<h3 style="font-size:16px;margin:16px 0 6px">${esc(titulo)} (${filas.length})</h3>` +
    `<table style="border-collapse:collapse;font-size:14px">${`<tr>${th}</tr>`}${tr}</table>`;
}

serve(async (req) => {
  try {
    if (!(await esLlamadaInterna(req))) return json({ error: "no autorizado" }, 401);

    const ahora = new Date();
    const { data: est } = await supabase.from("app_settings").select("value").eq("key", ESTADO_KEY).maybeSingle();
    let desde = new Date(ahora.getTime() - PRIMERA_VEZ_DIAS * 86400_000);
    let outboxYa: number[] = [];
    try {
      const e = est?.value ? JSON.parse(est.value) : null;
      if (e?.hasta) desde = new Date(e.hasta);
      if (Array.isArray(e?.outbox_ids)) outboxYa = e.outbox_ids.map(Number);
    } catch { /* estado roto → primera vez */ }

    // 1) Rechazos de Meta.
    const { data: rech } = await supabase.from("wa_message_status")
      .select("id, recipient_id, errors, received_at")
      .eq("status", "failed").gt("received_at", desde.toISOString()).lte("received_at", ahora.toISOString())
      .order("received_at").limit(200);
    const filasMeta = (rech ?? []).map((r) => {
      const e = Array.isArray(r.errors) ? r.errors[0] : null;
      return [hora(r.received_at), String(r.recipient_id ?? ""), e ? `${e.code} · ${e.title ?? ""}` : "",
        String(e?.error_data?.details ?? e?.message ?? "")];
    });

    // 2) Cola: filas muertas (sin más reintentos) de los últimos 2 días que todavía no se mandaron.
    const { data: muertas } = await supabase.from("wa_outbox")
      .select("id, phone, template_name, context, ref_id, error, attempts, max_attempts, created_at")
      .eq("status", "failed").gt("created_at", new Date(ahora.getTime() - 2 * 86400_000).toISOString())
      .order("created_at").limit(200);
    const nuevasCola = (muertas ?? []).filter((m) => m.attempts >= m.max_attempts && !outboxYa.includes(Number(m.id)));
    const filasCola = nuevasCola.map((m) => [hora(m.created_at), String(m.phone ?? ""),
      `${m.template_name ?? "texto"}${m.context ? ` · ${m.context}` : ""}${m.ref_id ? ` · pedido ${m.ref_id}` : ""}`,
      String(m.error ?? "").slice(0, 200)]);

    // 3) Alertas que vencieron en (desde, ahora] y siguen sin atender.
    const v = await vencimientos();
    const { data: al } = await supabase.from("wa_alertas_humano")
      .select("id, tipo, phone, customer_id, contexto, estado, created_at")
      .in("estado", ["pendiente", "notificado"]).neq("tipo", "whitelist_gate")
      .gt("created_at", new Date(desde.getTime() - 31 * 86400_000).toISOString())
      .order("created_at").limit(500);
    const vencidas = (al ?? []).map((a) => {
      const cat = categoria(a);
      return { a, cat, vence: new Date(new Date(a.created_at).getTime() + v[cat] * 60_000) };
    }).filter((x) => x.vence > desde && x.vence <= ahora);
    const ids = [...new Set(vencidas.map((x) => x.a.customer_id).filter(Boolean))];
    const nombres: Record<string, string> = {};
    if (ids.length) {
      const { data: cs } = await supabase.from("customers").select("id, cod_cliente, business_name").in("id", ids);
      for (const c of cs ?? []) nombres[c.id] = `${c.business_name} (${c.cod_cliente})`;
    }
    const filasAlertas = vencidas.map(({ a, cat, vence }) => {
      const ctx = a.contexto ?? {};
      return [hora(vence.toISOString()), CATEGORIAS[cat].label,
        (a.customer_id ? nombres[a.customer_id] : ctx.razon_social) ?? String(a.phone ?? ""),
        String(ctx.texto_recibido ?? ctx.texto ?? "").slice(0, 200), ctx.pedido ? String(ctx.pedido) : ""];
    });

    const total = filasMeta.length + filasCola.length + filasAlertas.length;
    const guardarEstado = async () => {
      const recientes = new Set((muertas ?? []).map((m) => Number(m.id)));
      const outbox_ids = [...new Set([...outboxYa, ...nuevasCola.map((m) => Number(m.id))])].filter((id) => recientes.has(id));
      await supabase.from("app_settings")
        .upsert({ key: ESTADO_KEY, value: JSON.stringify({ hasta: ahora.toISOString(), outbox_ids }) }, { onConflict: "key" });
    };

    if (!total) {
      await guardarEstado();
      return json({ ok: true, enviado: false, desde: desde.toISOString() });
    }

    const partes = [
      filasMeta.length ? `${filasMeta.length} rechazo${filasMeta.length > 1 ? "s" : ""} de Meta` : "",
      filasCola.length ? `${filasCola.length} sin enviar` : "",
      filasAlertas.length ? `${filasAlertas.length} alerta${filasAlertas.length > 1 ? "s" : ""} vencida${filasAlertas.length > 1 ? "s" : ""}` : "",
    ].filter(Boolean);
    const subject = `Bot LK: ${partes.join(" · ")}`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px">` +
      `<p>Fallas del bot de WhatsApp entre ${esc(hora(desde.toISOString()))} y ${esc(hora(ahora.toISOString()))} (hora Argentina).</p>` +
      tabla("WhatsApp rechazados por Meta", ["Hora", "Teléfono", "Error", "Detalle"], filasMeta) +
      tabla("Mensajes que la cola no pudo enviar", ["Encolado", "Teléfono", "Mensaje", "Error"], filasCola) +
      tabla("Alertas vencidas sin atender", ["Venció", "Motivo", "Cliente", "Texto", "Pedido"], filasAlertas) +
      `<p style="color:#666;margin-top:16px">Alertas: <a href="https://loekemeyer.github.io/GestOpClientes/">dashboard del bot</a> → 🔔 Alertas.</p></div>`;

    const resendKey = await secreto("RESEND_API_KEY");
    const from = (await secreto("RESEND_FROM")) || "onboarding@resend.dev";
    if (!resendKey) return json({ ok: false, error: "falta RESEND_API_KEY" }, 500);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [DESTINO], subject, html }),
    });
    const rb = await r.text();
    if (!r.ok) {
      console.error("lk_fallas-mail: Resend", r.status, rb.slice(0, 300));
      return json({ ok: false, error: `Resend ${r.status}`, detalle: rb.slice(0, 300) }, 502);
    }
    await guardarEstado();
    console.log(`lk_fallas-mail: enviado (${subject})`);
    return json({ ok: true, enviado: true, subject, meta: filasMeta.length, cola: filasCola.length, alertas: filasAlertas.length });
  } catch (err) {
    console.error("lk_fallas-mail error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
