// lk_faq-admin — edición segura de plantillas de wa_faq desde el dashboard.
//
// Problema: la anon key de PaginaLK es pública (viaja en el HTML), y el login
// Google del dashboard vive en OTRO proyecto Supabase, así que la RLS de
// PaginaLK no puede distinguir a un admin. Por eso la escritura de wa_faq NO
// se hace directo desde el navegador: pasa por acá.
//
// Esta función:
//   1. Recibe el access_token OAuth del usuario (del proyecto de auth).
//   2. Lo valida contra ese proyecto y saca el email.
//   3. Verifica que ese email sea role='admin' en gestop_users (PaginaLK).
//   4. Acepta SOLO columnas de texto whitelisteadas y un id existente.
//   5. Escribe con service_role.
//
// Acciones:
//   update { access_token, id, patch:{bot_response?,institutional_response?,web_first_response?} }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Proyecto de auth (Google OAuth). Son claves publicables (no secretas): ya
// viajan en el front. Se pueden overridear por env.
const AUTH_URL = Deno.env.get("LK_AUTH_URL") ?? "https://hrxfctzncixxqmpfhskv.supabase.co";
const AUTH_KEY = Deno.env.get("LK_AUTH_ANON_KEY") ?? "sb_publishable_BqpAgZH6ty-9wft10_YMhw_0rcIPuWT";

// Columnas de texto que un admin puede editar. NADA fuera de esta lista.
const ALLOWED_COLS = ["bot_response", "institutional_response", "web_first_response"] as const;

// Service-role client (PaginaLK) — bypassa RLS, por eso esta función valida al admin.
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Valida el access_token contra el proyecto de auth y devuelve el email. */
async function getAuthedEmail(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch(`${AUTH_URL}/auth/v1/user`, {
      headers: { apikey: AUTH_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    const email = u?.email ?? u?.user?.email ?? null;
    return email ? String(email).toLowerCase() : null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "update") return json({ error: "Acción no soportada" }, 400);

    // 1-2. Autenticación
    const token = String(body.access_token ?? "").trim();
    if (!token) return json({ error: "Falta sesión (access_token)" }, 401);
    const email = await getAuthedEmail(token);
    if (!email) return json({ error: "Sesión inválida o expirada" }, 401);

    // 3. Autorización: solo admin
    const { data: u, error: uErr } = await sb
      .from("gestop_users")
      .select("role")
      .eq("email", email)
      .maybeSingle();
    if (uErr) return json({ error: uErr.message }, 500);
    if (!u || u.role !== "admin") {
      return json({ error: "No autorizado: se requiere rol admin" }, 403);
    }

    // 4. Validación del payload
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "id inválido" }, 400);

    const rawPatch = (body.patch ?? {}) as Record<string, unknown>;
    const patch: Record<string, string | null> = {};
    for (const col of ALLOWED_COLS) {
      if (Object.prototype.hasOwnProperty.call(rawPatch, col)) {
        const v = rawPatch[col];
        if (v === null) patch[col] = null;
        else if (typeof v === "string") patch[col] = v;
        else return json({ error: `Campo ${col} debe ser texto` }, 400);
      }
    }
    // Rechazar cualquier columna fuera de la whitelist.
    const extra = Object.keys(rawPatch).filter((k) => !ALLOWED_COLS.includes(k as typeof ALLOWED_COLS[number]));
    if (extra.length) return json({ error: `Campos no permitidos: ${extra.join(", ")}` }, 400);
    if (!Object.keys(patch).length) return json({ error: "Nada para actualizar" }, 400);

    // 5. Escritura (solo filas existentes). RLS no aplica: service_role.
    const { data, error } = await sb
      .from("wa_faq")
      .update(patch)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: "No existe la FAQ id=" + id }, 404);

    console.log(`[lk_faq-admin] ${email} actualizó wa_faq id=${id} campos=${Object.keys(patch).join(",")}`);
    return json({ ok: true, id });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
