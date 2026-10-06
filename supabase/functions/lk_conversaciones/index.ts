import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { salientes } from "../_shared/salientes.ts";
import { proyeccion } from "../_shared/proyeccion.ts";
import { getGestionClient } from "../_shared/supabase.ts";
import { sinAnulados } from "../_shared/pedidos-anulados.ts";
import { cadenasListaPropia } from "../_shared/cadenas.ts";
import { ERRORES_META } from "../_shared/errores-meta.ts";
import { leerVersiones, nombreActivo } from "../_shared/plantillas-version.ts";
import { renderPlantilla } from "../_shared/plantillas-meta.ts";

// lk_conversaciones — Bandeja de atención humana (PaginaLK), integrada al bot real.
//
// Usa las piezas del bot: bot_historial_chat (historial) y bot_conversaciones (modo bot/humano,
// que el webhook lk_whatsapp-webhook YA respeta). El estado del ticket (abierto/pendiente/
// resuelto) y "leído" viven en wa_human_control (sólo UI). Acciones:
//   list / thread / send / reabrir / toggle_human / set_estado / mark_read / seed_demo.  (reabrir = plantilla `retomar_consulta` fuera de las 24 h)
// Centro de mensajes (rediseño, dashboard v0.19): tomar / devolver / resolver / ficha / llave_get / llave_set.
//   Estado de cada conversación (bandeja): esperando (hay una alerta abierta y nadie la tomó) · humano
//   (modo humano) · resuelta (wa_human_control.estado='resuelto' y sin alerta abierta) · bot (el resto).
// Envío: respeta la ventana 24h de Meta y la llave de envío (wa_puede_enviar, la misma que el bot):
// con la llave en 'prueba' sólo sale a la lista de prueba; en '1', a cualquiera.
// Responder = pasar el chat a modo humano (bot_conv_set_modo) → el bot deja de contestar.
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
// Usa las credenciales del bot, en el MISMO orden que el webhook (loadConfig): primero el secret
// `WHATSAPP_ACCESS_TOKEN`, la única fuente del token desde el 10/09. Hasta el 02/10 esta función
// leía primero `LK_WA_TOKEN`, el token viejo: el webhook contestaba y el envío manual del panel
// volvía con error de autorización de Meta (Luis, 02/10). Es la única función que lo tenía al revés.
async function metaToken(): Promise<string> {
  return Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? Deno.env.get("LK_WA_TOKEN") ?? Deno.env.get("WA_TOKEN") ?? (await getSetting("wa_token")) ?? "";
}
async function waPhoneId(): Promise<string> {
  return Deno.env.get("LK_WA_PHONE_ID") ?? Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? (await getSetting("wa_phone_number_id")) ?? "";
}
const dir = (rol: string) => (rol === "user" ? "in" : "out");
const ult10 = (t: unknown) => String(t ?? "").replace(/\D/g, "").slice(-10);

// Nombre para mostrar de quien usa el panel (gestop_users.username o el email).
async function nombreUsuario(email: string): Promise<string> {
  const { data } = await sb.from("gestop_users").select("username").eq("email", email).maybeSingle();
  return (data?.username && String(data.username).trim()) || email;
}

// Motivo legible de una alerta (mismo criterio que lk_alertas / alertas-vencimiento).
const MOTIVO: Record<string, string> = {
  cliente_molesto: "Cliente molesto", respuesta_aviso_cambio: "Cambio de pedido", escalation: "Pidió una persona",
  consulta_stock: "Consulta sin stock", comprobante_recibido: "Comprobante recibido", comprobante_error: "Comprobante con error",
  reclamo: "Reclamo", pago: "Pago o importe", cambio_pedido: "Cambio de pedido", pedido_no_encontrado: "Pedido que no aparece", entrega: "Consulta de entrega",
  alta_cliente: "Alta de cliente", llm_timeout: "El bot no respondió", llm_error: "El bot falló", faq_no_match: "Pregunta sin respuesta",
  cliente_chef: "Cliente de Chef", devolucion: "Devolución de mercadería",
  pedido_mail: "Pedido por mail",
};
// deno-lint-ignore no-explicit-any
function motivoAlerta(a: any): string {
  const m = String(a?.contexto?.motivo ?? "");
  if (MOTIVO[m]) return MOTIVO[m];
  if (a?.contexto?.lead_id) return MOTIVO.alta_cliente;
  // Motivo agregado desde Configuración › Derivaciones: la clave legible ("garantia_consumidor" → "Garantia consumidor").
  if (m && a?.contexto?.origen === "agente_ia") return m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, " ");
  return MOTIVO[a?.tipo] ?? "Otro";
}

