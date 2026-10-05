// lk_recordatorio-descuento — recordatorio de descuento por vencer (Pablo, 30/09, con el OK de Thomy).
//
// 2 días hábiles antes de que venza CADA escalón de descuento por pago (factura + 14 / 30 / 45 / 60 días corridos, al
// hábil: misma cuenta que la FAQ de descuentos y el WhatsApp de la factura), si la factura sigue con saldo en
// GV_Cobranza_Deuda_Viva (Gestión), encola la plantilla `pedido_recordatorio_descuento` en wa_outbox. No le habla a Meta:
// lo manda lk_outbox-flush, que pasa por la llave `wa_envio_automatico` (vasectomía: en 'prueba' sólo sale a Thomy).
//
// Se saltea: e-cheq (el descuento es fijo por el plazo del cheque), "NN FF" y "Sin Cotizador" (sin descuento por pago),
// clientes sin WhatsApp en bot_customer_whatsapps y clientes que PAGARON después de la última carga de saldos.
//
// Pago reciente (Pablo, 05/10): GV_Cobranza_Deuda_Viva se rearma de noche y sólo cuando entra una carga nueva (columna
// `ancla` = cuándo se armó ese saldo). Un pago registrado en Gestión después (gv_cobranza_recibos, empresa lk) no está en el
// saldo, y el aviso diría "pagá hasta el … con 25 %" por una factura que ya pagó. Si el cliente tiene un recibo con fecha de
// pago entre el día de esa carga y hoy, no se le avisa (estado `omitido_pago_reciente`). Sólo SACA avisos, nunca agrega.
// Si no se pueden leer los recibos no se encola nada (mejor un día sin recordatorio que avisarle a quien ya pagó). Varias facturas del mismo día y condición = un solo aviso.
// Un aviso por (cliente, fecha, condición, escalón): wa_outbox.context='recordatorio_dto' + ref_id.
// "Faltan 2 hábiles" = el vencimiento cae entre el próximo hábil y el siguiente (si un día no corrió, recupera).
//
// Reemplaza a bot_encolar_recordatorios_25 (cron bot-recordatorio-25): usaba la fecha de salida + 14, una tabla que
// dejó de cargarse el 01/09, una plantilla que no existe en Meta y el teléfono de Thomy fijo.
//
// Body: { aplicar?: boolean (default false = simulacro, devuelve el plan), hoy?: "YYYY-MM-DD" (para probar) }.
// Sólo llamada interna (x-lk-secret = LK_FN_CRON_SECRET).
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getGestionClient, supabase } from "../_shared/supabase.ts";
import { leerVersiones, nombreActivo } from "../_shared/plantillas-version.ts";
import { fechaAR } from "../_shared/aviso-pedido.ts";
import { pagoPosterior, type ReciboMin } from "../_shared/recordatorio-pagos.ts";

const TPL = "pedido_recordatorio_descuento";
const CONTEXTO = "recordatorio_dto";
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
async function esLlamadaInterna(req: Request): Promise<boolean> {
  const recibido = req.headers.get("x-lk-secret") ?? "";
  if (!recibido) return false;
  let esperado = Deno.env.get("LK_FN_CRON_SECRET") ?? "";
  if (!esperado) {
    const { data } = await supabase.rpc("krikos_secret", { p_name: "LK_FN_CRON_SECRET" });
    esperado = typeof data === "string" ? data : "";
  }
  return esperado.length > 0 && recibido === esperado;
}

