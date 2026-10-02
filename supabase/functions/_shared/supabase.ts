import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Caché de app_settings (opt-in) ─────────────────────────────────────────────────────────────
// Auditoría de performance del 02/10/2026: el webhook hacía ~17 lecturas de `getSetting` por mensaje, cada una un viaje
// a la base (3 ó 4 sólo en `loadConfig`, antes de mirar el mensaje). La tabla tiene 40 filas y pesa 8 KB: se lee ENTERA
// una vez por mensaje (`primeSettings`) y las lecturas que siguen salen de memoria.
//
// Es OPT-IN a propósito: sólo la prende quien llama a `habilitarCacheSettings(ttlMs)` (hoy: lk_whatsapp-webhook). Sin
// prenderla, `getSetting` consulta clave por clave como siempre, así el Simulador, el chat de prueba y el dashboard ven
// cada cambio de configuración al instante. En el webhook un cambio tarda como mucho `ttlMs` en aplicarse; la llave de
// envíos (`wa_envio_automatico`) NO pasa por acá: la lee `wa_puede_enviar` en SQL desde wa-guard, sin caché.
//
// Cada edge function corre en su propio isolate: la caché de una no la ve otra.
let cacheTtlMs = 0;
const cacheSettings = new Map<string, { value: string | null; hasta: number }>();
let cacheCompletaHasta = 0;   // mientras no venza, la tabla entera está en memoria: una clave ausente es null sin consultar

/** Prende la caché de `getSetting` en este isolate. 0 = apagada (comportamiento de siempre). */
export function habilitarCacheSettings(ttlMs: number): void {
  cacheTtlMs = Math.max(0, Math.floor(ttlMs));
  if (!cacheTtlMs) { cacheSettings.clear(); cacheCompletaHasta = 0; }
}

/** TTL vigente de la caché (0 = apagada). Lo usan otros módulos para memoizar sus propias lecturas de configuración. */
export function cacheSettingsTtl(): number {
  return cacheTtlMs;
}

/** Carga toda `app_settings` en la caché de una vez (un solo viaje). Sin caché prendida no hace nada. */
export async function primeSettings(): Promise<void> {
  if (!cacheTtlMs || cacheCompletaHasta > Date.now()) return;
  const { data, error } = await supabase.from("app_settings").select("key, value");
  if (error || !data) return;   // sin tabla completa, getSetting sigue consultando clave por clave
  const hasta = Date.now() + cacheTtlMs;
  cacheSettings.clear();
  for (const r of data as Array<{ key: string; value: string | null }>) cacheSettings.set(r.key, { value: r.value ?? null, hasta });
  cacheCompletaHasta = hasta;
}

/** Lee un valor de app_settings por key (de la caché si está prendida y vigente). */
export async function getSetting(key: string): Promise<string | null> {
  if (cacheTtlMs) {
    const hit = cacheSettings.get(key);
    if (hit && hit.hasta > Date.now()) return hit.value;
    if (cacheCompletaHasta > Date.now()) return null;
  }
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  const value = data?.value ?? null;
  if (cacheTtlMs) cacheSettings.set(key, { value, hasta: Date.now() + cacheTtlMs });
  return value;
}

/** Cliente Supabase para proyecto ISIS (facturas/comprobantes) — lazy init */
// deno-lint-ignore no-explicit-any
let _isisClient: any = null;

export async function getIsisClient() {
  if (_isisClient) return _isisClient;
  const isisUrl = Deno.env.get("ISIS_SUPABASE_URL") ?? await getSetting("isis_supabase_url") ?? "";
  const isisKey = Deno.env.get("ISIS_SUPABASE_SERVICE_KEY") ?? await getSetting("isis_supabase_service_key") ?? "";
  if (!isisUrl || !isisKey) throw new Error("ISIS Supabase credentials not configured");
  _isisClient = createClient(isisUrl, isisKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: "isis_lk" },
  });
  return _isisClient;
}

/** Cliente del proyecto de Gestión Virgilio (mismo proyecto que ISIS) en otro schema — planify, public… */
// deno-lint-ignore no-explicit-any
const _gestion: Record<string, any> = {};
export async function getGestionClient(schema: string) {
  if (_gestion[schema]) return _gestion[schema];
  const url = Deno.env.get("ISIS_SUPABASE_URL") ?? await getSetting("isis_supabase_url") ?? "";
  const key = Deno.env.get("ISIS_SUPABASE_SERVICE_KEY") ?? await getSetting("isis_supabase_service_key") ?? "";
  if (!url || !key) throw new Error("Gestión Supabase credentials not configured");
  _gestion[schema] = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false }, db: { schema } });
  return _gestion[schema];
}
