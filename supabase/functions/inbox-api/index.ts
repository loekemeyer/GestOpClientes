// Edge Function: inbox-api
// Backend del Inbox Web "Ventas Loekemeyer".
// =============================================================================
// SEGURIDAD:
//   - Auth por password unica (INBOX_PASSWORD env var).
//   - Cada request debe mandar: Authorization: Bearer <password>
//   - El frontend guarda el password en memoria/localStorage + nombre del agente.
//   - CORS abierto (necesario para frontend servido desde otro origen).
//   - Rate limit simple en /login: 5 intentos fallidos → bloqueo por IP 5min.
//   - Todas las acciones auditadas en bot_inbox_accesos y bot_auditoria.
//
// ENDPOINTS (todos bajo el path del function, ej: /functions/v1/inbox-api/...):
//   POST /login                 body: { password, agente_nombre }
//   GET  /chats                 → lista de chats con ultimo msg + estado
//   GET  /chats/:telefono       → historial completo
//   POST /chats/:telefono/send  body: { contenido, agente_nombre }
//   POST /chats/:telefono/modo  body: { modo: 'bot'|'humano', agente_nombre }
// D007 (2026-09-25): el envío pasa por _shared/wa-guard.ts. Fuente versionada desde acá (antes v41
// sólo en el proyecto). El resto del código es el de v41 sin cambios.
// =============================================================================

import "../_shared/wa-guard.ts"; // D007: corte único de envíos a Meta
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INBOX_PASSWORD = Deno.env.get("INBOX_PASSWORD") ?? "";
const WA_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// CORS permisivo — el frontend puede ser servido desde el bucket publico o
// desde cualquier otro dominio en el futuro.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-agente",
  "Access-Control-Max-Age": "86400",
};

// Helper para responses JSON con CORS.
function json(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extra },
  });
}

// ===== Rate limiting muy simple para /login ================================
// Memoria efimera por Edge Function (se resetea cuando Supabase recicla la
// instancia, pero sirve para rate limit basico contra brute force).
const loginAttempts = new Map<string, { count: number; firstAt: number }>();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5 minutos

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAt: now });
    return true;
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

function registerFailedAttempt(ip: string) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count++;
  }
}

// ===== Auth helper =========================================================
// Verifica el header Authorization: Bearer <password> contra INBOX_PASSWORD.
function isAuthed(req: Request): boolean {
  if (!INBOX_PASSWORD) return false; // si no hay password configurado, cerrar todo
  const h = req.headers.get("authorization") ?? "";
  const match = h.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return match[1].trim() === INBOX_PASSWORD;
}

// ===== WhatsApp send (reusa el patron del bot) =============================
async function waSendText(to: string, body: string) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    },
  );
  if (!res.ok) {
    const txt = await res.text();
    console.error("WA send failed", res.status, txt);
    return { ok: false, error: txt };
  }
  return { ok: true };
}

// ===== Handlers de endpoints ==============================================

async function handleLogin(req: Request, ip: string): Promise<Response> {
  if (!checkRateLimit(ip)) {
    return json({ error: "demasiados intentos, probá en unos minutos" }, 429);
  }

  let body: { password?: string; agente_nombre?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "json invalido" }, 400);
  }

  const pass = (body.password ?? "").trim();
  const agente = (body.agente_nombre ?? "").trim();

  if (!pass || !agente) {
    return json({ error: "password y agente_nombre son requeridos" }, 400);
  }
  if (agente.length < 2 || agente.length > 50) {
    return json({ error: "nombre invalido (2-50 caracteres)" }, 400);
  }

  const ok = pass === INBOX_PASSWORD;

  // Loguear el intento (exitoso o no)
  await supabase.rpc("bot_inbox_log_acceso", {
    p_agente_nombre: agente,
    p_ip: ip,
    p_exito: ok,
  });

  if (!ok) {
    registerFailedAttempt(ip);
    return json({ error: "password incorrecto" }, 401);
  }

  return json({ ok: true, token: INBOX_PASSWORD, agente_nombre: agente });
}

async function handleListChats(): Promise<Response> {
  const { data, error } = await supabase.rpc("bot_inbox_listar_chats", {
    p_limit: 200,
  });
  if (error) {
    console.error("listar_chats error", error);
    return json({ error: "no pude listar chats" }, 500);
  }
  return json({ chats: data ?? [] });
}

async function handleHistorial(telefono: string): Promise<Response> {
  if (!/^\d{8,20}$/.test(telefono)) {
    return json({ error: "telefono invalido" }, 400);
  }
  const { data, error } = await supabase.rpc("bot_inbox_historial", {
    p_telefono: telefono,
    p_limit: 500,
  });
  if (error) {
    console.error("historial error", error);
    return json({ error: "no pude traer historial" }, 500);
  }
  return json({ mensajes: data ?? [] });
}