const sumar = (iso: string, dias: number) => {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10);
};
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const conDia = (iso: string) => `${DIAS[new Date(iso + "T12:00:00Z").getUTCDay()]} ${ddmm(iso)}`;
const pesos = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");
const ultimoNum = (s: unknown) => Math.max(0, ...(String(s ?? "").match(/\d+/g) ?? []).map(Number));

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST" }, 405);
  if (!(await esLlamadaInterna(req))) return json({ ok: false, error: "no autorizado" }, 401);
  const body = await req.json().catch(() => ({})) as { aplicar?: boolean; hoy?: string };
  const aplicar = body.aplicar === true;

  const cache = new Map<string, string>();
  const habil = async (iso: string) => {
    if (!cache.has(iso)) {
      const { data } = await supabase.rpc("wa_proximo_habil", { p: iso });
      cache.set(iso, typeof data === "string" ? data.slice(0, 10) : iso);
    }
    return cache.get(iso)!;
  };
  const hoy = body.hoy ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  // Sólo en días hábiles: el aviso de un vencimiento del martes sale el jueves anterior, no el sábado.
  if ((await habil(hoy)) !== hoy) return json({ ok: true, hoy, habil: false, encolados: 0 });
  const d1 = await habil(sumar(hoy, 1));
  const d2 = await habil(sumar(d1, 1));

  // Escalones y datos de pago: la tabla del Panel (wa_descuentos_config), la misma que la FAQ y la factura.
  const { data: cfgRow } = await supabase.from("app_settings").select("value").eq("key", "wa_descuentos_config").maybeSingle();
  // deno-lint-ignore no-explicit-any
  const cfg: any = JSON.parse(String(cfgRow?.value ?? "{}"));
  const escalones: Array<{ dias: number; dto: number }> = [];
  if (cfg?.contado) escalones.push({ dias: Number(cfg.contado.dias_limite) || 14, dto: Number(cfg.contado.dto) || 0 });
  for (const r of (cfg?.credito ?? [])) if (ultimoNum(r?.label)) escalones.push({ dias: ultimoNum(r.label), dto: Number(r.dto) || 0 });
  escalones.sort((a, b) => a.dias - b.dias);
  if (!escalones.length) return json({ ok: false, error: "sin escalones en wa_descuentos_config" });
  const alias = cfg?.pago?.alias ?? "loeke.srl", cbu = cfg?.pago?.cbu ?? "1910027855002702387450";
  const maxDias = escalones[escalones.length - 1].dias;

  // Facturas con saldo, sólo las que todavía pueden tener un escalón por vencer.
  const g = await getGestionClient("public");
  const { data: filas, error } = await g.from("GV_Cobranza_Deuda_Viva")
    .select("cod_cliente, fecha, condicion, pendiente, ancla")
    .eq("empresa", "lk").gt("pendiente", 0).like("comprobante", "FC%")
    .gte("fecha", sumar(hoy, -(maxDias + 10)));
  if (error) return json({ ok: false, error: `Deuda Viva: ${error.message}` });

  // `carga`: día (hora de Argentina) en que se armó el saldo de este grupo; sin dato, hoy − 3 (cubre un fin de semana).
  type Grupo = { cod: string; fecha: string; condicion: string; saldo: number; carga: string };
  const grupos = new Map<string, Grupo>();
  const sinCarga = sumar(hoy, -3);
  for (const f of (filas ?? []) as Array<{ cod_cliente: string; fecha: string; condicion: string | null; pendiente: number; ancla: string | null }>) {
    const condicion = String(f.condicion ?? "");
    if (/e-?cheq|\bFF\b|sin cotizador/i.test(condicion)) continue;
    const fecha = String(f.fecha).slice(0, 10);
    const k = `${f.cod_cliente}|${fecha}|${condicion}`;
    const carga = fechaAR(f.ancla) || sinCarga;
    const gr = grupos.get(k);
    if (gr) { gr.saldo += Number(f.pendiente); if (carga < gr.carga) gr.carga = carga; }
    else grupos.set(k, { cod: String(f.cod_cliente), fecha, condicion, saldo: Number(f.pendiente), carga });
  }

  // Qué escalón vence en la ventana (d1, d2].
  const avisos: Array<Grupo & { dias: number; hasta: string; dto: number; dtoDespues: number; ref: string }> = [];
  for (const gr of grupos.values()) {
    for (let i = 0; i < escalones.length; i++) {
      const e = escalones[i];
      const hasta = await habil(sumar(gr.fecha, e.dias));
      if (hasta < d1 || hasta > d2) continue;
      avisos.push({ ...gr, dias: e.dias, hasta, dto: e.dto, dtoDespues: escalones[i + 1]?.dto ?? 0,
        ref: `${gr.cod}|${gr.fecha}|${gr.condicion}|${e.dias}` });
    }
  }
  if (!avisos.length) return json({ ok: true, hoy, ventana: [d1, d2], grupos: grupos.size, avisos: 0, encolados: 0 });

  // Teléfono: el principal de bot_customer_whatsapps (mismo criterio que los otros avisos).
  const cods = [...new Set(avisos.map((a) => Number(a.cod)).filter(Number.isFinite))];

  // Pagos posteriores a la carga de saldos. Se piden desde la carga más vieja de los avisos; cada aviso se compara con la suya.
  const desdeMin = avisos.reduce((m, a) => (a.carga < m ? a.carga : m), hoy);
  const sinCeros = (s: string) => s.trim().replace(/^0+/, "");
  const codsRecibo = [...new Set(avisos.flatMap((a) => [a.cod, sinCeros(a.cod)]))];
  const { data: recs, error: errRec } = await g.from("gv_cobranza_recibos")
    .select("cod_cliente, fecha_pago, pagado").eq("empresa", "lk").in("cod_cliente", codsRecibo)
    .gte("fecha_pago", desdeMin).lte("fecha_pago", hoy);
  if (errRec) return json({ ok: false, hoy, error: `Recibos: ${errRec.message}`, encolados: 0 });
  const recibos = (recs ?? []) as ReciboMin[];
  const { data: tels } = await supabase.from("bot_customer_whatsapps")
    .select("cod_cliente, whatsapp, is_primary, created_at").in("cod_cliente", cods).not("whatsapp", "is", null)
    .order("is_primary", { ascending: false }).order("created_at", { ascending: false });
  const telDe = new Map<string, string>();
  for (const t of (tels ?? []) as Array<{ cod_cliente: number; whatsapp: string }>) {
    if (!telDe.has(String(t.cod_cliente))) telDe.set(String(t.cod_cliente), t.whatsapp);
  }
  const { data: ya } = await supabase.from("wa_outbox").select("ref_id").eq("context", CONTEXTO)
    .in("ref_id", avisos.map((a) => a.ref));
  const enviados = new Set((ya ?? []).map((x: { ref_id: string }) => x.ref_id));

  // v1 y v2 de la plantilla tienen 8 variables; desde la v3 (Pablo, 30/09) va "pasás a pagar $X más" antes de alias/CBU.
  const activa = nombreActivo(await leerVersiones(supabase), TPL);
  const conDiferencia = ![TPL, `${TPL}_v2`].includes(activa);
  const plan = [];
  let encolados = 0, omitidosPago = 0;
  for (const a of avisos) {
    const phone = telDe.get(a.cod);
    const pago = pagoPosterior(recibos, a.cod, a.carga, hoy);
    const base = {
      "1": ddmm(a.fecha), "2": conDia(a.hasta), "3": String(Math.round(a.dto * 100)),
      "4": pesos(a.saldo * (1 - a.dto)), "5": pesos(a.saldo), "6": String(Math.round(a.dtoDespues * 100)),
    };
    const params: Record<string, string> = conDiferencia
      ? { ...base, "7": pesos(a.saldo * (a.dto - a.dtoDespues)), "8": alias, "9": cbu }
      : { ...base, "7": alias, "8": cbu };
    const estado = enviados.has(a.ref) ? "ya_encolado" : pago ? "omitido_pago_reciente" : !phone ? "sin_whatsapp" : aplicar ? "encolado" : "encolaría";
    if (estado === "omitido_pago_reciente") omitidosPago++;
    if (estado === "encolado") {
      const { error: e } = await supabase.from("wa_outbox").insert({
        phone, template_name: TPL, template_params: params, context: CONTEXTO, ref_id: a.ref,
      });
      if (e) { plan.push({ ref: a.ref, estado: "error", error: e.message }); continue; }
      encolados++;
    }
    plan.push({ ref: a.ref, cod: a.cod, fecha: a.fecha, escalon_dias: a.dias, vence: a.hasta, estado, params,
      ...(pago ? { carga: a.carga, pago: { fecha: String(pago.fecha_pago).slice(0, 10), pagado: pago.pagado } } : {}) });
  }
  console.log(`lk_recordatorio-descuento hoy=${hoy} ventana=${d1}..${d2} avisos=${avisos.length} encolados=${encolados} omitidos_pago=${omitidosPago} aplicar=${aplicar}`);
  return json({ ok: true, hoy, ventana: [d1, d2], aplicado: aplicar, grupos: grupos.size, avisos: avisos.length, encolados, omitidos_pago: omitidosPago, plan });
});
