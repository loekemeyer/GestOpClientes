// admin-gate — verificación de admin para edge functions que hoy son públicas.
//
// El CI deploya todas las funciones con `--no-verify-jwt`, así que una edge
// function sin chequeo propio es un endpoint HTTP anónimo de internet. La anon
// key de PaginaLK tampoco sirve como gate: viaja en `docs/index.html`, servido
// por GitHub Pages.
//
// El login del dashboard vive en OTRO proyecto Supabase (Google OAuth), así que
// la RLS de PaginaLK no puede reconocer al admin. Por eso el patrón es el mismo
// que ya usa `lk_faq-admin`:
//   1. El front manda su `access_token` OAuth.
//   2. Se valida contra el proyecto de auth y se saca el email.
//   3. Se exige que ese email sea role='admin' en `gestop_users` (PaginaLK).
//
// Uso:
//   const gate = await requireAdmin(body);
//   if (!gate.ok) return json({ error: gate.error }, gate.status);
//   // gate.email tiene el admin autenticado, para logs de auditoría.

import { supabase } from "./supabase.ts";

// Proyecto de auth (Google OAuth). Claves publicables, no secretas: ya viajan
// en el front. Overrideables por env.
const AUTH_URL = Deno.env.get("LK_AUTH_URL") ?? "https://hrxfctzncixxqmpfhskv.supabase.co";
const AUTH_KEY = Deno.env.get("LK_AUTH_ANON_KEY") ?? "sb_publishable_BqpAgZH6ty-9wft10_YMhw_0rcIPuWT";

export type AdminGate =
  | { ok: true; email: string }
  | { ok: false; error: string; status: number };

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

/**
 * Exige que el llamador sea un admin del dashboard.
 * `body` es el JSON del request; se espera `access_token`.
 */
// deno-lint-ignore no-explicit-any
export async function requireAdmin(body: any): Promise<AdminGate> {
  const token = String(body?.access_token ?? "").trim();
  if (!token) return { ok: false, error: "Falta sesión (access_token)", status: 401 };

  const email = await getAuthedEmail(token);
  if (!email) return { ok: false, error: "Sesión inválida o expirada", status: 401 };

  const { data: u, error } = await supabase
    .from("gestop_users")
    .select("role")
    .eq("email", email)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!u || u.role !== "admin") {
    return { ok: false, error: "No autorizado: se requiere rol admin", status: 403 };
  }

  return { ok: true, email };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variante para funciones que además llama otra edge function nuestra.
//
// `lk_parse-comprobante` es el caso: lo dispara el webhook (`triggerParser`) con el
// service_role como Bearer, pero también lo usa el dashboard. Ponerle sólo `requireAdmin`
// rompería el camino del webhook; dejarlo abierto lo deja como OCR gratis contra nuestras
// claves de Gemini/Claude para cualquiera que sepa la URL.
//
// Se acepta cualquiera de las dos:
//   · Bearer <service_role>  → es una llamada interna nuestra
//   · access_token de admin  → es el dashboard
//
// La comparación del service_role es en tiempo constante, por lo mismo que la firma de Meta:
// un `===` filtra en qué byte cortó.

function igualEnTiempoConstante(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/** ¿El request trae el service_role de este proyecto como Bearer? */
export function esLlamadaInterna(req: Request): boolean {
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!svc) return false;
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return igualEnTiempoConstante(svc, token);
}

/** Admin del dashboard, o llamada interna con el service_role. */
// deno-lint-ignore no-explicit-any
export async function requireAdminOrService(req: Request, body: any): Promise<AdminGate> {
  if (esLlamadaInterna(req)) return { ok: true, email: "service_role" };
  return await requireAdmin(body);
}
