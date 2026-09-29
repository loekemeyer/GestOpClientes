// Pedido que llega como archivo (Excel, CSV, foto o PDF) — Pablo, 29/09 ("la IA lee el archivo").
//
// 1. lk_whatsapp-webhook guarda el adjunto (como siempre) y llama leerPedidoArchivo: la IA (Haiku) arma la lista de
//    artículos y cantidades; resolverArticulos la cruza con el catálogo (código exacto o búsqueda) y pasa unidades a cajas.
// 2. El bot le contesta al cliente con la lista y le pide "sí" o qué cambiar (textoConfirmacion).
// 3. La tarea (wa_alertas_humano, motivo pedido_archivo) se crea EN EL MOMENTO con la lista y el archivo: si el cliente
//    no contesta, el pedido no se pierde. Cuando contesta, respuestaPedidoArchivo marca la tarea confirmada o anota los
//    cambios que pidió. Ventas lo carga en la web desde Tareas.

import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { supabase } from "./supabase.ts";

const MODELO = "claude-haiku-4-5-20251001";
const TARIFA = { input: 1.0, output: 5.0 };   // US$ por millón de tokens
const MAX_LINEAS = 120;

export interface LineaLeida { cod: string | null; descripcion: string; cantidad: number; unidad: "cajas" | "unidades" | null }
export interface ArticuloPedido {
  original: string; cod: string | null; descripcion: string | null; product_id: string | null;
  cajas: number | null; uxb: number | null; estado: "ok" | "dudoso" | "no_encontrado"; nota?: string;
}

export function esArchivoDePedido(mime: string, nombre?: string | null): boolean {
  return /spreadsheet|ms-excel|csv|^image\/|pdf/i.test(mime) || /\.(xlsx?|csv)$/i.test(nombre ?? "");
}

const SISTEMA = `Leés pedidos de clientes mayoristas de Loekemeyer (artículos de cocina y bazar). Del archivo o la foto,
sacá cada línea de pedido: código de artículo si aparece (ej. "501", "323E", "404E"), la descripción tal cual y la cantidad.
Si dice cajas, bultos o cj → unidad "cajas"; si dice unidades, u o piezas → "unidades"; si no se sabe → null.
No inventes líneas: si algo no se lee, no lo pongas. Ignorá totales, precios, encabezados y firmas.
Respondé SOLO JSON: {"lineas":[{"cod":"501"|null,"descripcion":"...","cantidad":3,"unidad":"cajas"|"unidades"|null}]}`;

