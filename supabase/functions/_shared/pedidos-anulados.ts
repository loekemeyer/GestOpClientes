// Pedidos web anulados o borrados → para el chatbot NO existen (Pablo, 28/09: "todo pedido cancelado o
// borrado no tiene que existir para el chatbot").
//
// En la web (orders) no queda rastro: todos los pedidos siguen en status 'pendiente'. La anulación vive en
// Gestión: GV_Pedidos_Anulados (anulados desde la PPP, con motivo) y GV_Pedidos_Prueba_Historial (pedidos de
// prueba borrados). Se leen con las credenciales de Gestión (getGestionClient), sólo empresa 'lk'.
// Caché de 60 s por instancia y tope de 3 s: si Gestión no contesta, no se excluye nada (se loguea).
// Tampoco existen los pedidos que nunca se mandaron a la planilla (orders.sheets_sent = false): son intentos
// fallidos de la web (ej. cliente 4210, 14/09: 4 intentos sin enviar + el pedido real).
import { getGestionClient, supabase } from "./supabase.ts";

let cache: { hasta: number; ids: Set<number> } | null = null;

export async function pedidosAnulados(): Promise<Set<number>> {
  if (cache && cache.hasta > Date.now()) return cache.ids;
  try {
    const g = await getGestionClient("public");
    const tope = <T>(p: PromiseLike<T>) =>
      Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 3000))]);
    const [an, pr] = await Promise.all([
      tope(g.from("GV_Pedidos_Anulados").select("order_id").eq("empresa", "lk").not("order_id", "is", null)),
      tope(g.from("GV_Pedidos_Prueba_Historial").select("order_id").eq("empresa", "lk").not("order_id", "is", null)),
    ]);
    const ids = new Set<number>();
    for (const r of [...(an.data ?? []), ...(pr.data ?? [])]) {
      const n = Number((r as { order_id: unknown }).order_id);
      if (n > 0) ids.add(n);
    }
    if (an.error || pr.error) console.error("pedidosAnulados:", an.error?.message ?? pr.error?.message);
    cache = { hasta: Date.now() + 60_000, ids };
    return ids;
  } catch (e) {
    console.error("pedidosAnulados: Gestión no respondió, no se excluye nada", e);
    return cache?.ids ?? new Set();
  }
}

/** Filtra una lista de pedidos (con `id` u `order_id`) sacando los anulados/borrados y los nunca enviados. */
export async function sinAnulados<T extends Record<string, unknown>>(filas: T[], campo = "id"): Promise<T[]> {
  if (!filas.length) return filas;
  const ids = [...new Set(filas.map((f) => Number(f[campo])).filter((n) => n > 0))];
  const [anul, noEnviados] = await Promise.all([
    pedidosAnulados(),
    ids.length
      ? supabase.from("orders").select("id").in("id", ids).eq("sheets_sent", false)
        .then(({ data }) => new Set((data ?? []).map((o: { id: number }) => Number(o.id))), () => new Set<number>())
      : Promise.resolve(new Set<number>()),
  ]);
  return filas.filter((f) => { const n = Number(f[campo]); return !anul.has(n) && !noEnviados.has(n); });
}
