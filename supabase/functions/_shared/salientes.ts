// Centro de mensajes › Salientes (rediseño etapa 4, Pablo 28/09): qué salió del número y qué quedó en la cola.
//
// Dos fuentes, porque miden cosas distintas:
//   · wa_message_status → lo que Meta dice que salió del número (sent/delivered/read/failed), de CUALQUIER
//     origen: el bot, otros sistemas que usan el mismo número y personas desde la app.
//   · wa_outbox → los avisos del bot: encolados, enviados, fallidos y retenidos por la llave.
// El bot no guarda el wamid de lo que manda, así que "salió del bot" es APROXIMADO: mismo teléfono y ±3 min
// que un envío de la cola o una respuesta del bot (bot_historial_chat).
// Sólo lectura. Lo llama lk_conversaciones {action:"salientes", dias}.
import { supabase } from "./supabase.ts";
import { ERRORES_META } from "./errores-meta.ts";

const TZ = "America/Argentina/Buenos_Aires";
const VENTANA_MS = 3 * 60 * 1000;
// Tarifa por mensaje entregado (USD, Argentina). Se pisa con app_settings.wa_tarifas = {"utility":…, "marketing":…}.
const TARIFAS_DEF: Record<string, number> = { utility: 0.026, marketing: 0.0618, authentication: 0.026, service: 0 };

const diaAR = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const ult10 = (p: unknown) => String(p ?? "").replace(/\D/g, "").slice(-10);

