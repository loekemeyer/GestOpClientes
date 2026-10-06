// Las tareas de Planify de una alerta. Antes una alerta tenía UNA tarea (contexto.planify_task_id); con varios destinos puede tener varias
// (contexto.planify_task_ids). planify_task_id sigue siendo la primera: así lo que ya lo lee (el filtro de sync, las alertas viejas) no cambia.
// Módulo PURO (sin red ni base), se prueba en tests/tareas-alerta.test.ts.

type Ctx = Record<string, unknown> | null | undefined;

/** Ids de las tareas de Planify de una alerta, en orden y sin repetir (lee el formato viejo y el nuevo). */
export function idsDeTareas(ctx: Ctx): number[] {
  const ids: number[] = [];
  const lista = Array.isArray(ctx?.planify_task_ids) ? (ctx!.planify_task_ids as unknown[]) : [];
  for (const x of lista) { const n = Number(x); if (n > 0 && !ids.includes(n)) ids.push(n); }
  const uno = Number(ctx?.planify_task_id);
  if (uno > 0 && !ids.includes(uno)) ids.unshift(uno);
  return ids;
}

/** Lo que se guarda en el contexto al crear las tareas: la primera como siempre y, si hay más de una, la lista. */
export function contextoConTareas(ctx: Record<string, unknown>, ids: number[]): Record<string, unknown> {
  const { planify_task_ids: _viejo, ...resto } = ctx;
  return { ...resto, planify_task_id: ids[0], ...(ids.length > 1 ? { planify_task_ids: ids } : {}) };
}

/** La alerta está atendida cuando NINGUNA de sus tareas sigue abierta (hecha o borrada en Planify). Sin tareas no se da por atendida. */
export function alertaAtendida(ids: number[], abiertas: ReadonlySet<number>): boolean {
  return ids.length > 0 && ids.every((id) => !abiertas.has(id));
}

/** Quién se hizo cargo ("Me encargo yo") de sus tareas, "Ana, Luis"; null si nadie. */
export function quienTomo(ids: number[], tomo: ReadonlyMap<number, string>): string | null {
  const nombres: string[] = [];
  for (const id of ids) { const n = tomo.get(id); if (n && !nombres.includes(n)) nombres.push(n); }
  return nombres.length ? nombres.join(", ") : null;
}

/** Parte una lista en tandas (los `in (…)` de PostgREST van en la URL: con varios destinos por alerta pueden ser miles de ids). */
export function trozos<T>(lista: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < lista.length; i += n) out.push(lista.slice(i, i + n));
  return out;
}
