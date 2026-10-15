// _shared/wa-guard-destino.ts — de qué cliente es el mensaje que sale a Meta (guardrail de cruce de cliente, sql/156).
//
// Un productor que SABE a qué cliente va su mensaje lo declara con dos headers en el fetch a Meta:
//   x-lk-cuit          CUIT del cliente (con o sin guiones)
//   x-lk-cod-cliente   código del cliente en Loekemeyer
// wa-guard.ts los lee, los saca del pedido (Meta no tiene que verlos) y le pregunta a la base
// public.wa_puede_enviar_a(phone, cuit, cod_cliente), que además de la llave rechaza el cruce: un teléfono vinculado a OTRO
// cliente real. Sin esos headers todo sigue igual que antes (wa_puede_enviar).
//
// Sin efectos al importarlo: es una función pura, para poder probarla sin red.

export const HEADER_CUIT = "x-lk-cuit";
export const HEADER_COD_CLIENTE = "x-lk-cod-cliente";

export interface Destinatario {
  cuit: string;
  codCliente: string;
}

/** Saca los headers del cliente de `init.headers` y devuelve el init limpio. `destinatario` es null si no venían o venían vacíos. */
export function separarDestinatario(init?: RequestInit): { init: RequestInit | undefined; destinatario: Destinatario | null } {
  const h = init?.headers;
  if (!init || !h) return { init, destinatario: null };

  let cuit = "";
  let codCliente = "";
  let limpio: HeadersInit;

  if (h instanceof Headers) {
    cuit = h.get(HEADER_CUIT) ?? "";
    codCliente = h.get(HEADER_COD_CLIENTE) ?? "";
    const copia = new Headers(h);
    copia.delete(HEADER_CUIT);
    copia.delete(HEADER_COD_CLIENTE);
    limpio = copia;
  } else if (Array.isArray(h)) {
    const resto: [string, string][] = [];
    for (const [k, v] of h) {
      const n = String(k).toLowerCase();
      if (n === HEADER_CUIT) cuit = String(v);
      else if (n === HEADER_COD_CLIENTE) codCliente = String(v);
      else resto.push([k, v]);
    }
    limpio = resto;
  } else {
    const resto: Record<string, string> = {};
    for (const [k, v] of Object.entries(h as Record<string, string>)) {
      const n = k.toLowerCase();
      if (n === HEADER_CUIT) cuit = String(v);
      else if (n === HEADER_COD_CLIENTE) codCliente = String(v);
      else resto[k] = v;
    }
    limpio = resto;
  }

  cuit = cuit.trim();
  codCliente = codCliente.trim();
  const destinatario = cuit || codCliente ? { cuit, codCliente } : null;
  return { init: { ...init, headers: limpio }, destinatario };
}

/** Los headers que un productor agrega a su fetch a Meta para declarar el cliente (vacíos no se mandan). */
export function headersDestinatario(cliente?: { cuit?: string | null; codCliente?: string | number | null } | null): Record<string, string> {
  const out: Record<string, string> = {};
  const cuit = String(cliente?.cuit ?? "").trim();
  const cod = String(cliente?.codCliente ?? "").trim();
  if (cuit) out[HEADER_CUIT] = cuit;
  if (cod) out[HEADER_COD_CLIENTE] = cod;
  return out;
}
