// plantillas-version — qué nombre de plantilla de Meta se manda para cada aviso (Pablo, 29/09).
//
// Meta deja editar una plantilla aprobada 1 vez cada 24 h y, mientras la revisa, no se puede mandar. Para cambiar un
// texto sin cortar el aviso se crea una versión nueva con otro nombre (pedido_recibido_v2), se sigue mandando la
// activa y, cuando Meta aprueba la nueva, se pasa a esa (lk_templates action templates_promover, cron cada 30 min).
//
// app_settings.wa_plantillas_version (JSON), por nombre base de plantillas-meta.ts:
//   { "pedido_recibido": { "activa": "pedido_recibido", "nueva": "pedido_recibido_v2" } }
// Sin fila o sin entrada → se manda el nombre base. Los disparadores (SQL) siempre encolan el nombre base.

export type Versiones = Record<string, { activa?: string; nueva?: string }>;

// deno-lint-ignore no-explicit-any
export async function leerVersiones(sb: any): Promise<Versiones> {
  const { data } = await sb.from("app_settings").select("value").eq("key", "wa_plantillas_version").maybeSingle();
  try { return data?.value ? JSON.parse(data.value) : {}; } catch { return {}; }
}

/** Nombre en Meta que hay que mandar hoy para el aviso `base`. */
export const nombreActivo = (v: Versiones, base: string): string => v[base]?.activa || base;

/** Próximo nombre libre: pedido_recibido → pedido_recibido_v2 → _v3 … (un nombre borrado en Meta no se reusa por un tiempo). */
export function siguienteNombre(base: string, v: Versiones, existentes: Set<string>): string {
  const usados = new Set([...existentes, v[base]?.activa ?? base, v[base]?.nueva ?? ""]);
  for (let n = 2; n < 100; n++) {
    const cand = `${base}_v${n}`;
    if (!usados.has(cand)) return cand;
  }
  throw new Error(`sin nombre libre para ${base}`);
}
