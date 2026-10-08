// eval-corridas — cómo se cuenta una corrida automática de los casos de evaluación (sql/133: wa_agente_eval_corridas y
// wa_agente_eval_resultados). Pablo Olejavetzky, 08/10/2026. Lo usan lk_fallas-mail (el aviso por mail) y lk_agente-modelos
// (el Panel, pestaña Evaluación). Funciones puras: las prueba tests/eval-corridas.test.ts.

export type Corrida = {
  id: number; origen: string; estado: string; modelos: string | null; anterior_id: number | null;
  casos: number; hechos: number; errores: number; cambios: number; creada_at: string; terminada_at: string | null;
};
export type Resultado = {
  eval_id: number; estado: string; camino: string | null; deriva: string | null; respuesta: string | null; error: string | null;
  cambios: string[] | null; antes: { estado?: string; camino?: string | null; deriva?: string | null; respuesta?: string | null } | null;
};
export type CasoEval = { id: number; clave: string | null; pregunta: string | null; causa: string | null };

const CAMINO: Record<string, string> = { ia: "agente IA" };
const caminoTxt = (c: string | null | undefined) => {
  const s = String(c ?? "").trim();
  if (!s) return "—";
  if (CAMINO[s]) return CAMINO[s];
  if (s.startsWith("fija")) return "respuesta fija" + s.slice(4);
  return s.replace(/_/g, " ");
};
const derivaTxt = (d: string | null | undefined) => {
  const s = String(d ?? "").trim();
  return !s || s === "no" ? "no deriva" : "deriva: " + s.replace(/_/g, " ");
};

/** Qué cambió en un caso, en castellano: "camino: respuesta fija #4 → agente IA". */
export function describirCambios(r: Resultado): string[] {
  const a = r.antes ?? {};
  return (r.cambios ?? []).map((c) => {
    if (c === "camino") return `camino: ${caminoTxt(a.camino)} → ${caminoTxt(r.camino)}`;
    if (c === "deriva") return `${derivaTxt(a.deriva)} → ${derivaTxt(r.deriva)}`;
    if (c === "texto") return "cambió el texto de la respuesta fija";
    if (c === "error") return `antes contestaba, ahora falla${r.error ? ` (${String(r.error).slice(0, 120)})` : ""}`;
    return c;
  });
}

/** Una línea por corrida: "84 casos · 80 bien · 3 con errores · 2 cambiaron". */
export function resumenCorrida(c: Corrida): string {
  if (c.estado === "sin_modelo_gratis") {
    return `No corrió: el modelo de pruebas (${c.modelos || "sin configurar"}) no es gratis, y la corrida nunca gasta.`;
  }
  if (c.estado === "corriendo") return `Corriendo: ${c.casos} casos, de a uno por minuto.`;
  const partes = [`${c.casos} casos`, `${c.hechos} contestados`];
  if (c.errores) partes.push(`${c.errores} con error`);
  partes.push(c.anterior_id ? (c.cambios ? `${c.cambios} cambiaron` : "ninguno cambió") : "primera corrida: queda como base");
  // "cortada": a las 6 horas (wa_eval_tick) o a mano (el 08/10 una sesión cortó la corrida 1 a la media hora porque Gemini estaba caído).
  if (c.estado === "cortada") partes.push("se cortó antes de terminar");
  return partes.join(" · ");
}

/** ¿Hay que avisar? Sí si algo cambió, si hubo errores o si no pudo correr. */
export function hayQueAvisar(c: Corrida): boolean {
  return c.estado === "sin_modelo_gratis" || c.estado === "cortada" || c.cambios > 0 || c.errores > 0;
}

/** Filas para el mail o el Panel: los casos que cambiaron primero, después los que fallaron. Hasta `max`. */
export function filasDeCorrida(res: Resultado[], casos: Map<number, CasoEval>, max = 30): Array<{ caso: string; pregunta: string; que: string }> {
  const nombre = (id: number) => {
    const e = casos.get(id);
    return e?.clave ? e.clave : `#${id}`;
  };
  const cambiaron = res.filter((r) => (r.cambios ?? []).length > 0);
  const fallaron = res.filter((r) => r.estado === "error" && !(r.cambios ?? []).includes("error"));
  return [
    ...cambiaron.map((r) => ({ caso: nombre(r.eval_id), pregunta: String(casos.get(r.eval_id)?.pregunta ?? "").slice(0, 160), que: describirCambios(r).join(" · ") })),
    ...fallaron.map((r) => ({ caso: nombre(r.eval_id), pregunta: String(casos.get(r.eval_id)?.pregunta ?? "").slice(0, 160),
      que: `no contestó${r.error ? ` (${String(r.error).slice(0, 120)})` : ""}` })),
  ].slice(0, max);
}
