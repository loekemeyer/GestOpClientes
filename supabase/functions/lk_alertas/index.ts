import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { supabase } from "../_shared/supabase.ts";

// lk_alertas — bandeja de alertas para humanos (wa_alertas_humano) con vencimiento.
// La usa el dashboard (menú 🔔 Alertas). Sólo admins (requireAdmin).
//
//   {action:"list", incluir_resueltas?, incluir_ruido?}  → alertas + vencimiento calculado
//   {action:"resolver", id, estado: "atendido"|"descartado"}
//   {action:"config_get"} / {action:"config_save", vencimientos:{categoria: minutos}}
//
// Vencimiento: minutos por CATEGORÍA (contexto.motivo si lo hay, si no el tipo), guardados en
// app_settings.wa_alertas_vencimiento (JSON). vence_at = created_at + minutos.
// "Ruido" = whitelist_gate (números fuera de la lista de prueba): no se muestra salvo que se pida.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SETTING = "wa_alertas_vencimiento";

// Nombre visible y vencimiento por defecto (minutos) de cada categoría.
const CATEGORIAS: Record<string, { label: string; min: number }> = {
  respuesta_aviso_cambio: { label: "Cambio o cancelación de pedido (respuesta a un aviso)", min: 60 },
  escalation:             { label: "Pidió hablar con una persona", min: 120 },
  comprobante_recibido:   { label: "Comprobante de pago recibido", min: 240 },
  comprobante_error:      { label: "Comprobante de pago con error", min: 120 },
  llm_timeout:            { label: "El bot no llegó a responder", min: 30 },
  llm_error:              { label: "El bot falló al responder", min: 30 },
  alta_cliente:           { label: "Alta de cliente nuevo", min: 1440 },
  blacklist:              { label: "Escribió un número bloqueado", min: 1440 },
  faq_no_match:           { label: "Pregunta sin respuesta", min: 240 },
  otro:                   { label: "Otros", min: 240 },
  whitelist_gate:         { label: "Número fuera de la lista de prueba", min: 1440 },
};

// deno-lint-ignore no-explicit-any
function categoria(a: any): string {
  const motivo = String(a?.contexto?.motivo ?? "");
  if (motivo && CATEGORIAS[motivo]) return motivo;
  if (a?.contexto?.lead_id || motivo === "alta") return "alta_cliente";
  return CATEGORIAS[a?.tipo] ? a.tipo : "otro";
}

async function vencimientos(): Promise<Record<string, number>> {
  const base = Object.fromEntries(Object.entries(CATEGORIAS).map(([k, v]) => [k, v.min]));
  const { data } = await supabase.from("app_settings").select("value").eq("key", SETTING).maybeSingle();
  try {
    const guardado = data?.value ? JSON.parse(data.value) : {};
    for (const [k, v] of Object.entries(guardado)) if (k in base && Number(v) > 0) base[k] = Number(v);
  } catch { /* JSON roto → defaults */ }
  return base;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const gate = await requireAdmin(body);
    if (!gate.ok) return json({ error: gate.error }, gate.status);

    if (body.action === "config_get") {
      const v = await vencimientos();
      return json({
        ok: true,
        categorias: Object.entries(CATEGORIAS).map(([k, c]) => ({ categoria: k, label: c.label, minutos: v[k], defecto: c.min })),
      });
    }

    if (body.action === "config_save") {
      const nuevos = body.vencimientos ?? {};
      const limpio: Record<string, number> = {};
      for (const [k, v] of Object.entries(nuevos)) {
        const n = Math.round(Number(v));
        if (!(k in CATEGORIAS) || !(n >= 1 && n <= 60 * 24 * 30)) {
          return json({ ok: false, error: `Vencimiento inválido para ${k}: entre 1 minuto y 30 días.` }, 400);
        }
        limpio[k] = n;
      }
      const { error } = await supabase.from("app_settings")
        .upsert({ key: SETTING, value: JSON.stringify(limpio) }, { onConflict: "key" });
      if (error) return json({ ok: false, error: error.message }, 200);
      console.log(`lk_alertas: vencimientos actualizados por ${gate.email}`, JSON.stringify(limpio));
      return json({ ok: true });
    }

    if (body.action === "list") {
      const v = await vencimientos();
      let q = supabase.from("wa_alertas_humano")
        .select("id, tipo, phone, customer_id, contexto, estado, created_at, atendido_por, atendido_at")
        .order("created_at", { ascending: false }).limit(300);
      if (!body.incluir_resueltas) q = q.in("estado", ["pendiente", "notificado"]);
      if (!body.incluir_ruido) q = q.neq("tipo", "whitelist_gate");
      const { data, error } = await q;
      if (error) return json({ ok: false, error: error.message }, 200);

      const ids = [...new Set((data ?? []).map((a) => a.customer_id).filter(Boolean))];
      const nombres: Record<string, string> = {};
      if (ids.length) {
        const { data: cs } = await supabase.from("customers").select("id, cod_cliente, business_name").in("id", ids);
        for (const c of cs ?? []) nombres[c.id] = `${c.business_name} (${c.cod_cliente})`;
      }
      const ahora = Date.now();
      const alertas = (data ?? []).map((a) => {
        const cat = categoria(a);
        const venceAt = new Date(new Date(a.created_at).getTime() + v[cat] * 60_000);
        const ctx = a.contexto ?? {};
        return {
          id: a.id, tipo: a.tipo, categoria: cat, label: CATEGORIAS[cat].label,
          phone: a.phone, cliente: a.customer_id ? (nombres[a.customer_id] ?? null) : (ctx.razon_social ?? null),
          texto: ctx.texto_recibido ?? ctx.texto ?? null, pedido: ctx.pedido ?? null,
          estado: a.estado, created_at: a.created_at, atendido_por: a.atendido_por, atendido_at: a.atendido_at,
          vence_at: venceAt.toISOString(),
          vencida: ["pendiente", "notificado"].includes(a.estado) && venceAt.getTime() < ahora,
        };
      }).sort((x, y) => (x.vencida === y.vencida ? x.vence_at.localeCompare(y.vence_at) : x.vencida ? -1 : 1));
      return json({ ok: true, alertas });
    }

    if (body.action === "resolver") {
      const id = Number(body.id);
      const estado = String(body.estado ?? "");
      if (!id || !["atendido", "descartado"].includes(estado)) return json({ ok: false, error: "parámetros inválidos" }, 400);
      const { data, error } = await supabase.from("wa_alertas_humano")
        .update({ estado, atendido_por: gate.email, atendido_at: new Date().toISOString() })
        .eq("id", id).in("estado", ["pendiente", "notificado"]).select("id");
      if (error) return json({ ok: false, error: error.message }, 200);
      if (!data?.length) return json({ ok: false, error: "La alerta ya estaba resuelta." }, 200);
      return json({ ok: true });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_alertas error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