// deno-lint-ignore no-explicit-any
async function todo(q: () => any, max = 20000): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (let desde = 0; desde < max; desde += 1000) {
    const { data, error } = await q().range(desde, desde + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function salientes(dias: number) {
  const n = Math.min(30, Math.max(1, Math.round(dias) || 7));
  const hoy = diaAR(new Date().toISOString());
  const desdeDia = diaAR(new Date(Date.now() - (n - 1) * 86400000).toISOString());
  const desdeIso = new Date(Date.now() - (n + 1) * 86400000).toISOString(); // margen; se filtra por día AR

  const { data: tRow } = await supabase.from("app_settings").select("value").eq("key", "wa_tarifas").maybeSingle();
  let tarifas = { ...TARIFAS_DEF };
  try { if (tRow?.value) tarifas = { ...tarifas, ...JSON.parse(tRow.value) }; } catch { /* default */ }

  const [estados, cola, botResp, entrantes] = await Promise.all([
    todo(() => supabase.from("wa_message_status").select("wamid, status, pricing_category, errors, ts, recipient_id")
      .gte("ts", desdeIso).order("ts", { ascending: true })),
    todo(() => supabase.from("wa_outbox").select("phone, template_name, context, status, created_at, sent_at, error")
      .gte("created_at", desdeIso).order("created_at", { ascending: true })),
    todo(() => supabase.from("bot_historial_chat").select("telefono, creado_en").eq("rol", "assistant")
      .gte("creado_en", desdeIso)),
    todo(() => supabase.from("wa_conversations").select("phone, created_at").eq("direction", "in")
      .gte("created_at", desdeIso)),
  ]);

  // Momentos en que el bot mandó algo, por teléfono (para atribuir el origen).
  const botPorTel = new Map<string, number[]>();
  const marcar = (tel: unknown, iso: string | null) => {
    if (!iso) return;
    const k = ult10(tel);
    if (!k) return;
    if (!botPorTel.has(k)) botPorTel.set(k, []);
    botPorTel.get(k)!.push(new Date(iso).getTime());
  };
  for (const o of cola) if (o.status === "sent") marcar(o.phone, o.sent_at);
  for (const r of botResp) marcar(r.telefono, r.creado_en);
  const esDelBot = (tel: string, t: number) => (botPorTel.get(ult10(tel)) ?? []).some((x) => Math.abs(x - t) <= VENTANA_MS);

  const entrPorTel = new Map<string, number[]>();
  for (const e of entrantes) {
    const k = ult10(e.phone);
    if (!entrPorTel.has(k)) entrPorTel.set(k, []);
    entrPorTel.get(k)!.push(new Date(e.created_at).getTime());
  }

  // Un mensaje = un wamid; se queda con su mejor estado y el momento en que salió.
  type Msg = { t: number; tel: string; cat: string; entregado: boolean; leido: boolean; fallido: boolean; error?: { code?: number; title?: string; message?: string } };
  const msgs = new Map<string, Msg>();
  for (const s of estados) {
    if (!s.wamid) continue;
    const t = new Date(s.ts).getTime();
    const m = msgs.get(s.wamid) ?? { t, tel: String(s.recipient_id ?? ""), cat: "", entregado: false, leido: false, fallido: false };
    m.t = Math.min(m.t, t);
    if (s.pricing_category) m.cat = s.pricing_category;
    if (s.status === "delivered") m.entregado = true;
    if (s.status === "read") { m.entregado = true; m.leido = true; }
    if (s.status === "failed") { m.fallido = true; m.error = Array.isArray(s.errors) ? s.errors[0] : s.errors; }
    msgs.set(s.wamid, m);
  }

  const vacioDia = () => ({ salieron: 0, bot: 0, otros: 0, utility: 0, marketing: 0, service: 0, entregados: 0, leidos: 0, fallidos: 0, retenidos: 0, costo: 0 });
  const porDia: Record<string, ReturnType<typeof vacioDia>> = {};
  for (let i = n - 1; i >= 0; i--) porDia[diaAR(new Date(Date.now() - i * 86400000).toISOString())] = vacioDia();
  const motivos = new Map<string, { texto: string; cant: number }>();
  const resp: Record<string, { enviados: number; respondidos: number }> = {};
  let total = { ...vacioDia(), respondidos: 0, cobrables: 0 };

  for (const m of msgs.values()) {
    const dia = diaAR(new Date(m.t).toISOString());
    const d = porDia[dia];
    if (!d) continue;
    const bot = esDelBot(m.tel, m.t);
    const cat = m.cat || (m.fallido ? "" : "service");
    const costo = m.entregado ? (tarifas[cat] ?? 0) : 0;
    for (const x of [d, total] as Record<string, number>[]) {
      x.salieron++; x[bot ? "bot" : "otros"]++;
      if (cat === "utility" || cat === "marketing" || cat === "service") x[cat]++;
      if (m.entregado) x.entregados++;
      if (m.leido) x.leidos++;
      if (m.fallido) x.fallidos++;
      x.costo += costo;
    }
    if (m.fallido) {
      const code = Number(m.error?.code ?? 0);
      const k = String(code || "sin código");
      const texto = ERRORES_META[code] ?? String(m.error?.message ?? m.error?.title ?? "Sin detalle de Meta");
      const cur = motivos.get(k) ?? { texto, cant: 0 };
      cur.cant++;
      motivos.set(k, cur);
    }
    // Respuesta: el cliente escribió dentro de las 24 h siguientes a un aviso (plantilla) entregado.
    if ((cat === "utility" || cat === "marketing") && m.entregado) {
      const r = (resp[cat] ??= { enviados: 0, respondidos: 0 });
      r.enviados++; total.cobrables++;
      if ((entrPorTel.get(ult10(m.tel)) ?? []).some((x) => x > m.t && x - m.t <= 86400000)) { r.respondidos++; total.respondidos++; }
    }
  }

  // Avisos del bot por tipo (cola): encolados, enviados, fallidos, retenidos por la llave.
  const tipos = new Map<string, { encolados: number; enviados: number; fallidos: number; retenidos: number; pendientes: number }>();
  for (const o of cola) {
    const dia = diaAR(o.created_at);
    if (dia < desdeDia) continue;
    const k = o.template_name || o.context || "texto";
    const c = tipos.get(k) ?? { encolados: 0, enviados: 0, fallidos: 0, retenidos: 0, pendientes: 0 };
    c.encolados++;
    const st = String(o.status ?? "");
    if (st === "sent") c.enviados++;
    else if (st === "failed") c.fallidos++;
    else if (st.startsWith("held")) { c.retenidos++; if (porDia[dia]) porDia[dia].retenidos++; total.retenidos++; }
    else c.pendientes++;
    tipos.set(k, c);
  }

  const { data: cambios } = await supabase.from("wa_llave_cambios").select("modo_anterior, modo_nuevo, usuario, creado_en")
    .gte("creado_en", desdeIso).order("creado_en", { ascending: true });

  return {
    ok: true, dias: n, desde: desdeDia, hasta: hoy, tarifas,
    total: { ...total, costo: Math.round(total.costo * 100) / 100 },
    por_dia: Object.entries(porDia).map(([dia, v]) => ({ dia, ...v, costo: Math.round(v.costo * 100) / 100 })),
    por_tipo: [...tipos.entries()].map(([tipo, v]) => ({ tipo, ...v })).sort((a, b) => b.encolados - a.encolados),
    fallidos_por_motivo: [...motivos.entries()].map(([codigo, v]) => ({ codigo, ...v })).sort((a, b) => b.cant - a.cant),
    respuesta: Object.entries(resp).map(([categoria, v]) => ({ categoria, ...v })),
    cambios_llave: cambios ?? [],
  };
}
