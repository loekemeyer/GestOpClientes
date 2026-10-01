// _shared/cadenas.ts — Cadenas con lista de precios propia (precios_super de PaginaLK, sql/114).
// Pablo, 01/10: el bot no conoce esas listas (cotiza lista general − dto_vol), así que el dashboard avisa
// antes de vincular o agendar un teléfono de una cadena. Lo usan lk_vinculaciones y lk_conversaciones.
import { supabase } from "./supabase.ts";

export interface CadenaListaPropia {
  cadena: string;
  n_precios: number;
  lista_fecha: string | null;
  aviso: string;
}

const ddmmaaaa = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

function avisoCadena(cadena: string, n: number, fecha: string | null): string {
  return `${cadena} es una cadena con lista de precios propia (${n} artículos${fecha ? `, lista del ${ddmmaaaa(fecha)}` : ""}). ` +
    "El bot no la usa: los precios que le muestre por WhatsApp salen de la lista general, no de la suya.";
}

/** Cadenas con lista propia por código de cliente LK. Si la consulta falla devuelve vacío: el aviso no frena nada. */
export async function cadenasListaPropia(cods: unknown[]): Promise<Map<number, CadenaListaPropia>> {
  const out = new Map<number, CadenaListaPropia>();
  const ids = [...new Set(cods.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return out;
  const { data, error } = await supabase.rpc("bot_cadenas_lista_propia", { p_cods: ids });
  if (error) { console.error("bot_cadenas_lista_propia:", error.message); return out; }
  for (const r of (data ?? []) as { cod_cliente: number; cadena: string; n_precios: number; lista_fecha: string | null }[]) {
    out.set(Number(r.cod_cliente), {
      cadena: r.cadena, n_precios: Number(r.n_precios), lista_fecha: r.lista_fecha,
      aviso: avisoCadena(r.cadena, Number(r.n_precios), r.lista_fecha),
    });
  }
  return out;
}
