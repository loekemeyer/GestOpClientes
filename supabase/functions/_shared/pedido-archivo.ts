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

/** Cruza cada línea con el catálogo: código exacto primero, si no la búsqueda del bot. Unidades → cajas con el uxb. */
export async function resolverArticulos(lineas: LineaLeida[]): Promise<ArticuloPedido[]> {
  const out: ArticuloPedido[] = [];
  for (const l of lineas) {
    const original = `${l.cod ? l.cod + " " : ""}${l.descripcion} × ${l.cantidad}${l.unidad ? " " + l.unidad : ""}`.trim();
    // deno-lint-ignore no-explicit-any
    let p: any = null, dudoso = false;
    if (l.cod) {
      const canon = /^\d+$/.test(l.cod) ? l.cod.replace(/^0+(?=.)/, "").padStart(3, "0") : l.cod;
      const { data } = await supabase.from("products").select("id, cod, description, uxb").in("cod", [l.cod, canon]).eq("active", true).limit(1);
      p = data?.[0] ?? null;
    }
    if (!p && l.descripcion) {
      const { data } = await supabase.rpc("bot_buscar_productos", { p_query: l.descripcion, p_limit: 3 });
      if (data?.length) {
        const { data: pr } = await supabase.from("products").select("id, cod, description, uxb").eq("cod", data[0].cod).limit(1);
        p = pr?.[0] ?? null; dudoso = data.length > 1;
      }
    }
    if (!p) { out.push({ original, cod: l.cod, descripcion: null, product_id: null, cajas: null, uxb: null, estado: "no_encontrado" }); continue; }
    const uxb = Number(p.uxb) || 1;
    let cajas = l.cantidad, nota: string | undefined;
    if (l.unidad === "unidades") {
      cajas = Math.ceil(l.cantidad / uxb);
      if (l.cantidad % uxb) { dudoso = true; nota = `pidió ${l.cantidad} unidades; la caja trae ${uxb}`; }
    } else if (l.unidad === null && l.cantidad >= uxb && l.cantidad % uxb === 0 && uxb > 1) {
      // "24 abrelatas" con caja de 12: probablemente unidades → se deja en cajas pero se marca para mirar.
      dudoso = true; nota = `¿${l.cantidad} cajas o ${l.cantidad} unidades (${l.cantidad / uxb} cajas)?`;
    }
    out.push({ original, cod: p.cod, descripcion: p.description, product_id: p.id, cajas, uxb, estado: dudoso ? "dudoso" : "ok", ...(nota ? { nota } : {}) });
  }
  return out;
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