/** Lee el archivo con la IA. Devuelve las líneas o un error (el llamador sigue con la tarea igual). */
export async function leerPedidoArchivo(bytes: Uint8Array, mime: string, apiKey: string, phone: string | null,
  nombre?: string | null): Promise<{ lineas: LineaLeida[]; error?: string }> {
  // deno-lint-ignore no-explicit-any
  let content: any[];
  const m = mime.toLowerCase();
  if (/spreadsheet|ms-excel|csv/.test(m) || /\.(xlsx?|csv)$/i.test(nombre ?? "")) {
    const libro = XLSX.read(bytes, { type: "array" });
    const texto = libro.SheetNames.slice(0, 3).map((h) => `# Hoja ${h}\n` + XLSX.utils.sheet_to_csv(libro.Sheets[h], { FS: ";" }))
      .join("\n").split("\n").filter((l: string) => l.replace(/[;\s]/g, "")).slice(0, 400).join("\n").slice(0, 30000);
    content = [{ type: "text", text: `Planilla del cliente (CSV, separador ;):\n${texto}` }];
  } else {
    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const b64 = btoa(bin);
    content = m.includes("pdf")
      ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }]
      : [{ type: "image", source: { type: "base64", media_type: m.startsWith("image/") ? m : "image/jpeg", data: b64 } }];
    content.push({ type: "text", text: "Este es el pedido que mandó el cliente." });
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELO, max_tokens: 4000, temperature: 0, system: SISTEMA, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) return { lineas: [], error: `IA ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const r = await res.json();
  const it = Number(r?.usage?.input_tokens ?? 0), ot = Number(r?.usage?.output_tokens ?? 0);
  supabase.from("bot_token_usage").insert({
    model: MODELO, input_tokens: it, output_tokens: ot, function_name: "lk_whatsapp-webhook", phone, motivo: "pedido_archivo",
    estimated_cost_usd: (it * TARIFA.input + ot * TARIFA.output) / 1_000_000,
  }).then(() => {}, (e: unknown) => console.error("[pedido-archivo] log de uso:", e));
  const txt = String(r?.content?.[0]?.text ?? "");
  const j = txt.match(/\{[\s\S]*\}/);
  if (!j) return { lineas: [], error: "la IA no devolvió JSON" };
  try {
    // deno-lint-ignore no-explicit-any
    const lineas = (JSON.parse(j[0]).lineas ?? []).map((l: any) => ({
      cod: l?.cod ? String(l.cod).trim().toUpperCase() : null, descripcion: String(l?.descripcion ?? "").trim().slice(0, 120),
      cantidad: Number(l?.cantidad) || 0, unidad: l?.unidad === "cajas" || l?.unidad === "unidades" ? l.unidad : null,
    })).filter((l: LineaLeida) => l.cantidad > 0 && (l.cod || l.descripcion)).slice(0, MAX_LINEAS);
    return { lineas };
  } catch { return { lineas: [], error: "JSON inválido" }; }
}

// deno-lint-ignore no-explicit-any
type Prod = { id: string; cod: string; description: string; uxb: number };

/** Candidatos del catálogo para una descripción libre: la frase entera y cada palabra de 4+ letras (así "colador de
 *  fideos grande" encuentra "Colador de Pasta"). Hasta 12, sin repetir. */
async function candidatos(desc: string): Promise<Prod[]> {
  const consultas = [desc, ...desc.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w.length >= 4).map((w) => w.replace(/(es|s)$/, ""))];
  const cods: string[] = [];
  for (const q of consultas.slice(0, 5)) {
    const { data } = await supabase.rpc("bot_buscar_productos", { p_query: q, p_limit: 6 });
    // deno-lint-ignore no-explicit-any
    for (const r of (data ?? []) as any[]) if (!cods.includes(r.cod)) cods.push(r.cod);
    if (cods.length >= 12) break;
  }
  if (!cods.length) return [];
  const { data: ps } = await supabase.from("products").select("id, cod, description, uxb").in("cod", cods.slice(0, 12)).eq("active", true);
  return (ps ?? []) as Prod[];
}

/** La IA elige, para cada línea sin código, el artículo de sus candidatos (o ninguno). Una sola llamada para todas. */
async function elegirConIA(items: Array<{ i: number; desc: string; cands: Prod[] }>, apiKey: string, phone: string | null):
  Promise<Record<number, { cod: string | null; seguro: boolean }>> {
  if (!items.length || !apiKey) return {};
  const prompt = items.map((x) => `Línea ${x.i}: "${x.desc}"\nCandidatos: ${x.cands.map((c) => `${c.cod} = ${c.description.trim()}`).join(" | ") || "(ninguno)"}`).join("\n\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELO, max_tokens: 1500, temperature: 0,
      system: "Para cada línea de pedido de un bazar mayorista, elegí el código del candidato que corresponde al artículo pedido, o null si ninguno corresponde. seguro=true sólo si no hay duda (ej. \"colador de fideos\" = \"Colador de Pasta\"; \"sacacorchos mariposa\" = \"Sacacorcho Doble Aleta\"). Respondé SOLO JSON {\"elecciones\":[{\"linea\":0,\"cod\":\"441\"|null,\"seguro\":true}]}",
      messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return {};
  const r = await res.json();
  const it = Number(r?.usage?.input_tokens ?? 0), ot = Number(r?.usage?.output_tokens ?? 0);
  supabase.from("bot_token_usage").insert({ model: MODELO, input_tokens: it, output_tokens: ot, function_name: "lk_whatsapp-webhook", phone,
    motivo: "pedido_archivo", estimated_cost_usd: (it * TARIFA.input + ot * TARIFA.output) / 1_000_000 }).then(() => {}, () => {});
  const j = String(r?.content?.[0]?.text ?? "").match(/\{[\s\S]*\}/);
  const out: Record<number, { cod: string | null; seguro: boolean }> = {};
  // deno-lint-ignore no-explicit-any
  try { for (const e of (JSON.parse(j?.[0] ?? "{}").elecciones ?? []) as any[]) out[Number(e.linea)] = { cod: e.cod ? String(e.cod) : null, seguro: e.seguro === true }; } catch { /* sin elección */ }
  return out;
}

/** Cruza cada línea con el catálogo: código exacto primero; si no hay código, candidatos + elección de la IA.
 *  Unidades → cajas con el uxb. */
export async function resolverArticulos(lineas: LineaLeida[], apiKey = "", phone: string | null = null): Promise<ArticuloPedido[]> {
  const prods: Array<Prod | null> = [];
  const dudas: boolean[] = [];
  const porElegir: Array<{ i: number; desc: string; cands: Prod[] }> = [];
  for (const [i, l] of lineas.entries()) {
    let p: Prod | null = null;
    if (l.cod) {
      const canon = /^\d+$/.test(l.cod) ? l.cod.replace(/^0+(?=.)/, "").padStart(3, "0") : l.cod;
      const { data } = await supabase.from("products").select("id, cod, description, uxb").in("cod", [l.cod, canon]).eq("active", true).limit(1);
      p = (data?.[0] as Prod) ?? null;
    }
    prods.push(p); dudas.push(false);
    if (!p && l.descripcion) porElegir.push({ i, desc: l.descripcion, cands: await candidatos(l.descripcion) });
  }
  const elecciones = await elegirConIA(porElegir.filter((x) => x.cands.length), apiKey, phone);
  for (const x of porElegir) {
    const e = elecciones[x.i];
    const c = e?.cod ? x.cands.find((c) => c.cod === e.cod) : null;
    if (c) { prods[x.i] = c; dudas[x.i] = !e.seguro; }
  }
  return lineas.map((l, i) => {
    const original = `${l.cod ? l.cod + " " : ""}${l.descripcion} × ${l.cantidad}${l.unidad ? " " + l.unidad : ""}`.replace(/\s+/g, " ").trim();
    const p = prods[i];
    if (!p) return { original, cod: l.cod, descripcion: null, product_id: null, cajas: null, uxb: null, estado: "no_encontrado" as const };
    const uxb = Number(p.uxb) || 1;
    let cajas = l.cantidad, nota: string | undefined, dudoso = dudas[i];
    if (l.unidad === "unidades") {
      cajas = Math.ceil(l.cantidad / uxb);
      if (l.cantidad % uxb) { dudoso = true; nota = `pidió ${l.cantidad} unidades; la caja trae ${uxb}`; }
    } else if (l.unidad === null && uxb > 1 && l.cantidad >= uxb && l.cantidad % uxb === 0) {
      dudoso = true; nota = `¿${l.cantidad} cajas o ${l.cantidad} unidades (${l.cantidad / uxb} cajas)?`;
    }
    return { original, cod: p.cod, descripcion: p.description.trim(), product_id: p.id, cajas, uxb, estado: dudoso ? "dudoso" as const : "ok" as const, ...(nota ? { nota } : {}) };
  });
}

const cj = (n: number | null) => `${n} ${n === 1 ? "caja" : "cajas"}`;

/** Mensaje al cliente con lo que se leyó. */
export function textoConfirmacion(arts: ArticuloPedido[]): string {
  const ok = arts.filter((a) => a.estado !== "no_encontrado");
  const no = arts.filter((a) => a.estado === "no_encontrado");
  const lineas = ok.slice(0, 40).map((a) => `• ${cj(a.cajas)} de ${a.descripcion} (cód. ${a.cod})${a.estado === "dudoso" ? " ❓" : ""}`);
  let t = `Recibimos tu pedido. Leímos esto:\n${lineas.join("\n")}`;
  if (ok.length > 40) t += `\n… y ${ok.length - 40} artículos más.`;
  if (no.length) t += `\n\nNo encontramos: ${no.slice(0, 10).map((a) => `"${a.original}"`).join(", ")}.`;
  if (arts.some((a) => a.estado === "dudoso")) t += `\n❓ = revisalo, no estamos seguros del artículo o la cantidad.`;
  return t + `\n\n¿Está bien? Respondé *sí* y una persona lo carga, o decinos qué cambiar.`;
}

const RE_SI = /^\s*(s[ií]|si+|dale|ok|okey|correcto|est[aá] bien|perfecto|confirmo|as[ií] est[aá] bien|todo bien)\b[\s!.👍✅]*$/i;

/** Si el cliente está contestando la lista de un pedido por archivo (últimas 24 h), actualiza la tarea y devuelve la
 *  respuesta. Si no, null (sigue el flujo normal). */
export async function respuestaPedidoArchivo(phone: string, text: string): Promise<string | null> {
  const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: t } = await supabase.from("wa_alertas_humano").select("id, contexto, estado")
    .eq("phone", phone).eq("contexto->>motivo", "pedido_archivo").in("estado", ["pendiente", "notificado"])
    .gte("created_at", desde).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!t || t.contexto?.respuesta_cliente) return null;
  const si = RE_SI.test(text);
  await supabase.from("wa_alertas_humano").update({
    contexto: { ...t.contexto, respuesta_cliente: si ? "confirmado" : "cambios", cambios: si ? null : text.slice(0, 1000),
      respondido_at: new Date().toISOString() },
  }).eq("id", t.id);
  return si ? "¡Gracias! Una persona lo carga en la web y te confirmamos por acá. 🙌"
    : "Anotado. Una persona revisa el pedido con tus cambios y te escribe por acá. 🙌";
}
