import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// lk_conversaciones — Bandeja de atención humana (PaginaLK), integrada al bot real.
//
// Usa las piezas del bot: bot_historial_chat (historial) y bot_conversaciones (modo bot/humano,
// que el webhook lk_whatsapp-webhook YA respeta). El estado del ticket (abierto/pendiente/
// resuelto) y "leído" viven en wa_human_control (sólo UI). Acciones:
//   list / thread / send / toggle_human / set_estado / mark_read / seed_demo.
// Envío: respeta ventana 24h de Meta y, si wa_human_send_whitelist_only='1', SÓLO a la lista
// blanca. Responder = pasar el chat a modo humano (bot_conv_set_modo) → el bot deja de contestar.
// verify_jwt=false.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
async function getSetting(key: string): Promise<string | null> {
  const { data } = await sb.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function canon(raw: string): string { return String(raw || "").replace(/\D/g, ""); }
const DAY = 24 * 3600 * 1000;

const META_API = "https://graph.facebook.com/v21.0";
// Usa las credenciales del bot (mismas que el webhook) con fallback a las genéricas.
async function metaToken(): Promise<string> {
  return Deno.env.get("LK_WA_TOKEN") ?? Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? Deno.env.get("WA_TOKEN") ?? (await getSetting("wa_token")) ?? "";
}
async function waPhoneId(): Promise<string> {
  return Deno.env.get("LK_WA_PHONE_ID") ?? Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? (await getSetting("wa_phone_number_id")) ?? "";
}
async function whitelist(): Promise<string[]> {
  const { data } = await sb.from("wa_envio_contactos").select("phone");
  return (data ?? []).map((r: { phone: string }) => r.phone);
}
const dir = (rol: string) => (rol === "user" ? "in" : "out");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    if (action === "list") {
      const { data, error } = await sb.rpc("wa_conversaciones_list");
      if (error) return json({ error: error.message }, 500);
      const now = Date.now();
      const items = (data ?? []).map((r: Record<string, unknown>) => {
        const inb = r.inbound_last_at ? new Date(r.inbound_last_at as string).getTime() : 0;
        return {
          phone: r.phone,
          // Identificación del cliente cuando existe match; NULL si el número
          // no está vinculado a ningún customer (mostrar solo el teléfono).
          business_name: r.business_name ?? null,
          cod_cliente: r.cod_cliente ?? null,
          last_body: r.last_body, last_dir: dir(r.last_rol as string),
          last_at: r.last_at, total: r.total, unread: r.unread,
          modo_humano: r.modo === "humano", agente: r.agente, modo_expira_en: r.modo_expira_en,
          estado: r.estado, ventana_abierta: inb > 0 && (now - inb) < DAY,
        };
      });
      return json({ items });
    }

    if (action === "thread") {
      const phone = canon(body.phone);
      if (!phone) return json({ error: "phone requerido" }, 400);
      const { data } = await sb.from("bot_historial_chat").select("id,rol,contenido,creado_en")
        .eq("telefono", phone).order("creado_en", { ascending: true }).limit(300);
      const messages = (data ?? []).map((m: Record<string, unknown>) => ({
        id: m.id, direction: dir(m.rol as string), body: m.contenido, created_at: m.creado_en,
      }));
      const { data: bc } = await sb.from("bot_conversaciones").select("modo,agente_nombre,modo_expira_en").eq("telefono", phone).maybeSingle();
      const { data: hc } = await sb.from("wa_human_control").select("estado").eq("phone", phone).maybeSingle();
      return json({ messages, control: { modo_humano: bc?.modo === "humano", agente: bc?.agente_nombre ?? null, modo_expira_en: bc?.modo_expira_en ?? null, estado: hc?.estado ?? "abierto" } });
    }

    if (action === "toggle_human") {
      const phone = canon(body.phone);
      if (!phone) return json({ error: "phone requerido" }, 400);
      const on = !!body.on;
      const { error } = await sb.rpc("bot_conv_set_modo", {
        p_telefono: phone, p_modo: on ? "humano" : "bot",
        p_agente_nombre: on ? (body.agente || "Panel web") : null, p_motivo: on ? "traspaso manual" : null, p_horas: 8,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, phone, modo_humano: on });
    }

    if (action === "set_estado") {
      const phone = canon(body.phone);
      const estado = String(body.estado || "abierto");
      if (!phone || !["abierto", "pendiente", "resuelto"].includes(estado)) return json({ error: "parametros invalidos" }, 400);
      const { error } = await sb.from("wa_human_control").upsert({ phone, estado, updated_at: new Date().toISOString() }, { onConflict: "phone" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, phone, estado });
    }

    if (action === "mark_read") {
      const phone = canon(body.phone);
      if (!phone) return json({ error: "phone requerido" }, 400);
      await sb.from("wa_human_control").upsert({ phone, last_read_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "phone" });
      return json({ ok: true });
    }

    if (action === "seed_demo") {
      const phone = canon(body.phone) || "5491162521635";
      const texto = String(body.body || "Hola! Consulta sobre mi pedido, me pueden ayudar?");
      const { error } = await sb.rpc("bot_guardar_mensaje", { p_telefono: phone, p_rol: "user", p_contenido: texto });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, phone });
    }

    if (action === "send") {
      const phone = canon(body.phone);
      const texto = String(body.body || "").trim();
      if (!phone || !texto) return json({ error: "phone y body requeridos" }, 400);

      // Ventana 24h (Meta): sólo texto libre si el cliente escribió hace <24h.
      const { data: lastIn } = await sb.from("bot_historial_chat").select("creado_en")
        .eq("telefono", phone).eq("rol", "user").order("creado_en", { ascending: false }).limit(1).maybeSingle();
      const inb = lastIn?.creado_en ? new Date(lastIn.creado_en).getTime() : 0;
      if (!inb || (Date.now() - inb) >= DAY) {
        return json({ error: "ventana_cerrada", note: "Pasaron 24h desde el último mensaje del cliente: sólo plantilla aprobada." }, 409);
      }
      // Seguridad: por defecto sólo a la lista blanca.
      if (((await getSetting("wa_human_send_whitelist_only")) ?? "1") === "1") {
        const wl = await whitelist();
        if (!wl.includes(phone)) return json({ error: "no_whitelist", note: "El número no está en la lista blanca (wa_human_send_whitelist_only=1)." }, 403);
      }
      const token = await metaToken(), phoneId = await waPhoneId();
      if (!token || !phoneId) return json({ error: "faltan credenciales WhatsApp" }, 500);
      let wamid = null, sendErr = null;
      try {
        const res = await fetch(`${META_API}/${phoneId}/messages`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: texto.slice(0, 4000) } }),
        });
        const d = await res.json();
        if (!res.ok) sendErr = d?.error?.message || `HTTP ${res.status}`;
        else wamid = d?.messages?.[0]?.id ?? null;
      } catch (e) { sendErr = String(e); }
      if (sendErr) return json({ error: "envio: " + sendErr }, 502);

      // Guardar en el historial del bot (rol assistant) + pasar a modo humano (pausa el bot) + leído.
      await sb.rpc("bot_guardar_mensaje", { p_telefono: phone, p_rol: "assistant", p_contenido: texto });
      await sb.rpc("bot_conv_set_modo", { p_telefono: phone, p_modo: "humano", p_agente_nombre: body.agente || "Panel web", p_motivo: "respuesta manual", p_horas: 8 });
      await sb.from("wa_human_control").upsert({ phone, last_read_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "phone" });
      return json({ ok: true, phone, wamid });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_conversaciones error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