async function handleSend(req: Request, telefono: string): Promise<Response> {
  if (!/^\d{8,20}$/.test(telefono)) {
    return json({ error: "telefono invalido" }, 400);
  }

  let body: { contenido?: string; agente_nombre?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "json invalido" }, 400);
  }

  const contenido = (body.contenido ?? "").trim();
  const agente = (body.agente_nombre ?? "").trim();

  if (!contenido) return json({ error: "contenido vacio" }, 400);
  if (contenido.length > 4000) return json({ error: "contenido muy largo" }, 400);
  if (!agente || agente.length < 2) {
    return json({ error: "agente_nombre requerido" }, 400);
  }

  // 1) Enviar por WhatsApp Cloud API
  const sent = await waSendText(telefono, contenido);
  if (!sent.ok) {
    return json({ error: "no se pudo enviar al whatsapp del cliente", detalle: sent.error }, 502);
  }

  // 2) Guardar en historial con fuente='humano' + pausar bot 2hs
  const { data, error } = await supabase.rpc("bot_inbox_enviar_mensaje", {
    p_telefono: telefono,
    p_contenido: contenido,
    p_agente_nombre: agente,
    p_horas_pausa: 2,
  });
  if (error) {
    console.error("bot_inbox_enviar_mensaje error", error);
    return json({ error: "mensaje enviado pero no pudimos guardarlo" }, 500);
  }

  // 3) Auditar (best-effort)
  await supabase.rpc("bot_auditar_tool", {
    p_telefono: telefono,
    p_tool: "inbox_send",
    p_params: { agente, len: contenido.length },
    p_resumen: `id ${data}`,
  });

  return json({ ok: true, id: data });
}

async function handleSetAlias(req: Request, telefono: string): Promise<Response> {
  if (!/^\d{8,20}$/.test(telefono)) {
    return json({ error: "telefono invalido" }, 400);
  }
  let body: { alias?: string; agente_nombre?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "json invalido" }, 400);
  }
  const alias = (body.alias ?? "").trim();
  const agente = (body.agente_nombre ?? "").trim() || "admin";
  if (alias.length > 80) {
    return json({ error: "alias demasiado largo (max 80)" }, 400);
  }
  const { error } = await supabase.rpc("bot_inbox_set_alias", {
    p_telefono: telefono,
    p_alias: alias,
    p_agente: agente,
  });
  if (error) {
    console.error("set_alias error", error);
    return json({ error: "no pude guardar alias" }, 500);
  }
  return json({ ok: true, alias });
}

async function handleSetModo(req: Request, telefono: string): Promise<Response> {
  if (!/^\d{8,20}$/.test(telefono)) {
    return json({ error: "telefono invalido" }, 400);
  }

  let body: { modo?: string; agente_nombre?: string; horas?: number } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "json invalido" }, 400);
  }

  const modo = body.modo;
  const agente = (body.agente_nombre ?? "").trim();
  const horas = typeof body.horas === "number" ? body.horas : 2;

  if (modo !== "bot" && modo !== "humano") {
    return json({ error: "modo debe ser 'bot' o 'humano'" }, 400);
  }
  if (modo === "humano" && (!agente || agente.length < 2)) {
    return json({ error: "agente_nombre requerido al poner modo=humano" }, 400);
  }

  const { error } = await supabase.rpc("bot_conv_set_modo", {
    p_telefono: telefono,
    p_modo: modo,
    p_agente_nombre: modo === "humano" ? agente : null,
    p_motivo: modo === "humano" ? "tomado manualmente desde inbox" : "devuelto al bot desde inbox",
    p_horas: horas,
  });
  if (error) {
    console.error("set_modo error", error);
    return json({ error: "no pude cambiar modo" }, 500);
  }

  await supabase.rpc("bot_auditar_tool", {
    p_telefono: telefono,
    p_tool: "inbox_set_modo",
    p_params: { modo, agente, horas },
    p_resumen: `modo=${modo}`,
  });

  return json({ ok: true, modo });
}

// ===== Router ==============================================================
Deno.serve(async (req: Request) => {
  // Preflight CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  // El path viene con prefijo /inbox-api por la config de Supabase Edge Functions.
  // Sacamos todo hasta (e incluyendo) el nombre de la funcion.
  const path = url.pathname.replace(/^.*\/inbox-api/, "") || "/";
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";

  try {
    // /login es el unico endpoint sin auth previa.
    if (path === "/login" && req.method === "POST") {
      return await handleLogin(req, ip);
    }

    // Resto de endpoints: requieren password
    if (!isAuthed(req)) {
      return json({ error: "no autorizado" }, 401);
    }

    // GET /chats
    if (path === "/chats" && req.method === "GET") {
      return await handleListChats();
    }

    // GET /chats/:telefono
    const histMatch = path.match(/^\/chats\/(\d+)$/);
    if (histMatch && req.method === "GET") {
      return await handleHistorial(histMatch[1]);
    }

    // POST /chats/:telefono/send
    const sendMatch = path.match(/^\/chats\/(\d+)\/send$/);
    if (sendMatch && req.method === "POST") {
      return await handleSend(req, sendMatch[1]);
    }

    // POST /chats/:telefono/modo
    const modoMatch = path.match(/^\/chats\/(\d+)\/modo$/);
    if (modoMatch && req.method === "POST") {
      return await handleSetModo(req, modoMatch[1]);
    }

    // POST /chats/:telefono/alias
    const aliasMatch = path.match(/^\/chats\/(\d+)\/alias$/);
    if (aliasMatch && req.method === "POST") {
      return await handleSetAlias(req, aliasMatch[1]);
    }

    return json({ error: "not found", path }, 404);
  } catch (e) {
    console.error("inbox-api error", e);
    return json({ error: "error interno" }, 500);
  }
});
