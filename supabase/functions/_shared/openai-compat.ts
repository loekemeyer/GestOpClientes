// _shared/openai-compat.ts — proveedores con API compatible con OpenAI (mismo formato de mensajes y tools) y la traducción del
// historial normalizado a ese formato. Lo usa `bot-llm.ts` (callOpenAI).
//
// Pablo Olejavetzky, 08/10/2026: Mistral (plan gratis Experiment) como respaldo de las pruebas fuera de Google, porque Gemini gratis
// falló con timeouts, 503 y 429 (bot_llm_intentos, 07/10: 3.5 Flash-Lite 36,9 % y 3.1 Flash-Lite 69,5 % de llamadas fallidas).
// Mistral habla el formato de OpenAI con una diferencia que rompe el segundo llamado de un turno con herramientas: el id de cada
// tool_call tiene que tener exactamente 9 caracteres alfanuméricos (ver `idToolMistral`).
//
// Módulo puro (sin red ni base). Se prueba en tests/openai-compat.test.ts.

import type { NormMsg } from "./bot-llm.ts";

export const OPENAI_COMPAT: Record<string, { label: string; url: string }> = {
  openai: { label: "OpenAI", url: "https://api.openai.com/v1/chat/completions" },
  groq: { label: "Groq", url: "https://api.groq.com/openai/v1/chat/completions" },
  mistral: { label: "Mistral", url: "https://api.mistral.ai/v1/chat/completions" },
};

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Mistral rechaza con 400 un tool_call_id que no sea `^[a-zA-Z0-9]{9}$` (validador de mistral-common). Gemini no da ids (bot-llm pone
 *  un UUID) y Anthropic manda `toolu_…`: si el turno pasa a Mistral después de que otro modelo pidió una herramienta, el id se traduce.
 *  Siempre al mismo valor para el mismo id, así el pedido de la herramienta y su resultado siguen apareados. Los de Mistral pasan igual. */
export function idToolMistral(id: string): string {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  // FNV-1a de 32 bits con dos semillas: 5 caracteres de base 62 salen de la primera (62^5 < 2^32) y 4 de la segunda.
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  let out = "";
  for (let k = 0; k < 5; k++) { out += BASE62[h1 % 62]; h1 = Math.floor(h1 / 62); }
  for (let k = 0; k < 4; k++) { out += BASE62[h2 % 62]; h2 = Math.floor(h2 / 62); }
  return out;
}

// deno-lint-ignore no-explicit-any
export function toOpenAIMessages(system: string, history: NormMsg[], provider = "openai"): any[] {
  const mistral = provider === "mistral";
  const id = (s: string) => (mistral ? idToolMistral(s) : s);
  // deno-lint-ignore no-explicit-any
  const msgs: any[] = [{ role: "system", content: system }];
  for (const m of history) {
    if (m.role === "user") {
      msgs.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      // Mistral pide `content` string también cuando el mensaje sólo trae tool_calls (así lo devuelve él mismo).
      // deno-lint-ignore no-explicit-any
      const msg: any = { role: "assistant", content: m.text || (mistral ? "" : null) };
      if (m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: id(tc.id), type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }
      msgs.push(msg);
    } else {
      for (const r of m.results) {
        msgs.push(mistral
          ? { role: "tool", name: r.name, tool_call_id: id(r.id), content: r.content }
          : { role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
  }
  return msgs;
}
