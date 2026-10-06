// Feriados del calendario de Planify, leídos en vivo (Pablo Olejavetzky, 06/10/2026: "hay un calendario en el Planify, podés tomar ahí la data").
// planify.feriados vive en el proyecto de Gestión; la llena un cron diario (planify_sync-feriados, 01:30 AR) desde argentinadatos y hoy
// trae 2026 y 2027. Se lee con las credenciales de Gestión que ya usa el bot (getGestionClient).
//
// Caché en memoria de 6 h (el calendario cambia como mucho una vez por día) y con tope de espera: si Gestión no contesta se sigue con lo último
// que se sabía (o sin feriados) y se reintenta en 2 minutos. Un calendario caído NUNCA puede frenar una respuesta ni un listado: sólo deja
// de contar los feriados hasta que vuelva.
import { getGestionClient } from "./supabase.ts";
import { type FeriadoCalendario, registrarCalendario } from "./horario.ts";

const VIGENCIA_MS = 6 * 3_600_000, REINTENTO_MS = 2 * 60_000, TOPE_MS = 2_500;
let cache: { hasta: number; filas: FeriadoCalendario[] } | null = null;

async function consultar(): Promise<FeriadoCalendario[]> {
  const planify = await getGestionClient("planify");
  const desde = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10); // un mes y medio para atrás: alcanza para fechas de vencimiento recientes
  const { data, error } = await planify.from("feriados").select("fecha, nombre, tipo").gte("fecha", desde).order("fecha").limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as FeriadoCalendario[];
}

/** Feriados del calendario (de la caché si está vigente). Nunca lanza. Además deja el calendario registrado para `horarioEfectivo()`. */
export async function cargarCalendario(): Promise<FeriadoCalendario[]> {
  if (cache && cache.hasta > Date.now()) { registrarCalendario(cache.filas); return cache.filas; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const filas = await Promise.race([
      consultar(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`sin respuesta en ${TOPE_MS} ms`)), TOPE_MS); }),
    ]);
    cache = { hasta: Date.now() + VIGENCIA_MS, filas };
  } catch (e) {
    console.error("[feriados] no pude leer el calendario de Planify:", e instanceof Error ? e.message : e);
    cache = { hasta: Date.now() + REINTENTO_MS, filas: cache?.filas ?? [] };
  } finally { if (timer) clearTimeout(timer); }
  registrarCalendario(cache.filas);
  return cache.filas;
}