// Alertas abiertas (esperando a una persona), agrupadas por los últimos 10 dígitos del teléfono.
async function alertasAbiertas(): Promise<Map<string, Array<Record<string, unknown>>>> {
  const { data } = await sb.from("wa_alertas_humano").select("id, tipo, phone, contexto, created_at")
    .in("estado", ["pendiente", "notificado"]).neq("tipo", "whitelist_gate").order("created_at").limit(500);
  const m = new Map<string, Array<Record<string, unknown>>>();
  for (const a of data ?? []) {
    const k = ult10(a.phone);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(a);
  }
  return m;
}

// Llave de envíos: modo actual, números de prueba, último cambio (auditoría) y conteo de hoy (cola del bot).
async function llaveEstado() {
  const modo = (await getSetting("wa_envio_automatico")) ?? "0";
  const { count: contactos } = await sb.from("wa_envio_contactos").select("*", { count: "exact", head: true });
  const inicioHoy = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  inicioHoy.setHours(0, 0, 0, 0);
  const desdeIso = new Date(Date.now() - (new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getTime() - inicioHoy.getTime())).toISOString();
  const { data: hoy } = await sb.from("wa_outbox").select("status").gte("created_at", desdeIso).limit(2000);
  const c = { enviados: 0, fallidos: 0, retenidos: 0 };
  for (const r of hoy ?? []) {
    if (r.status === "sent") c.enviados++;
    else if (r.status === "failed") c.fallidos++;
    else if (String(r.status).startsWith("held")) c.retenidos++;
  }
  const { data: ult, error: eAud } = await sb.from("wa_llave_cambios").select("modo_nuevo, usuario, creado_en")
    .order("creado_en", { ascending: false }).limit(1);
  return { modo, contactos_prueba: contactos ?? 0, hoy: c, ultimo_cambio: eAud ? null : (ult?.[0] ?? null), auditoria: !eAud };
}

