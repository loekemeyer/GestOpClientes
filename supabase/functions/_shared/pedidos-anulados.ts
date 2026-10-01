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

const cachePorEmpresa = new Map<string, { hasta: number; ids: Set<number> }>();

// `empresa` (01/10): "lk" (por defecto) o "chef" — las anulaciones de Chef son otras filas (GV_Pedidos_Anulados.empresa).
export async function pedidosAnulados(empresa: "lk" | "chef" = "lk"): Promise<Set<number>> {
  const cache = cachePorEmpresa.get(empresa);
  if (cache && cache.hasta > Date.now()) return cache.ids;
  try {
    const g = await getGestionClient("public");
    const tope = <T>(p: PromiseLike<T>) =>
      Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 3000))]);
    const [an, pr] = await Promise.all([
      tope(g.from("GV_Pedidos_Anulados").select("order_id").eq("empresa", empresa).not("order_id", "is", null)),
      tope(g.from("GV_Pedidos_Prueba_Historial").select("order_id").eq("empresa", empresa).not("order_id", "is", null)),
    ]);
    const ids = new Set<number>();
    for (const r of [...(an.data ?? []), ...(pr.data ?? [])]) {
      const n = Number((r as { order_id: unknown }).order_id);
      if (n > 0) ids.add(n);
    }
    if (an.error || pr.error) console.error("pedidosAnulados:", an.error?.message ?? pr.error?.message);
    cachePorEmpresa.set(empresa, { hasta: Date.now() + 60_000, ids });
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

// Estado de pedidos web: la RPC bot_estado_pedidos_gv (sql/066) lee Gestión por FDW. 30/09: con Gestión caída
// la RPC fallaba, `est` quedaba vacío y cada llamador caía al status de la web ("pendiente" → "recibido"):
// el bot decía "recibido, sin fecha" de pedidos entregados. Respaldo: order_tracking, que Gestión alimenta
// cada 10 min (sql/069). Misma forma { data } que la RPC para no tocar a los llamadores.
export type EstadoPedido = { order_id: number; status: string; fecha_entrega: string | null; fuente: string };
export async function estadoPedidos(ids: Array<number | string>): Promise<{ data: EstadoPedido[] }> {
  const nums = ids.map(Number).filter((n) => n > 0);
  if (!nums.length) return { data: [] };
  const { data, error } = await supabase.rpc("bot_estado_pedidos_gv", { p_ids: nums });
  if (!error) return { data: (data ?? []) as EstadoPedido[] };
  console.error("bot_estado_pedidos_gv falló, uso order_tracking:", error.message);
  const { data: ot } = await supabase.from("order_tracking").select("np_number, status, fecha_entrega")
    .in("np_number", nums.map(String));
  return {
    data: (ot ?? []).map((r: { np_number: string; status: string | null; fecha_entrega: string | null }) => {
      const st = String(r.status ?? "").toLowerCase();
      const status = ["recibido", "programado", "entregado"].includes(st) ? st : "recibido";
      return { order_id: Number(r.np_number), status, fecha_entrega: status === "recibido" ? null : r.fecha_entrega, fuente: "planilla" };
    }),
  };
}
