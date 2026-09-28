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
// Pedidos se muestran por fecha ("pedido del 28/09"), no por número. Errores de Meta explicados en castellano.

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

const dia = (iso: string) =>
  new Date(iso).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit" });

const NOMBRE_AVISO: Record<string, string> = {
  pedido_recibido: "Aviso: pedido recibido",
  pedido_programado: "Aviso: pedido programado",
  pedido_programado_expreso: "Aviso: pedido programado (expreso)",
  pedido_programado_retira: "Aviso: pedido programado (retira)",
  pedido_reprogramado: "Aviso: pedido reprogramado",
  pedido_preparando: "Aviso: pedido en preparación",
  pedido_en_viaje: "Aviso: pedido en viaje",
  pedido_en_viaje_expreso: "Aviso: pedido en viaje (expreso)",
  pedido_listo_retirar: "Aviso: pedido listo para retirar",
  hello_world: "Mensaje de prueba de Meta",
};

// Códigos de error de Meta más comunes, en criollo. El resto muestra el texto de Meta.
const ERRORES_META: Record<number, string> = {
  131047: "Pasaron más de 24 h desde que el cliente escribió; en ese caso sólo se puede mandar una plantilla aprobada.",
  131026: "No se pudo entregar: el número no tiene WhatsApp, bloqueó al negocio o no aceptó las condiciones nuevas de WhatsApp.",
  131049: "Meta lo frenó para no saturar al cliente con mensajes de marketing.",
  131050: "El cliente pidió no recibir mensajes de marketing.",
  131048: "Meta frenó el envío por límite de spam del número.",
  131056: "Demasiados mensajes seguidos al mismo cliente; hay que espaciar.",
  132000: "La plantilla se mandó con una cantidad de datos distinta a la que espera.",
  132001: "La plantilla no existe o no está aprobada en ese idioma.",
  130472: "Meta no lo entregó porque el cliente está en un experimento de Meta (no se cobra).",
  190: "El token de Meta venció o fue revocado: no sale ningún mensaje hasta reemplazarlo.",
};
// deno-lint-ignore no-explicit-any
function explicarError(e: any): string {
  if (!e) return "";
  const txt = ERRORES_META[Number(e.code)] ?? String(e?.error_data?.details ?? e?.message ?? e?.title ?? "");
  return `${txt} (código ${e.code})`;
}

function tabla(titulo: string, cols: string[], filas: string[][], nota = ""): string {
  if (!filas.length) return "";
  const th = cols.map((c) => `<th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc">${esc(c)}</th>`).join("");
  const tr = filas.map((f) =>
    `<tr>${f.map((v) => `<td style="padding:4px 8px;border-bottom:1px solid #eee;vertical-align:top">${esc(v)}</td>`).join("")}</tr>`
  ).join("");
  return `<h3 style="font-size:16px;margin:16px 0 6px">${esc(titulo)} (${filas.length})</h3>` +
    (nota ? `<p style="color:#555;margin:0 0 6px">${esc(nota)}</p>` : "") +
    `<table style="border-collapse:collapse;font-size:14px">${`<tr>${th}</tr>`}${tr}</table>`;
}

