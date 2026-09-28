// Códigos de error de Meta más comunes, en criollo. El resto muestra el texto de Meta.
// Lo usan lk_fallas-mail (mail de fallas) y Centro de mensajes › Salientes (lk_conversaciones).
export const ERRORES_META: Record<number, string> = {
  131047: "Pasaron más de 24 h desde que el cliente escribió; en ese caso sólo se puede mandar una plantilla aprobada.",
  131026: "No se pudo entregar: el número no tiene WhatsApp, bloqueó al negocio o no aceptó las condiciones nuevas de WhatsApp.",
  131049: "Meta lo frenó para no saturar al cliente con mensajes de marketing.",
  131050: "El cliente pidió no recibir mensajes de marketing.",
  131048: "Meta frenó el envío por límite de spam del número.",
  131056: "Demasiados mensajes seguidos al mismo cliente; hay que espaciar.",
  132000: "La plantilla se mandó con una cantidad de datos distinta a la que espera.",
  132001: "La plantilla no existe o no está aprobada en ese idioma.",
  130472: "Meta no lo entregó porque el cliente está en un experimento de Meta (no se cobra).",
  190: "El token de Meta venció o fue revocado: no sale ningún mensaje hasta reemplazarlo.",
};
