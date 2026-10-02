// Pedido mínimo que informa el bot (Pablo, 01/10; sql/120): el general (app_settings.wa_minimo_compra) y las
// excepciones por cliente (wa_minimo_excepciones, se cargan en Configuración del agente › Pedidos por WhatsApp).
// Lo usan la FAQ #21/#31 (faq.ts, db_lookup_type minimo_compra) y el prompt del agente (bot-conversation.ts).
// Es sólo informativo: el aviso en pedidos por WhatsApp sigue siendo wa_pedidos_config.minimo_envio/_retiro.
import { getSetting, supabase } from "./supabase.ts";

export const SETTING_MINIMO = "wa_minimo_compra";
const GENERAL_DEF = { envio: 500000, retiro: 300000 };

export type Minimo = { envio: number; retiro: number; excepcion: boolean };

export async function minimoGeneral(): Promise<{ envio: number; retiro: number }> {
  // Por getSetting (no un select directo) para aprovechar la caché de settings donde esté prendida (webhook).
  const raw = await getSetting(SETTING_MINIMO);
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    const n = (x: unknown, def: number) => (x != null && Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : def);
    return { envio: n(v?.envio, GENERAL_DEF.envio), retiro: n(v?.retiro, GENERAL_DEF.retiro) };
  } catch {
    return { ...GENERAL_DEF };
  }
}

/** Mínimo del cliente (por customers.id o, si no está, por código): su excepción o el general. */
export async function minimoCliente(c: { id?: string | null; cod?: number | null } | null | undefined): Promise<Minimo> {
  if (!c?.id && !c?.cod) return { ...(await minimoGeneral()), excepcion: false };
  let q = supabase.from("wa_minimo_excepciones").select("minimo_envio, minimo_retiro");
  q = c.id ? q.eq("customer_id", c.id) : q.eq("cod_cliente", c.cod);
  // El general y la excepción no dependen entre sí: van en paralelo (un viaje en vez de dos).
  const [g, { data, error }] = await Promise.all([minimoGeneral(), q.limit(1).maybeSingle()]);
  if (error || !data) return { ...g, excepcion: false };
  return {
    envio: data.minimo_envio != null ? Number(data.minimo_envio) : g.envio,
    retiro: data.minimo_retiro != null ? Number(data.minimo_retiro) : g.retiro,
    excepcion: true,
  };
}

/** "$500.000", o "sin mínimo" si es 0. */
export function fmtMinimo(n: number): string {
  return n > 0 ? "$" + Math.round(n).toLocaleString("es-AR") : "sin mínimo";
}
