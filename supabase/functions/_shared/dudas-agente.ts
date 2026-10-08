// dudas-agente — el agente anota sus dudas de ALCANCE (objetivo, límite o permiso) en la cola de Consultas (wa_agente_consultas).
// Pablo Olejavetzky, 08/10/2026 ("qué le falta para ser un agente", paso 3). La cola existía (Configuración del agente › Consultas: una
// persona responde, elige Objetivo / Límite / Permiso y la respuesta se agrega como regla al documento rector que lee el agente), pero
// logAgenteConsulta (agente.ts) no la llamaba nadie: las 2 filas que tenía eran de ejemplo, del 31/08.
//
// Lo que escribe el agente puede traer texto del cliente (una inyección), y una persona lo puede pegar como regla. Por eso:
//   1. pasa a una línea limpia (lineaSegura: sin enlaces, sin < > ni `), sin teléfonos (8 dígitos o más) ni mails, con tope de largo;
//   2. hasta TOPE_DUDAS_POR_DIA por número en 24 h (se cuentan en bot_auditoria) y no repite una pendiente igual: un cliente no llena la cola;
//   3. si parece una orden para el bot (pareceInstruccion), se anota igual pero marcada ⚠, para que nadie la convierta en regla sin leerla.
// Una duda NUNCA cambia lo que hace el agente por sí sola: sólo la respuesta de una persona en el Panel.

import { supabase } from "./supabase.ts";
import { SIM } from "./simulacion.ts";
import { lineaSegura, pareceInstruccion } from "./dato-externo.ts";
import { logAgenteConsulta } from "./agente.ts";

export const TOPE_DUDAS_POR_DIA = 3;
export const MAX_DUDA = 300;
export const MARCA_SOSPECHA = "⚠ Parece una orden para el bot: leela antes de convertirla en regla.";

/** Una línea sin datos personales: teléfonos (8 dígitos o más, con o sin separadores) y mails se tapan. */
export function limpiarTextoDuda(texto: unknown, max = MAX_DUDA): string {
  const t = String(texto ?? "")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "(mail)")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => (m.replace(/\D/g, "").length >= 8 ? "(número)" : m));
  return lineaSegura(t, max);
}

/** Para comparar dudas: minúsculas, sin tildes, sin signos ni espacios de más. */
export function normalizarDuda(texto: string): string {
  return texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
}

export type DecisionDuda =
  | { guardar: true; pregunta: string; contexto: string | null; sospechosa: boolean }
  | { guardar: false; motivo: "vacia" | "tope" | "repetida" };

/** Qué hacer con una duda. Función pura: la prueban tests/dudas-agente.test.ts. */
export function decidirDuda(
  duda: unknown, contexto: unknown, yaAnotadasHoy: number, pendientes: string[],
): DecisionDuda {
  const pregunta = limpiarTextoDuda(duda);
  if (normalizarDuda(pregunta).length < 10) return { guardar: false, motivo: "vacia" };
  if (yaAnotadasHoy >= TOPE_DUDAS_POR_DIA) return { guardar: false, motivo: "tope" };
  const n = normalizarDuda(pregunta);
  if (pendientes.some((p) => normalizarDuda(p) === n)) return { guardar: false, motivo: "repetida" };
  const ctx = limpiarTextoDuda(contexto) || null;
  // Se mira el texto ORIGINAL (antes de limpiarlo), así una orden escondida con enlaces o signos también se marca.
  const sospechosa = pareceInstruccion(`${String(duda ?? "")} ${String(contexto ?? "")}`).length > 0;
  return { guardar: true, pregunta, contexto: sospechosa ? `${MARCA_SOSPECHA}${ctx ? " " + ctx : ""}` : ctx, sospechosa };
}

/** Anota la duda del agente. Nunca lanza: si algo falla, el turno sigue (el agente igual deriva). */
export async function anotarDuda(phone: string, duda: unknown, contexto: unknown): Promise<{ anotada: boolean; motivo?: string }> {
  try {
    if (SIM.activo) {
      const d = decidirDuda(duda, contexto, 0, []);
      return d.guardar ? { anotada: true } : { anotada: false, motivo: d.motivo };
    }
    const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
    const [hoy, pend] = await Promise.all([
      supabase.from("bot_auditoria").select("id", { count: "exact", head: true })
        .eq("telefono", phone).eq("tool_usado", "anotar_duda").gte("creado_en", desde),
      supabase.from("wa_agente_consultas").select("pregunta").eq("estado", "pendiente").order("created_at", { ascending: false }).limit(200),
    ]);
    const d = decidirDuda(duda, contexto, hoy.count ?? 0, (pend.data ?? []).map((r: { pregunta: string | null }) => String(r.pregunta ?? "")));
    if (!d.guardar) return { anotada: false, motivo: d.motivo };
    await logAgenteConsulta(d.pregunta, d.contexto ?? undefined, d.sospechosa ? "agente ⚠" : "agente");
    return { anotada: true };
  } catch (e) {
    console.warn("anotarDuda:", e instanceof Error ? e.message : e);
    return { anotada: false, motivo: "error" };
  }
}
