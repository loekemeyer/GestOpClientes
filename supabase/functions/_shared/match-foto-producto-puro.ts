// _shared/match-foto-producto-puro.ts — la parte PURA del match de foto (sin imports de red ni de supabase), para poder
// probarla con `deno run` sin credenciales (tests/match-foto-producto.test.ts). match-foto-producto.ts reexporta de acá.

export type Confianza = "alta" | "media" | "baja";
export interface MatchParseado { cod: string | null; confianza: Confianza; alternativas: string[] }

/** Parsea el JSON del modelo y lo limpia: cod y alternativas sólo valen si son códigos que estaban entre los candidatos.
 *  El modelo puede devolver basura, un código inexistente o envolver el JSON en ```: todo eso se descarta sin tirar. */
export function parseMatch(raw: string, codsValidos: Set<string>): MatchParseado {
  const j = String(raw ?? "").match(/\{[\s\S]*\}/);
  if (!j) return { cod: null, confianza: "baja", alternativas: [] };
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(j[0]);
  } catch {
    return { cod: null, confianza: "baja", alternativas: [] };
  }
  const limpiar = (v: unknown) => String(v ?? "").trim();
  const codRaw = limpiar(d.cod);
  const cod = codRaw && codsValidos.has(codRaw) ? codRaw : null; // null si el modelo devolvió un código que no estaba entre los candidatos
  const confianza = (["alta", "media", "baja"].includes(String(d.confianza)) ? d.confianza : "baja") as Confianza;
  const alternativas = (Array.isArray(d.alternativas) ? d.alternativas : [])
    .map(limpiar).filter((c) => c && c !== cod && codsValidos.has(c));
  return { cod, confianza, alternativas: [...new Set(alternativas)].slice(0, 3) };
}
