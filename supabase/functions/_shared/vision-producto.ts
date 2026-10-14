// _shared/vision-producto.ts — Reconocimiento de producto por foto del cliente (Pablo, 14/10/2026, Fase A).
//
// Cuando un cliente manda una foto que no es reclamo ni comprobante de pago, se le pasa a un modelo con
// visión para saber QUÉ es: si está dañado va a reclamo (lo maneja el webhook); si es un producto, se
// devuelven 2-5 palabras para buscarlo con buscar_productos y ofrecerle opciones con sus fotos.
//
// Encapsula la llamada de visión acá para NO tocar el núcleo del agente (bot-llm no arma content con
// imágenes). El modelo lo fija app_settings.wa_vision_modelo (propio, NO el llm_modelo_pruebas que flipean los
// testers: el webhook nunca lee esa llave). Sin wa_vision_modelo seteado la visión queda DORMIDA (devuelve
// sin_vision y el webhook sigue con el flujo de siempre): así prenderla es un switch explícito y auditable.
// Sólo proveedor Google por ahora (Gemini free = US$0). Falla silenciosa: ante cualquier problema, sin_vision.

import { partesGoogle, resolveModelById } from "./bot-llm.ts";
import { getSetting } from "./supabase.ts";

const PROMPT =
  "Sos asistente de un mayorista de bazar y cocina. Un cliente mandó esta foto por WhatsApp.\n" +
  "- Si es una LISTA o NOTA escrita con varios productos (un pedido), respondé exactamente: LISTA\n" +
  "- Si es UN producto y está roto, partido, abollado o dañado, respondé exactamente: DANIADO\n" +
  "- Si es UN producto en buen estado, describí QUÉ es en 2 a 5 palabras, pensado para buscarlo en un " +
  "catálogo (ej: pelador de papas, cuchillo de cocina, olla de aluminio, tabla de madera).\n" +
  "Respondé sólo eso, sin saludar ni explicar.";

export type VisionResultado =
  | { tipo: "danado" }
  | { tipo: "lista" }
  | { tipo: "busqueda"; terminos: string }
  | { tipo: "sin_vision" };

/** Base64 de un Uint8Array sin dependencias (btoa por chunks, para no reventar el stack con fotos grandes). */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Mira la foto del cliente. Sólo JPEG/PNG/WebP. Nunca tira: ante cualquier problema devuelve sin_vision. */
export async function describirFotoProducto(bytes: Uint8Array, mime: string): Promise<VisionResultado> {
  try {
    const m0 = (mime || "").toLowerCase().split(";")[0].trim();
    if (!/^image\/(jpe?g|png|webp)$/.test(m0)) return { tipo: "sin_vision" };
    if (!bytes?.length || bytes.length > 5 * 1024 * 1024) return { tipo: "sin_vision" };

    const modeloId = ((await getSetting("wa_vision_modelo")) || "").split(",")[0].trim();
    if (!modeloId) return { tipo: "sin_vision" }; // visión dormida hasta que se setee wa_vision_modelo
    const modelo = await resolveModelById(modeloId);
    if (!modelo || modelo.provider !== "google") return { tipo: "sin_vision" }; // por ahora sólo Gemini

    const body = {
      contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType: m0, data: toBase64(bytes) } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 40 },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo.model)}:generateContent?key=${encodeURIComponent(modelo.key)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    if (!res.ok) {
      console.warn("[vision-producto] HTTP", res.status, (await res.text()).slice(0, 200));
      return { tipo: "sin_vision" };
    }
    const d = await res.json();
    // deno-lint-ignore no-explicit-any
    const { text } = partesGoogle((d as any).candidates?.[0]?.content?.parts ?? []);
    const t = String(text ?? "").trim();
    if (!t) return { tipo: "sin_vision" };
    const w0 = t.split(/\s+/)[0] ?? "";
    if (/^lista/i.test(w0)) return { tipo: "lista" };
    if (/dani?ado|dañado/i.test(w0)) return { tipo: "danado" };
    // Limpia a términos de búsqueda simples (sin signos raros), tope 80 chars.
    const terminos = t.replace(/["'`*_#]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    return terminos ? { tipo: "busqueda", terminos } : { tipo: "sin_vision" };
  } catch (e) {
    console.warn("[vision-producto]", e instanceof Error ? e.message : e);
    return { tipo: "sin_vision" };
  }
}
