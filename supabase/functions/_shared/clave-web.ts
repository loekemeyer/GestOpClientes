// _shared/clave-web.ts — el cliente pide su clave de la web por WhatsApp (Pablo Olejavetzky y Thomy, 07/10/2026).
//
// Pedido de Pablo: "si está agendado con número de cliente dale la clave, si no está agendado no". Y Thomy: "no le pongas
// una contraseña nueva, buscá bien en la base: el dato es CUIT (usuario) + PIN (contraseña)".
// La clave de la web ES `customers.pin`: medido el 07/10, los 1.262 PIN cargados coinciden con la clave de Auth de PaginaLK
// (el cliente que falta no tiene PIN). El usuario es el de Auth (`<cuit>@cuit.loekemeyer`): coincide con el CUIT en 1.262 de 1.263.
//
// "Agendado" = el teléfono identifica a un cliente (`wa_identify_customer`: vínculo aprobado, padrón de Gestión o
// customers.whatsapp). Si no lo identifica, no se da nada (`handleFaq` contesta TEXTO_CLAVE_NO_AGENDADO).
//
// La clave nunca queda legible fuera del mensaje que recibe el cliente: `handleFaq` devuelve el texto TAPADO (es lo que ven el
// Simulador y el chat de prueba, que no mandan nada) y sólo el webhook lee el PIN, lo pone al mandar y guarda en el historial
// la versión tapada (`taparClave`), así no lo lee el agente IA ni la pantalla de Conversaciones.
import { supabase } from "./supabase.ts";

export const CLAVE_OCULTA = "••••••••";

/** "Clave: 123456" → "Clave: ••••••••". Mismo patrón que la cola (sql/103) y lk_outbox-flush. */
export function taparClave(texto: string): string {
  return texto.replace(/Clave: \S+/g, `Clave: ${CLAVE_OCULTA}`);
}

export function textoAccesoWeb(usuario: string, clave: string): string {
  return `Tus datos para entrar a la web (loekemeyer.com → "Pedidos Mayorista"):\n` +
    `Usuario: ${usuario}\nClave: ${clave}\nNo los compartas con nadie.`;
}

/** Lo que devuelve `handleFaq`: sin datos reales (el webhook los completa). */
export const TEXTO_ACCESO_TAPADO = textoAccesoWeb("tu CUIT", CLAVE_OCULTA);

export const TEXTO_CLAVE_NO_AGENDADO =
  "Este número no está agendado como cliente, así que por acá no te puedo pasar la clave de la web.\n" +
  "Si ya sos cliente, pasame tu CUIT y una persona del equipo agenda este número. Después me la pedís de nuevo y te la paso.";

/** El cliente no tiene PIN cargado (o no se pudo leer): lo resuelve una persona. */
export const TEXTO_CLAVE_A_PERSONA = "Una persona del equipo revisa tu acceso a la web y te escribe por acá.";

/** Usuario y clave de la web del cliente. null si falta alguno de los dos. */
export async function datosDeAccesoWeb(customerId: string): Promise<{ usuario: string; clave: string } | null> {
  const { data: c, error } = await supabase.from("customers").select("cuit, pin, auth_user_id").eq("id", customerId).maybeSingle();
  if (error) {
    console.error("datosDeAccesoWeb:", error.message);
    return null;
  }
  const clave = String(c?.pin ?? "").trim();
  if (!clave) return null;
  let usuario = String(c?.cuit ?? "").replace(/\D/g, "");
  if (c?.auth_user_id) {
    const { data: u } = await supabase.auth.admin.getUserById(c.auth_user_id);
    const local = String(u?.user?.email ?? "").split("@")[0];
    if (local) usuario = local;
  }
  return usuario ? { usuario, clave } : null;
}
