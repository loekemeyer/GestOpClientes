// envios-bot — cada mensaje que el bot manda en la charla queda con el wamid que devuelve Meta (wa_envios_bot, sql/140).
// Pablo Olejavetzky, 13/10/2026 (plan de los 8 puntos, P6 "revisar el resultado").
//
// Por qué: Meta acepta el POST y puede rechazarlo DESPUÉS (webhook de estados, `failed`). Hasta acá sólo la cola guardaba
// el wamid (wa_outbox.wamid): las respuestas del bot y las fotos de la charla no se podían cruzar con su estado, así que
// el bot le decía al cliente «te mandé la foto» y nadie sabía que no había llegado (08/10, 5 fotos del 505 a Damián).
// Con la fila acá, el trigger de sql/140 convierte el `failed` en una línea de "Hechos de esta charla" para el agente y
// en una alerta para una persona.
//
// Lo llama waPost (_shared/wa-api.ts) después de cada POST aceptado a /messages con destinatario: una sola puerta, como el
// corte de wa-guard. Nunca lanza ni demora más de 1,5 s: si la base no contesta, el envío ya salió y el turno sigue.
import { supabase } from "./supabase.ts";
import { conTope } from "./ejemplos-aprobados.ts";

export type TipoEnvio = "text" | "image" | "document" | "template" | "otro";
export interface EnvioDescripto { tipo: TipoEnvio; descripcion: string; plantilla: string | null }

const limpia = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const recorte = (s: unknown, n: number) => { const t = limpia(s, n + 1); return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t; };

/** Cómo se le nombra el envío al agente y a la persona. Función pura: la prueban tests/envios-bot.test.ts. */
export function descripcionDeEnvio(body: Record<string, unknown>): EnvioDescripto {
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  const t = String(b?.type ?? "");
  if (t === "text") {
    const texto = recorte(b?.text?.body, 60);
    return { tipo: "text", descripcion: texto ? `el mensaje «${texto}»` : "un mensaje", plantilla: null };
  }
  if (t === "image") {
    const cap = recorte(b?.image?.caption, 60);
    return { tipo: "image", descripcion: cap ? `la foto «${cap}»` : "una foto", plantilla: null };
  }
  if (t === "document") {
    const nombre = limpia(b?.document?.filename, 80);
    return { tipo: "document", descripcion: nombre ? `el archivo «${nombre}»` : "un archivo", plantilla: null };
  }
  if (t === "template") {
    const nombre = limpia(b?.template?.name, 80).replace(/[^\w.-]/g, "");
    return { tipo: "template", descripcion: nombre ? `el aviso «${nombre}»` : "un aviso", plantilla: nombre || null };
  }
  return { tipo: "otro", descripcion: t ? `un mensaje de tipo ${limpia(t, 20)}` : "un mensaje", plantilla: null };
}

/** El wamid que devuelve Meta en un POST aceptado a /messages. */
export function wamidDeRespuesta(respuesta: unknown): string | null {
  // deno-lint-ignore no-explicit-any
  const id = (respuesta as any)?.messages?.[0]?.id;
  return typeof id === "string" && id.startsWith("wamid.") ? id : null;
}

/** Guarda el envío. Nunca lanza; tope 1,5 s. */
export async function registrarEnvioBot(to: string, body: Record<string, unknown>, respuesta: unknown): Promise<void> {
  const wamid = wamidDeRespuesta(respuesta);
  if (!wamid) return;
  const d = descripcionDeEnvio(body);
  try {
    const { error } = await conTope(
      supabase.from("wa_envios_bot").upsert({ wamid, telefono: String(to), tipo: d.tipo, descripcion: d.descripcion, plantilla: d.plantilla },
        { onConflict: "wamid", ignoreDuplicates: true }),
      1500,
    );
    if (error) console.warn("envios-bot: no se guardó el envío:", error.message);
  } catch (e) {
    console.warn("envios-bot:", e instanceof Error ? e.message : e);
  }
}
