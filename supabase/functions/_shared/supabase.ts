import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Lee un valor de app_settings por key */
export async function getSetting(key: string): Promise<string | null> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? null;
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
