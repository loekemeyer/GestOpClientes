// Edge Function: notify-order-created
// Disparada por trigger AFTER INSERT ON public.orders via pg_net.
// Manda un WhatsApp de confirmacion al cliente del pedido recien creado,
// usando el template aprobado "confirmacion_pedido_v1" (UTILITY) — eso
// permite entregar el mensaje 24/7, fuera de la ventana de 24h de Meta.
//
// Seguridad: el trigger pasa un header x-notify-secret. Solo aceptamos llamadas
// que tengan el mismo secret que la env var BOT_NOTIFY_SECRET.
// D007 (2026-09-25): el envío pasa por _shared/wa-guard.ts. Fuente versionada desde acá (antes v42
// sólo en el proyecto). El resto del código es el de v42 sin cambios.

import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const NOTIFY_SECRET = Deno.env.get("BOT_NOTIFY_SECRET") ?? "";

const TEMPLATE_NAME = "confirmacion_pedido_v1";
const TEMPLATE_LANG = "es_AR";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

function fmtMoney(n: number | string | null | undefined): string {
  const r = Math.round(Number(n) || 0);
  return "$" + r.toLocaleString("es-AR");
}

async function waSendTemplate(
  to: string,
  businessName: string,
  total: string,
  codigos: string,
  paymentMethod: string,
  orderId: number,
): Promise<boolean> {
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: businessName },
            { type: "text", text: total },
            { type: "text", text: codigos },
            { type: "text", text: paymentMethod },
          ],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: `descargar_pedido_${orderId}` }],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: `rechazar_pedido_${orderId}` }],
        },
      ],
    },
  };

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    console.error("WA template send failed", res.status, await res.text());
    return false;
  }
  return true;
}

async function rpcGuardarMensaje(telefono: string, contenido: string) {
  const { error } = await supabase.rpc("bot_guardar_mensaje", {
    p_telefono: telefono,
    p_rol: "assistant",
    p_contenido: contenido,
  });
  if (error) console.error("rpc bot_guardar_mensaje error", error);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const incomingSecret = req.headers.get("x-notify-secret") ?? "";
  if (!NOTIFY_SECRET || incomingSecret !== NOTIFY_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let payload: { order_id?: number };
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const orderId = Number(payload?.order_id);
  if (!orderId || orderId <= 0) {
    return new Response(JSON.stringify({ ok: false, error: "order_id invalido" }), { status: 400 });
  }

  // Datos del pedido + cliente.
  const { data: orderRows, error: orderErr } = await supabase
    .from("orders")
    .select("id, total, payment_method, customer_id, created_at")
    .eq("id", orderId)
    .limit(1);

  if (orderErr || !orderRows || orderRows.length === 0) {
    console.error("order not found", orderId, orderErr);
    return new Response(JSON.stringify({ ok: false, error: "order no encontrada" }), { status: 404 });
  }

  const order = orderRows[0];

  const { data: custRows, error: custErr } = await supabase
    .from("customers")
    .select("business_name, whatsapp")
    .eq("id", order.customer_id)
    .limit(1);

  if (custErr || !custRows || custRows.length === 0) {
    console.error("customer not found", order.customer_id);
    return new Response(JSON.stringify({ ok: false, error: "customer no encontrado" }), { status: 404 });
  }

  const customer = custRows[0];
  const phone = (customer.whatsapp ?? "").trim();
  const businessName = (customer.business_name ?? "").trim() || "cliente";

  if (!phone) {
    console.log("customer sin whatsapp, no se notifica", order.customer_id);
    return new Response(JSON.stringify({ ok: true, skipped: "sin whatsapp" }));
  }

  // Conteo de codigos distintos en el pedido (= filas en order_items).
  const { count: itemsCount } = await supabase
    .from("order_items")
    .select("*", { count: "exact", head: true })
    .eq("order_id", orderId);

  const total = fmtMoney(order.total);
  const pago = (order.payment_method ?? "").trim() || "No especificado";
  const codigos = String(itemsCount ?? 0);

  const ok = await waSendTemplate(phone, businessName, total, codigos, pago, orderId);

  if (ok) {
    // Guardar version texto plano en el historial — referencia para el bot.
    // Mantenemos el marker [pedido:N] para que el handler tradicional de
    // "Si"/"No" en texto siga funcionando si el cliente escribe en lugar de
    // tocar el boton.
    const historialTxt = [
      "Pedido confirmado",
      "",
      `Hola ${businessName},`,
      `Recibimos su pedido por *${total}* + IVA.`,
      `${codigos} códigos`,
      `Método de pago seleccionado: ${pago}`,
      "",
      `¿Desea descargar el resumen? Responda *Sí* o *No*.`,
      `Tiene 24 hs para descargarlo.`,
      "",
      `[pedido:${orderId}]`,
    ].join("\n");
    await rpcGuardarMensaje(phone, historialTxt);
  }

  return new Response(JSON.stringify({ ok, order_id: orderId, phone }), {
    headers: { "Content-Type": "application/json" },
  });
});
