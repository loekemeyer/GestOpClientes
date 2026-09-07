// webhook-firma — verificación de la firma de Meta (X-Hub-Signature-256).
//
// EL PROBLEMA (punto 5 de la auditoría del 2026-09-07)
// ====================================================
// El CI deploya las edge functions con `--no-verify-jwt`, así que el webhook es un endpoint
// HTTP anónimo de internet. El GET sí valida `hub.verify_token`, pero el POST **no validaba
// nada**: cualquiera que conozca la URL arma un JSON con la forma de Meta y se hace pasar por
// el teléfono que quiera. Con eso puede leer la cuenta de otro cliente por el bot, o mandarle
// mensajes a un tercero desde nuestro número.
//
// CÓMO SE ARREGLA
// ===============
// Meta firma cada POST con HMAC-SHA256 del **cuerpo crudo** usando el App Secret de la app de
// Meta, y lo manda en `X-Hub-Signature-256: sha256=<hex>`. Se recalcula y se compara.
//
// Dos detalles que importan:
//   1. Hay que firmar el **texto exacto** que llegó, no `JSON.stringify(JSON.parse(body))`:
//      cualquier diferencia de espacios o de orden de claves cambia el hash. Por eso el
//      webhook pasó a leer `await req.text()` y parsear después.
//   2. La comparación es en **tiempo constante**. Comparar con `===` filtra, por el tiempo que
//      tarda en cortar, en qué byte falló — con suficientes intentos se reconstruye la firma.
//
// PUESTA EN MARCHA EN DOS PASOS (a propósito)
// ===========================================
// Si `META_APP_SECRET` **no está seteado**, esto NO rechaza nada: avisa por consola y deja
// pasar. Es deliberado: prender la validación de golpe, sin el secreto cargado, deja al bot
// mudo para todos los clientes. Con el secreto cargado pasa a rechazar de verdad.
//
//   Paso 1 (este commit): se deploya con el chequeo, todavía sin secreto → nada cambia.
//   Paso 2 (del dueño): Meta → App → Settings → Basic → App Secret, y cargarlo como secret de
//           la edge function: `META_APP_SECRET`. Desde ese momento queda cerrado.
//
// `estado()` dice en cuál de los dos pasos está, para poder verificarlo sin adivinar.

const SECRET = Deno.env.get("META_APP_SECRET") ?? "";

export type Firma =
  | { ok: true; modo: "verificada" | "sin_secreto" }
  | { ok: false; motivo: string };

/** ¿Está cargado el App Secret? Sirve para reportar en qué paso está la puesta en marcha. */
export function firmaActiva(): boolean {
  return !!SECRET;
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparación en tiempo constante: no corta en el primer byte distinto. */
function igualesEnTiempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/**
 * Verifica `X-Hub-Signature-256` contra el cuerpo CRUDO.
 * Sin `META_APP_SECRET` seteado devuelve ok con modo "sin_secreto" (ver arriba).
 */
export async function verificarFirmaMeta(rawBody: string, header: string | null): Promise<Firma> {
  if (!SECRET) return { ok: true, modo: "sin_secreto" };

  const recibida = String(header ?? "").trim();
  if (!recibida.startsWith("sha256=")) return { ok: false, motivo: "falta X-Hub-Signature-256" };

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const esperada = "sha256=" + hex(mac);
    if (!igualesEnTiempoConstante(esperada, recibida)) return { ok: false, motivo: "firma no coincide" };
    return { ok: true, modo: "verificada" };
  } catch (e) {
    return { ok: false, motivo: "error verificando: " + (e instanceof Error ? e.message : String(e)) };
  }
}
