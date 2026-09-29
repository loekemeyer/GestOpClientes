import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { requireAdmin } from "../_shared/admin-gate.ts";
import { supabase } from "../_shared/supabase.ts";
import { CATEGORIAS, categoria, nivel, SETTING_VENCIMIENTO, urgente, vencimientos } from "../_shared/alertas-vencimiento.ts";
import { derivaciones, MOTIVOS_IA, ORIGEN, SETTING_DERIVACIONES } from "../_shared/derivaciones.ts";
import { getGestionClient } from "../_shared/supabase.ts";
import { COD_CLIENTE_PRUEBA } from "../_shared/cliente-prueba.ts";

// Tarea creada desde el Simulador con un cliente real: se ve, pero no se aplica (no toca pedidos ni claves reales).
// deno-lint-ignore no-explicit-any
async function bloqueoPrueba(a: any): Promise<string | null> {
  if (a?.contexto?.simulador !== true) return null;
  const { data: c } = await supabase.from("customers").select("cod_cliente").eq("id", a.customer_id ?? "").maybeSingle();
  return Number(c?.cod_cliente) === COD_CLIENTE_PRUEBA ? null
    : `Es una tarea de prueba del Simulador con un cliente real: no se aplica. Probá con el cliente de prueba ${COD_CLIENTE_PRUEBA}.`;
}

// lk_alertas — bandeja de alertas para humanos (wa_alertas_humano) con vencimiento.
// La usa el dashboard (menú 🔔 Alertas). Sólo admins (requireAdmin).
//
//   {action:"list", incluir_resueltas?, incluir_ruido?}  → alertas + vencimiento calculado
//   {action:"resolver", id, estado: "atendido"|"descartado"}
//   {action:"alta_decidir", id, decision:"approve"|"reject", cod_cliente?} → decide la solicitud de alta
//        (wa_prospect_leads.status approved/rejected), encola el aviso al cliente en wa_outbox (sale según la
//        llave) y cierra la alerta y su tarea de Planify.
//   {action:"adjunto", comprobante_id} → link firmado (10 min) al archivo del comprobante (bucket privado)
//   {action:"config_get"} / {action:"config_save", vencimientos:{categoria: minutos}}
//   {action:"derivaciones_get"} / {action:"derivaciones_save", prueba_employee_id, motivos:{cat:{destino, employee_id, department_id}}, extra:[…]}
//        → Configuración › Derivaciones: a dónde va cada motivo (app_settings.wa_derivaciones, _shared/derivaciones.ts)
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

const SETTING = SETTING_VENCIMIENTO;

// Textos del aviso de alta (prototipo de Claude Design, 28/09; validar con el negocio). El front los muestra
// tal cual en el modal de confirmación, por eso se arman acá y se devuelven en list.
function avisoAlta(decision: string, razon: string, cod: string): string {
  if (decision === "approve") {
    return `¡Bienvenido a Loekemeyer! Ya dimos de alta a ${razon || "tu comercio"} como cliente.` +
      (cod ? ` Tu código es ${cod}` : "") + (cod ? " y un vendedor se va a comunicar con vos." : " Un vendedor se va a comunicar con vos.");
  }
  return "Gracias por escribirnos. Por ahora no podemos darte de alta como cliente. Si querés más información, respondé este mensaje.";
}
const ult10 = (p: unknown) => String(p ?? "").replace(/\D/g, "").slice(-10);

