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

// Nota deploy: el CI (deploy-edge-functions.yml) detecta cambios de `_shared`
// con `git diff HEAD^ HEAD`, así que un cambio a este archivo tiene que ir en el
// MISMO commit que llega a HEAD para que redeploye las funciones que lo importan.
import { supabase } from "./supabase.ts";

// Proyecto de auth (Google OAuth). Claves publicables, no secretas: ya viajan
// en el front. Overrideables por env.
const AUTH_URL = Deno.env.get("LK_AUTH_URL") ?? "https://hrxfctzncixxqmpfhskv.supabase.co";
const AUTH_KEY = Deno.env.get("LK_AUTH_ANON_KEY") ?? "sb_publishable_BqpAgZH6ty-9wft10_YMhw_0rcIPuWT";

export type AdminGate =
  | { ok: true; email: string }
  | { ok: false; error: string; status: number };

// Lee el claim `email` del JWT SIN volver a verificar la firma. Sólo se llama
// cuando GoTrue YA validó la firma (respondió con `session_not_found`, ver abajo),
// así que el claim es confiable. Chequea `exp` por las dudas.
function emailFromJwtClaims(jwt: string): string | null {
  try {
    const part = String(jwt).split(".")[1];
    if (!part) return null;
    let b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(b64));
    if (claims?.exp && (Date.now() / 1000) > Number(claims.exp)) return null; // expirado
    const email = claims?.email ?? claims?.user_metadata?.email ?? null;
    return email ? String(email).toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Valida el access_token contra el proyecto de auth y devuelve el email. */
async function getAuthedEmail(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch(`${AUTH_URL}/auth/v1/user`, {
      headers: { apikey: AUTH_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (r.ok) {
      const u = await r.json();
      const email = u?.email ?? u?.user?.email ?? null;
      return email ? String(email).toLowerCase() : null;
    }
    // Sesión purgada del lado servidor (proyecto legacy HS256): el navegador
    // conserva un JWT vigente cuya sesión GoTrue ya no existe, y `/user`
    // responde 403 `session_not_found`. Ese error es POSTERIOR a validar la
    // firma del token (una firma inválida da 401 `bad_jwt`), así que el email
    // del claim es confiable: caemos a leerlo del propio JWT en vez de romper
    // el gate en toda sesión que el server ya no tiene. Sin esto el dashboard
    // entero ("todas las edge functions rotas") queda inutilizable hasta que
    // cada admin se re-loguea.
    let bodyTxt = "";
    try { bodyTxt = await r.text(); } catch { /* ignore */ }
    if (bodyTxt.includes("session_not_found")) return emailFromJwtClaims(accessToken);
    return null;
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