// ¿Le puede llegar un mensaje manual a este número? Misma llave que el bot (wa_puede_enviar, sql/070).
async function estadoEnvio(phone: string): Promise<{ puede: boolean; llave: string; motivo: string | null }> {
  const llave = (await getSetting("wa_envio_automatico")) ?? "0";
  const { data } = await sb.rpc("wa_puede_enviar", { p_phone: phone });
  const puede = data === true;
  const motivo = puede ? null
    : llave === "prueba" ? "La llave de envío está en modo prueba: sólo reciben los números de la lista de prueba, y este no está."
    : "La llave de envío está apagada: no sale ningún mensaje.";
  return { puede, llave, motivo };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    // ── Gate de admin (OBLIGATORIO para todo) ──
    // Se deploya con --no-verify-jwt: sin este chequeo es un endpoint HTTP
    // anónimo de internet. Expone y manipula TODAS las conversaciones de clientes
    // (`thread` devuelve 300 mensajes de cualquier teléfono).
    const gate = await requireAdmin(body);
    if (!gate.ok) return json({ error: gate.error }, gate.status);

    if (action === "list") {
      const { data, error } = await sb.rpc("wa_conversaciones_list");
      if (error) return json({ error: error.message }, 500);
      const now = Date.now();
      const alertas = await alertasAbiertas();
      const items = (data ?? []).map((r: Record<string, unknown>) => {
        const inb = r.inbound_last_at ? new Date(r.inbound_last_at as string).getTime() : 0;
        const abiertas = alertas.get(ult10(r.phone)) ?? [];
        const ultima = abiertas[abiertas.length - 1];
        const humano = r.modo === "humano";
        const estado_ui = humano ? "humano" : abiertas.length ? "esperando" : r.estado === "resuelto" ? "resuelta" : "bot";
        return {
          estado_ui,
          tema: ultima ? motivoAlerta(ultima) : null,
          espera_desde: abiertas[0]?.created_at ?? null,
          alertas_abiertas: abiertas.length,
          tomada_por: (ultima?.contexto as Record<string, unknown> | undefined)?.tomada_por ?? null,
          ultimo_in_at: r.inbound_last_at ?? null,
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
      const envio = await estadoEnvio(phone);
      // Respuestas manuales (el historial las guarda como 'assistant', igual que al bot): se marcan con
      // lo que registró 'send' en wa_conversations (intent 'humano:<nombre>').
      const { data: hs } = await sb.from("wa_conversations").select("body, intent, created_at")
        .eq("phone", phone).like("intent", "humano:%").order("created_at", { ascending: false }).limit(200);
      for (const m of messages as Array<Record<string, unknown>>) {
        if (m.direction !== "out") continue;
        const t = new Date(m.created_at as string).getTime();
        const h = (hs ?? []).find((x) => x.body === m.body && Math.abs(new Date(x.created_at).getTime() - t) < 5 * 60_000);
        if (h) m.humano = String(h.intent).slice("humano:".length);
      }
      // Eventos: cuándo el bot pasó la charla a una persona y cuándo se atendió.
      const eventos: Array<{ at: string; texto: string }> = [];
      const { data: al2 } = await sb.from("wa_alertas_humano").select("tipo, contexto, created_at, estado, atendido_por, atendido_at")
        .like("phone", `%${ult10(phone)}`).neq("tipo", "whitelist_gate").order("created_at").limit(100);
      for (const a of al2 ?? []) {
        eventos.push({ at: a.created_at, texto: `El bot la pasó a una persona · ${motivoAlerta(a)}` });
        if (a.atendido_at) eventos.push({ at: a.atendido_at, texto: `${a.estado === "descartado" ? "Descartada" : "Atendida"} por ${a.atendido_por ?? "—"}` });
      }
      return json({ messages, eventos, envio, control: { modo_humano: bc?.modo === "humano", agente: bc?.agente_nombre ?? null, modo_expira_en: bc?.modo_expira_en ?? null, estado: hc?.estado ?? "abierto" } });
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

    if (action === "tomar" || action === "devolver") {
      const phone = canon(body.phone);
      if (!phone) return json({ error: "phone requerido" }, 400);
      const tomar = action === "tomar";
      const quien = await nombreUsuario(gate.email);
      const { error } = await sb.rpc("bot_conv_set_modo", {
        p_telefono: phone, p_modo: tomar ? "humano" : "bot",
        p_agente_nombre: tomar ? quien : null, p_motivo: tomar ? "tomó la conversación" : null, p_horas: 8,
      });
      if (error) return json({ error: error.message }, 500);
      if (tomar) await sb.from("wa_human_control").upsert({ phone, estado: "abierto", updated_at: new Date().toISOString() }, { onConflict: "phone" });
      return json({ ok: true, phone, agente: tomar ? quien : null });
    }

    if (action === "resolver") {
      // Resuelta = estado 'resuelto', el bot vuelve a atender, las alertas abiertas de ese número quedan
      // atendidas y sus tareas de Planify se cierran.
      const phone = canon(body.phone);
      if (!phone) return json({ error: "phone requerido" }, 400);
      const quien = await nombreUsuario(gate.email);
      await sb.from("wa_human_control").upsert({ phone, estado: "resuelto", updated_at: new Date().toISOString() }, { onConflict: "phone" });
      await sb.rpc("bot_conv_set_modo", { p_telefono: phone, p_modo: "bot", p_agente_nombre: null, p_motivo: null, p_horas: 8 });
      const { data: al } = await sb.from("wa_alertas_humano").update({ estado: "atendido", atendido_por: quien, atendido_at: new Date().toISOString() })
        .like("phone", `%${ult10(phone)}`).in("estado", ["pendiente", "notificado"]).select("id");
      let secreto = Deno.env.get("LK_FN_CRON_SECRET") ?? "";
      if (!secreto) { const { data } = await sb.rpc("krikos_secret", { p_name: "LK_FN_CRON_SECRET" }); secreto = typeof data === "string" ? data : ""; }
      for (const a of al ?? []) {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/lk_alerta-planify`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-lk-secret": secreto },
          body: JSON.stringify({ action: "cerrar", alerta_id: a.id }),
        }).catch(() => {});
      }
      return json({ ok: true, phone, alertas_cerradas: (al ?? []).length });
    }

    if (action === "ficha") {
      // Ficha del cliente (sólo lectura): datos, modo de entrega, pedidos recientes y avisos enviados.
      const phone = canon(body.phone);
      if (!phone) return json({ error: "phone requerido" }, 400);
      const { data: idf } = await sb.rpc("wa_identify_customer", { p_phone: phone });
      const cli = idf?.[0] ?? null;
      let cliente = null, entrega = null, pedidos: unknown[] = [];
      if (cli) {
        const { data: c } = await sb.from("customers").select("id, cod_cliente, business_name, cuit, localidad, vend")
          .eq("id", cli.customer_id).maybeSingle();
        cliente = c;
        const { data: dirs } = await sb.from("customer_delivery_addresses")
          .select("slot, label, direccion_entrega, zona_expreso, nombre_expreso, localidad").eq("customer_id", cli.customer_id).order("slot").limit(1);
        const d = dirs?.[0];
        if (d) {
          entrega = /^retira/i.test(String(d.zona_expreso ?? "")) ? { modo: "Retira en depósito", detalle: "Virgilio 2788" }
            : String(d.nombre_expreso ?? "").trim() ? { modo: "Expreso", detalle: d.nombre_expreso }
            : { modo: "Reparto", detalle: [d.direccion_entrega, d.localidad].filter(Boolean).join(" · ") };
        }
        const { data: ordsTodos } = await sb.from("orders").select("id, created_at, total").eq("customer_id", cli.customer_id)
          .order("created_at", { ascending: false }).limit(15);
        // Anulados o borrados en Gestión no se muestran (Pablo, 28/09).
        const ords = (await sinAnulados(ordsTodos ?? [])).slice(0, 5);
        const ids = (ords ?? []).map((o) => o.id);
        const { data: est } = ids.length ? await sb.rpc("bot_estado_pedidos_gv", { p_ids: ids }) : { data: [] };
        pedidos = (ords ?? []).map((o) => {
          const e = (est ?? []).find((x: { order_id: number }) => Number(x.order_id) === Number(o.id));
          return { id: o.id, creado: o.created_at, total: o.total, estado: e?.status ?? "recibido", fecha_entrega: e?.fecha_entrega ?? null };
        });
      }
      const { data: av } = await sb.from("wa_outbox").select("template_name, context, status, created_at, sent_at")
        .like("phone", `%${ult10(phone)}`).order("created_at", { ascending: false }).limit(8);
      // Etapa 6 (Pablo, 28/09): facturación y saldo desde Gestión (sólo lectura, consultas de <1 ms).
      //  · Facturacion_NP: qué pedidos (NP) se mandaron a facturar y cuándo. NO se usa vista_facturacion_estado:
      //    recalcula todo el cruce de facturación en cada consulta (2,1 s por cliente, medido el 28/09).
      //  · GV_Cobranza_Deuda_Viva (empresa lk): facturas impagas con comprobante, vencimiento y pendiente; la
      //    recalcula Cobranzas. Si Gestión no responde en 5 s, la ficha sale igual sin esta parte.
      let facturas: unknown[] | null = null, deuda: { saldo: number; comprobantes: unknown[]; calculado_en: string | null } | null = null;
      const cod = String((cliente as { cod_cliente?: unknown } | null)?.cod_cliente ?? "").trim();
      if (cod) {
        try {
          const g = await getGestionClient("public");
          const tope = <T>(p: PromiseLike<T>) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000))]);
          const [fa, dv] = await Promise.all([
            tope(g.from("Facturacion_NP").select("np, fecha_salida, facturado_at")
              .eq("cod_cliente", cod).order("fecha_salida", { ascending: false }).limit(6)),
            tope(g.from("GV_Cobranza_Deuda_Viva").select("comprobante, fecha, vence, pendiente, calculado_en")
              .eq("empresa", "lk").eq("cod_cliente", cod).gt("pendiente", 0).order("fecha", { ascending: true }).limit(50)),
          ]);
          if (!fa.error) facturas = fa.data ?? [];
          if (!dv.error) {
            const rows = (dv.data ?? []) as { pendiente: number; calculado_en: string }[];
            deuda = { saldo: Math.round(rows.reduce((a, r) => a + Number(r.pendiente || 0), 0) * 100) / 100, comprobantes: rows, calculado_en: rows[0]?.calculado_en ?? null };
          }
        } catch (e) { console.error("lk_conversaciones ficha: Gestión no respondió", e); }
      }
      // agendado = el teléfono está en bot_customer_whatsapps (lo que usan las herramientas de la IA). Si sólo lo
      // reconoce el teléfono del ERP, la ficha ofrece "Agendar" con un click (Pablo, 29/09).
      const agendado = cli?.source === "vinculo";
      // Cadena con lista propia (sql/114): la ficha avisa que el bot le cotiza con la lista general (Pablo, 01/10).
      const cadena = cod ? (await cadenasListaPropia([cod])).get(Number(cod)) ?? null : null;
      return json({ ok: true, phone, identificado: !!cli, agendado, fuente: cli?.source ?? null, cliente, cadena, entrega, pedidos, avisos: av ?? [], facturas, deuda });
    }

    if (action === "buscar_cliente") {
      // Para agendar un número que no se reconoce: busca por código exacto o por razón social.
      const q = String(body.q ?? "").trim();
      if (q.length < 2) return json({ ok: true, clientes: [] });
      let qb = sb.from("customers").select("id, cod_cliente, business_name, localidad").limit(8);
      qb = /^\d+$/.test(q) ? qb.eq("cod_cliente", Number(q)) : qb.ilike("business_name", `%${q.replace(/[%_,()]/g, " ")}%`);
      const { data, error } = await qb.order("business_name");
      if (error) return json({ ok: false, error: error.message }, 200);
      const cadenas = await cadenasListaPropia((data ?? []).map((c) => c.cod_cliente));
      return json({ ok: true, clientes: (data ?? []).map((c) => ({ ...c, cadena: cadenas.get(Number(c.cod_cliente)) ?? null })) });
    }

    if (action === "agendar") {
      // Vincula el teléfono al cliente (bot_customer_whatsapps), como una vinculación aprobada pero sin
      // solicitud: lo confirma la persona que atiende. Principal si el cliente no tiene otro. No manda nada:
      // el número no se entera; desde ahí el bot le muestra pedidos, descuentos y fechas de esa cuenta.
      const phone = canon(body.phone);
      const customerId = String(body.customer_id ?? "");
      if (!phone || !customerId) return json({ error: "phone y customer_id requeridos" }, 400);
      const { data: c } = await sb.from("customers").select("id, cod_cliente, business_name").eq("id", customerId).maybeSingle();
      if (!c) return json({ ok: false, error: "cliente no encontrado" }, 200);
      const { data: ya } = await sb.from("bot_customer_whatsapps").select("id, customer_id").like("whatsapp", `%${ult10(phone)}`);
      if ((ya ?? []).length) {
        const mismo = (ya ?? []).some((r) => r.customer_id === c.id);
        return json({ ok: false, error: mismo ? "Ya estaba agendado a este cliente." : "Ese número ya está agendado a otro cliente." }, 200);
      }
      const { count } = await sb.from("bot_customer_whatsapps").select("id", { count: "exact", head: true })
        .eq("customer_id", c.id).eq("is_primary", true);
      const { error } = await sb.from("bot_customer_whatsapps").insert({
        customer_id: c.id, cod_cliente: c.cod_cliente, whatsapp: phone, is_primary: !count, empresa: "LK",
      });
      if (error) return json({ ok: false, error: error.message }, 200);
      console.log(`lk_conversaciones: ${phone} agendado a ${c.cod_cliente} por ${gate.email}`);
      return json({ ok: true, cliente: c.business_name, principal: !count });
    }

    if (action === "salientes") {
      return json(await salientes(Number(body.dias ?? 7)));
    }

    // Informes › Proyección de avisos y gasto (v0.27.0): datos de un corte (_shared/proyeccion-datos.ts) + tarifa viva.
    if (action === "proyeccion") {
      const { data: tRow } = await sb.from("app_settings").select("value").eq("key", "wa_tarifas").maybeSingle();
      let tarifas = {};
      try { if (tRow?.value) tarifas = JSON.parse(tRow.value); } catch { /* tarifa de respaldo */ }
      return json(proyeccion(tarifas));
    }

    if (action === "llave_get") {
      return json({ ok: true, ...(await llaveEstado()) });
    }

    if (action === "llave_set") {
      // Sólo admins (este gate). Pasar a producción exige escribir PRODUCCIÓN. Queda auditado.
      const modo = String(body.modo ?? "");
      if (!["0", "prueba", "1"].includes(modo)) return json({ error: "modo inválido" }, 400);
      if (modo === "1") {
        const conf = String(body.confirmacion ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
        if (conf !== "PRODUCCION") return json({ error: "Para pasar a producción hay que escribir PRODUCCIÓN." }, 400);
      }
      const antes = (await getSetting("wa_envio_automatico")) ?? "0";
      const quien = await nombreUsuario(gate.email);
      const { error: eAud } = await sb.from("wa_llave_cambios").insert({ modo_anterior: antes, modo_nuevo: modo, usuario: quien, email: gate.email });
      if (eAud) return json({ error: "No se pudo registrar el cambio (auditoría): " + eAud.message }, 500);
      const { error } = await sb.from("app_settings").upsert({ key: "wa_envio_automatico", value: modo }, { onConflict: "key" });
      if (error) return json({ error: error.message }, 500);
      console.log(`lk_conversaciones: llave ${antes} → ${modo} por ${gate.email}`);
      return json({ ok: true, ...(await llaveEstado()) });
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
      // Corte único (D007): la misma decisión que el bot, wa_puede_enviar (llave wa_envio_automatico).
      // Antes había además wa_human_send_whitelist_only: salir a producción exigía DOS cambios (Pablo,
      // 28/09). Ese setting ya no se lee; wa-guard igual vuelve a chequear en el fetch.
      const envio = await estadoEnvio(phone);
      if (!envio.puede) return json({ error: "envio_cortado", note: envio.motivo }, 403);
      const token = await metaToken(), phoneId = await waPhoneId();
      if (!token || !phoneId) return json({ error: "faltan credenciales WhatsApp" }, 500);
      let wamid = null, sendErr = null;
      try {
        const res = await fetch(`${META_API}/${phoneId}/messages`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: texto.slice(0, 4000) } }),
        });
        const d = await res.json();
        if (!res.ok) {
          sendErr = d?.error?.message || `HTTP ${res.status}`;
          // Sin esto el motivo de Meta sólo lo veía quien apretó "Enviar": en los logs quedaba un 502 pelado.
          console.error("lk_conversaciones send: Meta rechazó", res.status, JSON.stringify(d?.error ?? d));
        }
        else wamid = d?.messages?.[0]?.id ?? null;
      } catch (e) { sendErr = String(e); }
      if (sendErr) return json({ error: "envio: " + sendErr }, 502);

      // Guardar en el historial del bot (rol assistant) + pasar a modo humano (pausa el bot) + leído.
      await sb.rpc("bot_guardar_mensaje", { p_telefono: phone, p_rol: "assistant", p_contenido: texto });
      // Para que la charla la muestre como respuesta de una persona (no del bot).
      const quienEnvia = await nombreUsuario(gate.email);
      await sb.from("wa_conversations").insert({ phone, direction: "out", body: texto, msg_type: "text", intent: "humano:" + quienEnvia, wa_msg_id: wamid });
      await sb.rpc("bot_conv_set_modo", { p_telefono: phone, p_modo: "humano", p_agente_nombre: quienEnvia, p_motivo: "respuesta manual", p_horas: 8 });
      await sb.from("wa_human_control").upsert({ phone, last_read_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "phone" });
      return json({ ok: true, phone, wamid });
    }

    // ── Reabrir con plantilla (Pablo, 06/10: "deberíamos tener una plantilla de reactivación") ──
    // Pasadas las 24 h del último mensaje del cliente WhatsApp sólo deja mandar una plantilla aprobada. `retomar_consulta` (plantillas-meta.ts)
    // es el texto neutro para retomar una consulta. Mandarla NO abre la ventana: se abre cuando el cliente contesta o toca el botón. Pasa
    // por la misma llave de envío que todo (wa_puede_enviar + wa-guard). Deja la charla en modo humano, como `send`.
    if (action === "reabrir") {
      const phone = canon(body.phone);
      if (!phone) return json({ error: "phone requerido" }, 400);
      const { data: lastIn } = await sb.from("bot_historial_chat").select("creado_en")
        .eq("telefono", phone).eq("rol", "user").order("creado_en", { ascending: false }).limit(1).maybeSingle();
      const inb = lastIn?.creado_en ? new Date(lastIn.creado_en).getTime() : 0;
      if (inb && (Date.now() - inb) < DAY) {
        return json({ error: "ventana_abierta", note: "La ventana de 24 h sigue abierta: mandá un mensaje normal, no hace falta plantilla." }, 409);
      }
      const envio = await estadoEnvio(phone);
      if (!envio.puede) return json({ error: "envio_cortado", note: envio.motivo }, 403);
      const token = await metaToken(), phoneId = await waPhoneId();
      if (!token || !phoneId) return json({ error: "faltan credenciales WhatsApp" }, 500);
      let nombre = String(body.nombre ?? "").trim();
      if (!nombre) {
        const { data: cli } = await sb.rpc("wa_identify_customer", { p_phone: phone });
        nombre = String(cli?.[0]?.customer_name ?? cli?.[0]?.business_name ?? "").trim();
      }
      nombre = (nombre.replace(/\s+/g, " ") || "cliente").slice(0, 100); // Meta no acepta saltos de línea ni espacios largos en un dato
      const nombrePlantilla = nombreActivo(await leerVersiones(sb), "retomar_consulta");
      let wamid: string | null = null, sendErr: string | null = null;
      try {
        const res = await fetch(`${META_API}/${phoneId}/messages`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "template", template: {
            name: nombrePlantilla, language: { code: "es_AR" }, components: [{ type: "body", parameters: [{ type: "text", text: nombre }] }] } }),
        });
        const d = await res.json();
        if (!res.ok) {
          sendErr = ERRORES_META[Number(d?.error?.code)] ?? d?.error?.message ?? `HTTP ${res.status}`;
          console.error("lk_conversaciones reabrir: Meta rechazó", res.status, JSON.stringify(d?.error ?? d));
        } else wamid = d?.messages?.[0]?.id ?? null;
      } catch (e) { sendErr = String(e); }
      if (sendErr) return json({ error: "envio: " + sendErr }, 502);
      const texto = renderPlantilla("retomar_consulta", { "1": nombre }) ?? `[template: ${nombrePlantilla}]`;
      await sb.rpc("bot_guardar_mensaje", { p_telefono: phone, p_rol: "assistant", p_contenido: texto });
      const quienEnvia = await nombreUsuario(gate.email);
      await sb.from("wa_conversations").insert({ phone, direction: "out", body: texto, msg_type: "template", intent: "humano:" + quienEnvia, wa_msg_id: wamid });
      await sb.rpc("bot_conv_set_modo", { p_telefono: phone, p_modo: "humano", p_agente_nombre: quienEnvia, p_motivo: "reabierta con plantilla", p_horas: 8 });
      await sb.from("wa_human_control").upsert({ phone, last_read_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "phone" });
      return json({ ok: true, phone, wamid, plantilla: nombrePlantilla, texto });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_conversaciones error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