serve(async (req) => {
  try {
    if (!(await esLlamadaInterna(req))) return json({ error: "no autorizado" }, 401);

    // Antes de mirar alertas: las que ya se cerraron en Planify pasan a atendidas (lk_alerta-planify sync).
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/lk_alerta-planify`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-lk-secret": await secreto(SECRET_NAME) },
      body: JSON.stringify({ action: "sync" }),
    }).catch((e) => console.error("lk_fallas-mail: sync Planify falló", e));

    const ahora = new Date();
    const { data: est } = await supabase.from("app_settings").select("value").eq("key", ESTADO_KEY).maybeSingle();
    let desde = new Date(ahora.getTime() - PRIMERA_VEZ_DIAS * 86400_000);
    let outboxYa: number[] = [];
    try {
      const e = est?.value ? JSON.parse(est.value) : null;
      if (e?.hasta) desde = new Date(e.hasta);
      if (Array.isArray(e?.outbox_ids)) outboxYa = e.outbox_ids.map(Number);
    } catch { /* estado roto → primera vez */ }
    // Modo prueba ({"prueba": true, "dias": N}): manda el mail de los últimos N días sin mover el cursor.
    const body = await req.json().catch(() => ({}));
    const prueba = body?.prueba === true;
    if (prueba) {
      desde = new Date(ahora.getTime() - Math.min(Math.max(Number(body.dias) || 7, 1), 30) * 86400_000);
      outboxYa = [];
    }

    // 1) Rechazos de Meta.
    const { data: rech } = await supabase.from("wa_message_status")
      .select("id, recipient_id, errors, received_at")
      .eq("status", "failed").gt("received_at", desde.toISOString()).lte("received_at", ahora.toISOString())
      .order("received_at").limit(200);
    // ¿Salió de la cola del bot? (mismo teléfono encolado en los 15 min previos). Si no, lo mandó otra cosa
    // que usa el mismo número (Business Suite, otro sistema) o fue una respuesta directa del bot.
    const { data: cola } = await supabase.from("wa_outbox")
      .select("phone, template_name, context, ref_id, created_at")
      .gt("created_at", new Date(desde.getTime() - 15 * 60_000).toISOString()).lte("created_at", ahora.toISOString())
      .limit(1000);
    const ult10 = (t: unknown) => String(t ?? "").replace(/\D/g, "").slice(-10);
    const deCola = (tel: string, cuando: string) => (cola ?? []).filter((o) => {
      const dt = new Date(cuando).getTime() - new Date(o.created_at).getTime();
      return ult10(o.phone) === ult10(tel) && dt >= 0 && dt <= 15 * 60_000;
    }).sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
    // 2) Cola: filas muertas (sin más reintentos) de los últimos 2 días que todavía no se mandaron.
    const { data: muertas } = await supabase.from("wa_outbox")
      .select("id, phone, template_name, context, ref_id, error, attempts, max_attempts, created_at")
      .eq("status", "failed").gt("created_at", new Date(ahora.getTime() - 2 * 86400_000).toISOString())
      .order("created_at").limit(200);
    const nuevasCola = (muertas ?? []).filter((m) => m.attempts >= m.max_attempts && !outboxYa.includes(Number(m.id)));

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
    // Pedidos: se muestran por FECHA ("pedido del 28/09"), no por número (pedido de Pablo, 28/09).
    const aviso = (rech ?? []).map((r) => deCola(String(r.recipient_id ?? ""), r.received_at));
    const pedIds = [...new Set([
      ...nuevasCola.map((m) => m.ref_id), ...aviso.map((o) => o?.ref_id),
      ...vencidas.map((x) => x.a.contexto?.pedido),
    ].map(Number).filter((n) => n > 0))];
    const fechaPed: Record<number, string> = {};
    if (pedIds.length) {
      const { data: os } = await supabase.from("orders").select("id, created_at").in("id", pedIds);
      for (const o of os ?? []) fechaPed[o.id] = dia(o.created_at);
    }
    const pedido = (id: unknown) => {
      const n = Number(id);
      return n > 0 ? (fechaPed[n] ? `pedido del ${fechaPed[n]}` : "pedido (sin fecha)") : "";
    };
    const queEra = (o: { template_name?: string | null; context?: string | null; ref_id?: string | null } | undefined) =>
      [NOMBRE_AVISO[o?.template_name ?? ""] ?? o?.template_name ?? (o?.context ? `aviso ${o.context}` : "mensaje de texto"),
        pedido(o?.ref_id)].filter(Boolean).join(" · ");

    const filasMeta = (rech ?? []).map((r, i) => {
      const e = Array.isArray(r.errors) ? r.errors[0] : null;
      const o = aviso[i];
      return [hora(r.received_at), String(r.recipient_id ?? ""),
        o ? `Bot: ${queEra(o)}` : "No salió de la cola del bot",
        explicarError(e)];
    });
    const filasCola = nuevasCola.map((m) => [hora(m.created_at), String(m.phone ?? ""), queEra(m),
      String(m.error ?? "").slice(0, 200)]);
    const filasAlertas = vencidas.map(({ a, cat, vence }) => {
      const ctx = a.contexto ?? {};
      return [hora(vence.toISOString()), CATEGORIAS[cat].label,
        (a.customer_id ? nombres[a.customer_id] : ctx.razon_social) ?? String(a.phone ?? ""),
        String(ctx.texto_recibido ?? ctx.texto ?? "").slice(0, 200), pedido(ctx.pedido)];
    });

    const total = filasMeta.length + filasCola.length + filasAlertas.length;
    const guardarEstado = async () => {
      const recientes = new Set((muertas ?? []).map((m) => Number(m.id)));
      const outbox_ids = [...new Set([...outboxYa, ...nuevasCola.map((m) => Number(m.id))])].filter((id) => recientes.has(id));
      await supabase.from("app_settings")
        .upsert({ key: ESTADO_KEY, value: JSON.stringify({ hasta: ahora.toISOString(), outbox_ids }) }, { onConflict: "key" });
    };

    if (!total) {
      if (!prueba) await guardarEstado();
      return json({ ok: true, enviado: false, desde: desde.toISOString() });
    }

    const partes = [
      filasMeta.length ? `${filasMeta.length} WhatsApp no entregado${filasMeta.length > 1 ? "s" : ""}` : "",
      filasCola.length ? `${filasCola.length} sin enviar` : "",
      filasAlertas.length ? `${filasAlertas.length} alerta${filasAlertas.length > 1 ? "s" : ""} vencida${filasAlertas.length > 1 ? "s" : ""}` : "",
    ].filter(Boolean);
    const subject = `${prueba ? "[PRUEBA] " : ""}Bot LK: ${partes.join(" · ")}`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px">` +
      `<p>Resumen de lo que falló en el WhatsApp del bot entre el ${esc(hora(desde.toISOString()))} y el ` +
      `${esc(hora(ahora.toISOString()))} (hora Argentina). Llega un mail sólo cuando hay algo nuevo.</p>` +
      tabla("1. Mensajes que WhatsApp no entregó",
        ["Hora", "Teléfono", "Qué era", "Por qué no llegó"], filasMeta,
        "Meta aceptó el envío y después lo rechazó. \"No salió de la cola del bot\" = lo mandó otra cosa que usa " +
        "el mismo número (Business Suite, otro sistema) o fue una respuesta directa del bot en una charla.") +
      tabla("2. Avisos que el bot no pudo mandar", ["Encolado", "Teléfono", "Qué era", "Error"], filasCola,
        "El bot lo intentó varias veces y se rindió: ese cliente no recibió el aviso.") +
      tabla("3. Alertas vencidas sin atender", ["Venció", "Motivo", "Cliente", "Qué escribió", "Pedido"], filasAlertas,
        "Un cliente necesita a una persona y nadie la marcó como atendida a tiempo.") +
      `<p style="color:#666;margin-top:16px">Para atender o descartar alertas: ` +
      `<a href="https://loekemeyer.github.io/GestOpClientes/">dashboard del bot</a> → 🔔 Alertas.</p></div>`;

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
    if (!prueba) await guardarEstado();
    console.log(`lk_fallas-mail: enviado (${subject})`);
    return json({ ok: true, enviado: true, subject, meta: filasMeta.length, cola: filasCola.length, alertas: filasAlertas.length });
  } catch (err) {
    console.error("lk_fallas-mail error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