// Cierra la tarea de Planify de la alerta (lk_alerta-planify). Nunca frena la respuesta al dashboard.
async function llamarPlanify(body: Record<string, unknown>): Promise<void> {
  try {
    let secreto = Deno.env.get("LK_FN_CRON_SECRET") ?? "";
    if (!secreto) {
      const { data } = await supabase.rpc("krikos_secret", { p_name: "LK_FN_CRON_SECRET" });
      secreto = typeof data === "string" ? data : "";
    }
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/lk_alerta-planify`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-lk-secret": secreto }, body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("lk_alertas: no pude avisar a Planify", e);
  }
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
      await vencimientos(); // registra los motivos agregados en Derivaciones
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

    if (body.action === "derivaciones_get") {
      const [der, v] = await Promise.all([derivaciones(), vencimientos()]);
      // Personas y sectores de Planify (Gestión). Si Gestión no contesta, el panel muestra los ids.
      let empleados: unknown[] = [], sectores: unknown[] = [];
      try {
        const g = await getGestionClient("planify");
        const [e, d] = await Promise.all([
          g.from("employees").select("id, nombre").eq("activo", true).order("nombre"),
          g.from("departments").select("id, nombre").eq("activo", true).order("nombre"),
        ]);
        empleados = e.data ?? []; sectores = d.data ?? [];
      } catch (e) { console.error("lk_alertas derivaciones: Planify no respondió", e); }
      const { data: llave } = await supabase.from("app_settings").select("value").eq("key", "wa_envio_automatico").maybeSingle();
      const niv = (cat: string) => nivel({ tipo: cat, contexto: { motivo: cat } });
      const extras = new Map(der.extra.map((e) => [e.clave, e]));
      return json({
        ok: true, llave: llave?.value ?? "0", prueba_employee_id: der.prueba_employee_id, defecto: der.defecto,
        empleados, sectores,
        motivos: Object.entries(CATEGORIAS).filter(([k]) => k !== "whitelist_gate").map(([k, c]) => ({
          categoria: k, label: c.label, nivel: niv(k), minutos: v[k],
          origen: extras.has(k) ? "La IA deriva: " + (extras.get(k)!.cuando || c.label) : ORIGEN[k] ?? "",
          de_ia: MOTIVOS_IA.includes(k) || extras.has(k), extra: extras.get(k) ?? null, ...der.motivos[k],
        })),
      });
    }

    if (body.action === "derivaciones_save") {
      await vencimientos(); // registra los extras ya guardados
      const id = (x: unknown) => (x === null || x === "" || x === undefined ? null : Number(x) > 0 ? Math.round(Number(x)) : NaN);
      const prueba = id(body.prueba_employee_id);
      if (Number.isNaN(prueba)) return json({ ok: false, error: "Persona de prueba inválida." }, 400);
      // Motivos nuevos (los deriva la IA): clave en snake_case, nombre, cuándo derivar y vencimiento.
      const extra: Array<Record<string, unknown>> = [];
      for (const e of (Array.isArray(body.extra) ? body.extra : []) as Array<Record<string, unknown>>) {
        const clave = String(e.clave ?? "").trim();
        if (!/^[a-z][a-z0-9_]{2,40}$/.test(clave)) return json({ ok: false, error: `Clave inválida: "${clave}" (minúsculas, números y _)` }, 400);
        if (CATEGORIAS[clave] && !CATEGORIAS[clave].extra) return json({ ok: false, error: `"${clave}" ya existe como motivo del sistema.` }, 400);
        const nombre = String(e.nombre ?? "").trim(), cuando = String(e.cuando ?? "").trim();
        if (!nombre || !cuando) return json({ ok: false, error: `El motivo ${clave} necesita nombre y cuándo derivarlo.` }, 400);
        const min = Math.round(Number(e.min));
        if (!(min >= 1 && min <= 60 * 24 * 30)) return json({ ok: false, error: `Vencimiento inválido en ${clave}.` }, 400);
        extra.push({ clave, nombre: nombre.slice(0, 80), cuando: cuando.slice(0, 300), min });
      }
      const claves = new Set([...Object.keys(CATEGORIAS), ...extra.map((e) => String(e.clave))]);
      const esIA = new Set([...MOTIVOS_IA, ...extra.map((e) => String(e.clave))]);
      const motivos: Record<string, unknown> = {};
      for (const [k, r] of Object.entries((body.motivos ?? {}) as Record<string, Record<string, unknown>>)) {
        if (!claves.has(k) || k === "whitelist_gate") continue; // un extra borrado se descarta
        const e = id(r.employee_id), d = id(r.department_id);
        if (Number.isNaN(e) || Number.isNaN(d)) return json({ ok: false, error: `Destino inválido en ${k}` }, 400);
        const dest = String(r.destino ?? "");
        if (!["planify", "tareas", "bot"].includes(dest)) return json({ ok: false, error: `Destino inválido en ${k}` }, 400);
        if (dest === "bot" && !esIA.has(k)) return json({ ok: false, error: `${k} no lo deriva la IA: no puede quedar en "lo responde el bot".` }, 400);
        motivos[k] = { destino: dest, employee_id: e, department_id: d };
      }
      const { error } = await supabase.from("app_settings")
        .upsert({ key: SETTING_DERIVACIONES, value: JSON.stringify({ prueba_employee_id: prueba, motivos, extra }) }, { onConflict: "key" });
      if (error) return json({ ok: false, error: error.message }, 200);
      console.log(`lk_alertas: derivaciones actualizadas por ${gate.email}`);
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
      // Pedidos por FECHA ("pedido del 28/09"), no por número (pedido de Pablo, 28/09).
      const pedIds = [...new Set((data ?? []).map((a) => Number(a.contexto?.pedido)).filter((n) => n > 0))];
      const fechaPed: Record<number, string> = {};
      if (pedIds.length) {
        const { data: os } = await supabase.from("orders").select("id, created_at").in("id", pedIds);
        for (const o of os ?? []) {
          fechaPed[o.id] = new Date(o.created_at).toLocaleDateString("es-AR",
            { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit" });
        }
      }
      // Datos para Centro de mensajes › Tareas: la solicitud de alta (wa_prospect_leads) y el comprobante
      // (wa_comprobantes) de cada alerta, sin mandar el contexto crudo.
      const leadIds = [...new Set((data ?? []).map((a) => Number(a.contexto?.lead_id)).filter((n) => n > 0))];
      const leads: Record<number, Record<string, unknown>> = {};
      if (leadIds.length) {
        const { data: ls } = await supabase.from("wa_prospect_leads")
          .select("id, razon_social, nombre_contacto, telefono, cuit, mail, direccion, localidad, provincia, codigo_postal, condicion_iva, expreso_nombre, tipo_comercio, ya_vende_lk, a_quien_compra, status")
          .in("id", leadIds);
        for (const l of ls ?? []) leads[l.id] = l;
      }
      const compIds = [...new Set((data ?? []).map((a) => String(a.contexto?.comprobante_id ?? "")).filter(Boolean))];
      const comps: Record<string, Record<string, unknown>> = {};
      if (compIds.length) {
        const { data: cs } = await supabase.from("wa_comprobantes")
          .select("id, tipo, monto_total, moneda, fecha_operacion, status, es_comprobante, caption, mime_type, matched_doc_tipo")
          .in("id", compIds);
        for (const c of cs ?? []) comps[c.id] = c;
      }
      // Último mensaje del cliente (ventana de 24 h de Meta: fuera de ella no sale texto libre).
      const tels = [...new Set((data ?? []).map((a) => String(a.phone ?? "")).filter(Boolean))];
      const ultIn: Record<string, string> = {};
      if (tels.length) {
        const { data: ins } = await supabase.from("wa_conversations").select("phone, created_at")
          .eq("direction", "in").in("phone", tels).order("created_at", { ascending: false }).limit(1000);
        for (const i of ins ?? []) { const k = ult10(i.phone); if (!ultIn[k]) ultIn[k] = i.created_at; }
      }
      const ahora = Date.now();
      const alertas = (data ?? []).map((a) => {
        const cat = categoria(a);
        const venceAt = new Date(new Date(a.created_at).getTime() + v[cat] * 60_000);
        const ctx = a.contexto ?? {};
        return {
          id: a.id, tipo: a.tipo, categoria: cat, label: (ctx.simulador ? "🧪 Prueba · " : "") + CATEGORIAS[cat].label,
          prueba: ctx.simulador === true,
          phone: a.phone, cliente: a.customer_id ? (nombres[a.customer_id] ?? null) : (ctx.razon_social ?? null),
          texto: ctx.texto_recibido ?? ctx.texto ?? null, pedido: ctx.pedido ?? null,
          pedido_fecha: fechaPed[Number(ctx.pedido)] ?? null,
          tomada_por: ctx.tomada_por ?? null,
          estado: a.estado, created_at: a.created_at, atendido_por: a.atendido_por, atendido_at: a.atendido_at,
          vence_at: venceAt.toISOString(),
          vencida: ["pendiente", "notificado"].includes(a.estado) && venceAt.getTime() < ahora,
          urgente: urgente(a),
          nivel: nivel(a),
          espera_min: Math.round((ahora - new Date(a.created_at).getTime()) / 60000),
          motivo: ctx.motivo ?? null,
          alta: leads[Number(ctx.lead_id)] ?? null,
          ultimo_in_at: ultIn[ult10(a.phone)] ?? null,
          avisos_alta: ctx.lead_id ? {
            aprobar: avisoAlta("approve", String(leads[Number(ctx.lead_id)]?.razon_social ?? ctx.razon_social ?? ""), ""),
            aprobar_con_codigo: avisoAlta("approve", String(leads[Number(ctx.lead_id)]?.razon_social ?? ctx.razon_social ?? ""), "{{cod}}"),
            rechazar: avisoAlta("reject", "", ""),
          } : null,
          comprobante: ctx.comprobante_id ? (comps[String(ctx.comprobante_id)] ?? { id: ctx.comprobante_id }) : null,
          error_detalle: a.tipo === "comprobante_error" ? (ctx.error ?? ctx.motivo ?? null) : null,
          error_archivo: ctx.error_archivo ?? null,
          agregar: Array.isArray(ctx.agregar) ? ctx.agregar : null,
          sucursal: ctx.sucursal ?? null,
          aplicable: ctx.aplicable === true,
        };
      }).sort((x, y) => {
        // Abiertas primero; dentro de las abiertas: urgentes, después vencidas, después por vencimiento.
        const ab = (z: { estado: string }) => ["pendiente", "notificado"].includes(z.estado);
        if (ab(x) !== ab(y)) return ab(x) ? -1 : 1;
        const orden = { rojo: 0, amarillo: 1, verde: 2 } as Record<string, number>;
        if (x.nivel !== y.nivel) return orden[x.nivel] - orden[y.nivel];
        if (x.vencida !== y.vencida) return x.vencida ? -1 : 1;
        return x.vence_at.localeCompare(y.vence_at);
      });
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
      await llamarPlanify({ action: "cerrar", alerta_id: id });   // si tenía tarea en Planify, se cierra
      return json({ ok: true });
    }

    // Pablo, 29/09 (alta mixta): quien aprueba completa código, vendedor y descuento; se crea el cliente en la web con
    // acceso (usuario = CUIT, clave temporal, crear_cliente_web), su dirección de entrega (pendiente de cargar en ISIS)
    // y se le manda la bienvenida con el acceso por la cola (sale según la llave). El número NO se vincula solo al
    // cliente (regla: los teléfonos de clientes en tablas de envío los decide Luis): cuando escriba, el bot le pide el
    // CUIT y la vinculación la aprueba una persona, como con cualquier número nuevo.
    if (body.action === "alta_crear") {
      const id = Number(body.id);
      const cod = Number(String(body.cod_cliente ?? "").replace(/\D/g, ""));
      const vend = String(body.vend ?? "").replace(/\D/g, "");
      const dto = Number(body.dto_vol ?? 0);
      if (!id || !cod || !vend || !(dto >= 0 && dto <= 0.5)) return json({ ok: false, error: "Faltan el código de cliente, el vendedor o el descuento (entre 0 y 50 %)." }, 200);
      const { data: a } = await supabase.from("wa_alertas_humano").select("id, phone, contexto, estado").eq("id", id).maybeSingle();
      const leadId = Number(a?.contexto?.lead_id);
      if (!a || !leadId) return json({ ok: false, error: "La alerta no es una solicitud de alta." }, 200);
      if (!["pendiente", "notificado"].includes(a.estado)) return json({ ok: false, error: "La alerta ya estaba resuelta." }, 200);
      const { data: l } = await supabase.from("wa_prospect_leads").select("*").eq("id", leadId).maybeSingle();
      if (!l) return json({ ok: false, error: "No encontré la solicitud de alta." }, 200);
      if (l.status === "approved" || l.customer_id) return json({ ok: false, error: "La solicitud ya estaba aprobada." }, 200);
      if (!l.cuit || !l.razon_social) return json({ ok: false, error: "A la solicitud le falta el CUIT o la razón social." }, 200);
      const { data: codUsado } = await supabase.from("customers").select("business_name").eq("cod_cliente", cod).limit(1);
      if (codUsado?.length) return json({ ok: false, error: `El código ${cod} ya es de ${codUsado[0].business_name}.` }, 200);

      const rnd = crypto.getRandomValues(new Uint32Array(8));
      const LET = "abcdefghjkmnpqrstuvwxyz";
      const pin = Array.from(rnd.slice(0, 4), (n) => LET[n % LET.length]).join("") + Array.from(rnd.slice(4), (n) => String(n % 10)).join("");
      const { data: cw, error: eC } = await supabase.rpc("crear_cliente_web", {
        p_cuit: l.cuit, p_pin: pin, p_business_name: l.razon_social, p_mail: l.mail ?? null, p_escala_activa: false,
      });
      if (eC) return json({ ok: false, error: "No se pudo crear el acceso: " + eC.message }, 200);
      const customerId = cw.customer_id;
      const pasos: string[] = [];
      const { error: eU } = await supabase.from("customers").update({
        cod_cliente: cod, vend, dto_vol: dto, localidad: l.localidad ?? null,
      }).eq("id", customerId);
      if (eU) pasos.push("datos del cliente: " + eU.message);
      if (l.direccion) {
        const { error: eD } = await supabase.from("customer_delivery_addresses").insert({
          customer_id: customerId, slot: 1, label: `${l.direccion}${l.localidad ? " - " + l.localidad : ""}`.slice(0, 120),
          direccion_entrega: l.direccion, localidad: l.localidad ?? null, provincia: l.provincia ?? null, cp: l.codigo_postal ?? null,
          nombre_expreso: l.expreso_nombre ?? null, pending_isis: true,
        });
        if (eD) pasos.push("dirección de entrega: " + eD.message);
      }
      await supabase.from("wa_prospect_leads").update({ status: "approved", customer_id: customerId, updated_at: new Date().toISOString() }).eq("id", leadId);
      const texto = `¡Bienvenido a Loekemeyer! 🎉 Ya sos cliente (código ${cod}).\n` +
        `Hacé tus pedidos en loekemeyer.com → "Pedidos Mayorista":\nUsuario: ${cw.username}\nClave: ${pin}\nNo la compartas con nadie.`;
      const { error: eO } = await supabase.from("wa_outbox").insert({ phone: l.phone ?? a.phone, body: texto, context: "alta_aprobada", ref_id: String(leadId) });
      await supabase.from("wa_alertas_humano").update({
        estado: "atendido", atendido_por: gate.email, atendido_at: new Date().toISOString(),
        contexto: { ...a.contexto, decision_alta: "approve", cod_cliente_asignado: cod, vend, dto_vol: dto, customer_id: customerId },
      }).eq("id", id);
      await llamarPlanify({ action: "cerrar", alerta_id: id });
      console.log(`lk_alertas: alta creada ${l.razon_social} (${cod}) por ${gate.email}`);
      return json({ ok: true, usuario: cw.username, cod_cliente: cod, pendientes: pasos, aviso_encolado: !eO, error_aviso: eO?.message ?? null });
    }

    // Pablo, 29/09: dirección de entrega nueva pedida por WhatsApp (solicitar_nueva_sucursal). Se AGREGA como sucursal
    // (cada pedido web elige la suya), marcada pendiente de cargar en ISIS, y se le avisa al cliente por la cola.
    if (body.action === "sucursal_agregar") {
      const id = Number(body.id);
      if (!id) return json({ ok: false, error: "falta id" }, 400);
      const { data: a } = await supabase.from("wa_alertas_humano").select("id, phone, customer_id, contexto, estado").eq("id", id).maybeSingle();
      const suc = a?.contexto?.sucursal;
      if (!a || !suc?.calle_altura) return json({ ok: false, error: "La tarea no es una dirección nueva." }, 200);
      if (!["pendiente", "notificado"].includes(a.estado)) return json({ ok: false, error: "La tarea ya estaba resuelta." }, 200);
      if (!a.customer_id) return json({ ok: false, error: "La tarea no tiene cliente identificado." }, 200);
      const bloq = await bloqueoPrueba(a);
      if (bloq) return json({ ok: false, error: bloq }, 200);
      const { data: slots } = await supabase.from("customer_delivery_addresses").select("slot").eq("customer_id", a.customer_id);
      const slot = Math.max(0, ...(slots ?? []).map((x) => Number(x.slot) || 0)) + 1;
      const label = `${suc.calle_altura} - ${suc.localidad}`.slice(0, 120);
      const { error: eI } = await supabase.from("customer_delivery_addresses").insert({
        customer_id: a.customer_id, slot, label, direccion_entrega: suc.calle_altura, localidad: suc.localidad,
        provincia: suc.provincia ?? null, cp: suc.cp ?? null, nombre_expreso: suc.expreso ?? null,
        observaciones: suc.observaciones ?? null, pending_isis: true,
      });
      if (eI) return json({ ok: false, error: "No se pudo agregar la dirección: " + eI.message }, 200);
      const texto = `Listo: agregamos la dirección ${label} a tu cuenta. La vas a poder elegir en tu próximo pedido en loekemeyer.com.`;
      const { error: eO } = await supabase.from("wa_outbox").insert({ phone: a.phone, body: texto, context: "sucursal_agregada", ref_id: String(id) });
      await supabase.from("wa_alertas_humano").update({
        estado: "atendido", atendido_por: gate.email, atendido_at: new Date().toISOString(),
        contexto: { ...a.contexto, sucursal_slot: slot },
      }).eq("id", id);
      await llamarPlanify({ action: "cerrar", alerta_id: id });
      return json({ ok: true, slot, label, aviso_encolado: !eO, error_aviso: eO?.message ?? null });
    }

    // Vendedores para el alta (Wpp_Vendedores: "V.13 Luis Moñin" → 13).
    if (body.action === "vendedores") {
      const { data } = await supabase.from("Wpp_Vendedores").select("contacto_wsp");
      const lista = (data ?? []).map((v) => { const m = String(v.contacto_wsp).match(/^V\.?\s*(\d+)\s+(.*)$/); return m ? { vend: m[1], nombre: m[2].trim() } : null; })
        .filter(Boolean).sort((x, y) => Number(x!.vend) - Number(y!.vend));
      return json({ ok: true, vendedores: lista });
    }

    if (body.action === "alta_decidir") {
      const id = Number(body.id);
      const decision = String(body.decision ?? "");
      const cod = String(body.cod_cliente ?? "").replace(/\D/g, "");
      if (!id || !["approve", "reject"].includes(decision)) return json({ ok: false, error: "parámetros inválidos" }, 400);
      const { data: a } = await supabase.from("wa_alertas_humano").select("id, phone, contexto, estado").eq("id", id).maybeSingle();
      const leadId = Number(a?.contexto?.lead_id);
      if (!a || !leadId) return json({ ok: false, error: "La alerta no es una solicitud de alta." }, 200);
      if (!["pendiente", "notificado"].includes(a.estado)) return json({ ok: false, error: "La alerta ya estaba resuelta." }, 200);
      const { data: lead } = await supabase.from("wa_prospect_leads").select("id, phone, razon_social, status").eq("id", leadId).maybeSingle();
      if (!lead) return json({ ok: false, error: "No encontré la solicitud de alta." }, 200);
      if (["approved", "rejected"].includes(String(lead.status))) return json({ ok: false, error: `La solicitud ya estaba ${lead.status === "approved" ? "aprobada" : "rechazada"}.` }, 200);

      const { error: eL } = await supabase.from("wa_prospect_leads")
        .update({ status: decision === "approve" ? "approved" : "rejected", updated_at: new Date().toISOString() }).eq("id", leadId);
      if (eL) return json({ ok: false, error: eL.message }, 200);
      const texto = avisoAlta(decision, String(lead.razon_social ?? ""), cod);
      const { error: eO } = await supabase.from("wa_outbox").insert({
        phone: lead.phone ?? a.phone, body: texto,
        context: decision === "approve" ? "alta_aprobada" : "alta_rechazada", ref_id: String(leadId),
      });
      await supabase.from("wa_alertas_humano").update({
        estado: "atendido", atendido_por: gate.email, atendido_at: new Date().toISOString(),
        contexto: { ...a.contexto, decision_alta: decision, cod_cliente_asignado: cod || null },
      }).eq("id", id);
      await llamarPlanify({ action: "cerrar", alerta_id: id });
      console.log(`lk_alertas: alta ${decision} lead ${leadId} por ${gate.email}`);
      return json({ ok: true, aviso_encolado: !eO, error_aviso: eO?.message ?? null });
    }

    // Pablo, 29/09: "Aplicar" un agregado pedido por WhatsApp (bot_aplicar_agregado, sql/099) y avisarle al cliente
    // por la cola (sale según la llave).
    if (body.action === "aplicar_agregado") {
      const id = Number(body.id);
      if (!id) return json({ ok: false, error: "falta id" }, 400);
      const { data: aa } = await supabase.from("wa_alertas_humano").select("customer_id, contexto").eq("id", id).maybeSingle();
      const bloq = await bloqueoPrueba(aa);
      if (bloq) return json({ ok: false, error: bloq }, 200);
      const { data: r, error } = await supabase.rpc("bot_aplicar_agregado", { p_alerta_id: id, p_aprobado_por: gate.email });
      if (error) return json({ ok: false, error: error.message }, 200);
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(r.creado));
      const pesos = (n: number) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");
      const texto = `Listo: sumamos a tu pedido del ${p.slice(8, 10)}/${p.slice(5, 7)}:\n` +
        (r.lineas as string[]).map((l) => `• ${l}`).join("\n") + `\nNuevo total: ${pesos(r.total_nuevo)} + IVA.`;
      const { error: eO } = await supabase.from("wa_outbox").insert({
        phone: r.phone, body: texto, context: "agregado_aplicado", ref_id: String(r.pedido),
      });
      await llamarPlanify({ action: "cerrar", alerta_id: id });
      console.log(`lk_alertas: agregado aplicado al pedido ${r.pedido} por ${gate.email}`);
      return json({ ok: true, total_anterior: r.total_anterior, total_nuevo: r.total_nuevo, aviso_encolado: !eO, error_aviso: eO?.message ?? null });
    }

    // Pablo, 29/09: reseteo de clave con aprobación. Genera una clave temporal, la guarda en la cuenta de la web del
    // cliente (auth de PaginaLK) y se la manda por la cola (sale según la llave). La clave no queda en la alerta.
    if (body.action === "reset_clave") {
      const id = Number(body.id);
      if (!id) return json({ ok: false, error: "falta id" }, 400);
      const { data: a } = await supabase.from("wa_alertas_humano").select("id, phone, customer_id, contexto, estado").eq("id", id).maybeSingle();
      if (!a || a.contexto?.motivo !== "reseteo_clave") return json({ ok: false, error: "La tarea no es un pedido de clave." }, 200);
      if (!["pendiente", "notificado"].includes(a.estado)) return json({ ok: false, error: "La tarea ya estaba resuelta." }, 200);
      if (!a.customer_id || !a.phone) return json({ ok: false, error: "La tarea no tiene cliente identificado." }, 200);
      const bloqC = await bloqueoPrueba(a);
      if (bloqC) return json({ ok: false, error: bloqC }, 200);
      const { data: c } = await supabase.from("customers").select("auth_user_id, cuit, business_name").eq("id", a.customer_id).maybeSingle();
      if (!c?.auth_user_id) return json({ ok: false, error: "El cliente no tiene usuario en la web: hay que darle acceso primero." }, 200);
      const { data: u, error: eU } = await supabase.auth.admin.getUserById(c.auth_user_id);
      if (eU || !u?.user?.email) return json({ ok: false, error: "No encontré el usuario de la web." }, 200);
      const usuario = String(u.user.email).split("@")[0];
      // 4 letras + 4 números, sin letras que se confunden (l, o, i).
      const rnd = crypto.getRandomValues(new Uint32Array(8));
      const LET = "abcdefghjkmnpqrstuvwxyz";
      const clave = Array.from(rnd.slice(0, 4), (n) => LET[n % LET.length]).join("") + Array.from(rnd.slice(4), (n) => String(n % 10)).join("");
      const { error: eP } = await supabase.auth.admin.updateUserById(c.auth_user_id, { password: clave });
      if (eP) return json({ ok: false, error: "No se pudo cambiar la clave: " + eP.message }, 200);
      const texto = `Te generamos una clave nueva para la web (loekemeyer.com → "Pedidos Mayorista"):\n` +
        `Usuario: ${usuario}\nClave: ${clave}\nNo la compartas con nadie.`;
      const { error: eO } = await supabase.from("wa_outbox").insert({ phone: a.phone, body: texto, context: "clave_temporal", ref_id: String(id) });
      await supabase.from("wa_alertas_humano").update({
        estado: "atendido", atendido_por: gate.email, atendido_at: new Date().toISOString(),
        contexto: { ...a.contexto, clave_reseteada_at: new Date().toISOString() },
      }).eq("id", id);
      await llamarPlanify({ action: "cerrar", alerta_id: id });
      console.log(`lk_alertas: clave reseteada para ${c.business_name} por ${gate.email}`);
      return json({ ok: true, usuario, aviso_encolado: !eO, error_aviso: eO?.message ?? null });
    }

    if (body.action === "adjunto") {
      const id = String(body.comprobante_id ?? "");
      if (!id) return json({ ok: false, error: "falta comprobante_id" }, 400);
      const { data: c } = await supabase.from("wa_comprobantes").select("storage_bucket, storage_path").eq("id", id).maybeSingle();
      if (!c?.storage_path) return json({ ok: false, error: "El comprobante no tiene archivo guardado." }, 200);
      const { data: f, error } = await supabase.storage.from(c.storage_bucket ?? "wa-comprobantes").createSignedUrl(c.storage_path, 600);
      if (error || !f?.signedUrl) return json({ ok: false, error: error?.message ?? "sin link" }, 200);
      return json({ ok: true, url: f.signedUrl });
    }

    return json({ error: "action desconocida" }, 400);
  } catch (err) {
    console.error("lk_alertas error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
