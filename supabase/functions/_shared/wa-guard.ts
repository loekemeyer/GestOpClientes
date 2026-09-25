// _shared/wa-guard.ts — EL corte en código (D007, "vasectomía", Luis 2026-09-25).
//
// Importarlo (import "../_shared/wa-guard.ts";) en TODA edge function que le hable a Meta.
// Envuelve fetch una sola vez: cualquier POST a graph.facebook.com/.../messages con destinatario
// ("to") le pregunta a la base public.wa_puede_enviar(phone) si puede salir. Si no → no llama a
// Meta y devuelve un 403 con forma de error de Meta, así cada función lo trata como un envío
// fallido con su propio manejo de errores, sin tocar su lógica.
//
// La POLÍTICA no vive acá: vive en wa_puede_enviar (sql/070), que lee
// app_settings.wa_envio_automatico ('0' nada · 'prueba' sólo wa_envio_contactos · '1' todos).
// FAIL-CLOSED: si no se puede consultar la base, no sale.
// Los "marcar como leído" no llevan "to" y pasan: no contactan a nadie.

const FLAG = "__lkWaGuard";
// deno-lint-ignore no-explicit-any
const g = globalThis as any;

if (!g[FLAG]) {
  g[FLAG] = true;
  const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
  const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const puedeEnviar = async (to: string): Promise<boolean> => {
    if (!SB_URL || !SB_KEY) return false;
    try {
      const r = await realFetch(`${SB_URL}/rest/v1/rpc/wa_puede_enviar`, {
        method: "POST",
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_phone: to }),
      });
      if (!r.ok) return false;
      return (await r.json()) === true;
    } catch (_) {
      return false;
    }
  };

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "POST" && /graph\.facebook\.com\/v[\d.]+\/[^/]+\/messages(\?|$)/.test(url)) {
      let to = "";
      try {
        const raw = typeof init?.body === "string" ? init.body : "";
        to = String(JSON.parse(raw || "{}")?.to ?? "");
      } catch (_) { /* sin body JSON: no es un envío a una persona */ }
      if (to && !(await puedeEnviar(to))) {
        console.warn(`[wa-guard] envío a ${to.slice(0, 5)}… bloqueado por wa_envio_automatico`);
        return new Response(
          JSON.stringify({ error: { message: "bloqueado por wa_envio_automatico (D007)", code: 0, type: "LkWaGuard" } }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    return realFetch(input, init);
  };
}

export {};
