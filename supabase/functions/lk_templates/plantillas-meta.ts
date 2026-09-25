// plantillas-meta — definición de las plantillas de seguimiento de pedido que
// se suben a Meta (WhatsApp Manager). ESTE archivo es la fuente: el texto que
// está acá es el que `lk_templates` (action `templates_sync`) crea o edita en Meta.
//
// Origen: propuesta "Plantillas de seguimiento LK" (artifact 9eU6WusDA7wWoadDFW3C3H,
// revisada con Pablo Olejavetzky el 25/09/2026). Las 6 de factura
// (`pedido_{contado|credito|echeq}_{s|p}`) NO están acá: ya existen en Meta y se
// manejan con `docs/plantillas_whatsapp.md` + `app_settings.wa_plantilla_formato`.
//
// Reglas de Meta que condicionan cómo se edita esto:
//   - `name` y `language` NO se pueden cambiar una vez creada. Para renombrar hay
//     que crear otra (`…_v2`); un nombre borrado queda bloqueado 30 días.
//   - Una plantilla APROBADA se edita como mucho 1 vez cada 24 h y 10 cada 30 días,
//     y al editarla vuelve a revisión. Conviene juntar los cambios antes de subir.
//   - Cada {{n}} necesita un valor de ejemplo (`ejemplos`, en orden).
//   - {{n}} numeradas desde 1, sin saltos, y el cuerpo no puede empezar ni
//     terminar con una variable.
//
// Crear o editar plantillas NO manda mensajes a nadie (no pasa por wa-guard ni
// por la llave `wa_envio_automatico`).

export type PlantillaMeta = {
  name: string;
  language: "es_AR";
  category: "UTILITY";
  /** Cuándo la dispara el bot (documentación, no se sube). */
  disparo: string;
  /** Qué completa el bot en cada {{n}}, en orden (documentación, no se sube). */
  variables: string[];
  body: string;
  /** Un valor de ejemplo por {{n}}, en el mismo orden. Meta lo exige. */
  ejemplos: string[];
};

const ES = "es_AR" as const;
const UT = "UTILITY" as const;

export const PLANTILLAS: PlantillaMeta[] = [
  // ── 1 · Pedido programado ────────────────────────────────────────────────
  {
    name: "pedido_programado",
    language: ES, category: UT,
    disparo: "La NP entra a una tanda con fecha de salida en la Programación. Camión propio.",
    variables: ["razón social", "fecha en que hizo el pedido (dd/mm)", "día de salida (dd/mm/aa)"],
    body: "Hola {{1}}, tu pedido del {{2}} ya tiene fecha: lo entregamos el {{3}}.\nTe avisamos cuando salga en el camión.",
    ejemplos: ["Bazar Rosemblit S.R.L", "22/09", "30/09/26"],
  },
  {
    name: "pedido_programado_expreso",
    language: ES, category: UT,
    disparo: "Idem pedido_programado, cuando el pedido sale por expreso.",
    variables: ["razón social", "fecha en que hizo el pedido (dd/mm)", "día de salida (dd/mm/aa)", "expreso"],
    body: "Hola {{1}}, tu pedido del {{2}} ya tiene fecha: lo despachamos el {{3}} por {{4}}.\nTe avisamos cuando lo entreguemos al expreso.",
    ejemplos: ["Bazar Rosemblit S.R.L", "22/09", "30/09/26", "Expreso Arias"],
  },
  {
    name: "pedido_programado_retira",
    language: ES, category: UT,
    disparo: "Idem pedido_programado, cuando el cliente retira en depósito.",
    variables: ["razón social", "fecha en que hizo el pedido (dd/mm)", "día en que está listo (dd/mm/aa)"],
    body: "Hola {{1}}, tu pedido del {{2}} va a estar listo para retirar el {{3}}.\nTe avisamos cuando esté preparado.",
    ejemplos: ["Bazar Rosemblit S.R.L", "22/09", "30/09/26"],
  },
  {
    name: "pedido_reprogramado",
    language: ES, category: UT,
    disparo: "Cambia la fecha de salida de una NP ya avisada como programada.",
    variables: ["razón social", "fecha en que hizo el pedido (dd/mm)", "nueva fecha de salida (dd/mm/aa)"],
    body: "Hola {{1}}, cambió la fecha de tu pedido del {{2}}: ahora sale el {{3}}.\nDisculpá las molestias.",
    ejemplos: ["Bazar Rosemblit S.R.L", "22/09", "02/10/26"],
  },

  // ── 2 · Estamos preparando tu pedido ────────────────────────────────────
  {
    name: "pedido_preparando",
    language: ES, category: UT,
    disparo: "Primer EP (inicio de picking) de la tanda de la NP. Todos los modos. Si cae el mismo día que la programación, va sólo éste.",
    variables: ["razón social", "fecha en que hizo el pedido (dd/mm)", "día de salida (dd/mm/aa)"],
    body: "Hola {{1}}, estamos preparando tu pedido del {{2}} en el depósito.\nSale el {{3}}.",
    ejemplos: ["Bazar Rosemblit S.R.L", "22/09", "30/09/26"],
  },

  // ── 4 · Tu pedido está en viaje ─────────────────────────────────────────
  {
    name: "pedido_en_viaje",
    language: ES, category: UT,
    disparo: "Carga Camión de la NP. Camión propio.",
    variables: ["razón social", "fecha en que hizo el pedido (dd/mm)", "dirección de entrega"],
    body: "Hola {{1}}, tu pedido del {{2}} ya salió en el camión hacia {{3}}.\nLo recibís en el día.",
    ejemplos: ["Bazar Rosemblit S.R.L", "22/09", "Av. Corrientes 3864"],
  },
  {
    name: "pedido_en_viaje_expreso",
    language: ES, category: UT,
    disparo: "Carga Camión de la NP, cuando sale por expreso (se entrega al expreso).",
    variables: ["razón social", "fecha en que hizo el pedido (dd/mm)", "expreso"],
    body: "Hola {{1}}, tu pedido del {{2}} ya salió hacia {{3}}.\nDesde ahí el expreso te lo lleva con sus tiempos de entrega.",
    ejemplos: ["Bazar Rosemblit S.R.L", "22/09", "Expreso Arias"],
  },
  {
    name: "pedido_listo_retirar",
    language: ES, category: UT,
    disparo: "Retira en depósito: sale al facturar (la Carga Camión de un Retira es el cliente llevándoselo).",
    variables: ["razón social", "fecha en que hizo el pedido (dd/mm)"],
    body: "Hola {{1}}, tu pedido del {{2}} está listo para retirar en Virgilio 2788, Villa Devoto.\nHorario: lunes a viernes de 10 a 12 y de 13 a 16 h.",
    ejemplos: ["Bazar Rosemblit S.R.L", "22/09"],
  },
];

/** Payload de `components` que espera Meta para crear/editar. */
export function componentesMeta(p: PlantillaMeta) {
  return [{
    type: "BODY",
    text: p.body,
    ...(p.ejemplos.length ? { example: { body_text: [p.ejemplos] } } : {}),
  }];
}

/** Errores de forma que Meta rechazaría. Vacío = OK. */
export function validar(p: PlantillaMeta): string[] {
  const err: string[] = [];
  if (!/^[a-z0-9_]{1,512}$/.test(p.name)) err.push("name: sólo minúsculas, números y _");
  const nums = [...p.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const distintos = [...new Set(nums)].sort((a, b) => a - b);
  distintos.forEach((n, i) => { if (n !== i + 1) err.push(`variables salteadas: falta {{${i + 1}}}`); });
  if (distintos.length !== p.ejemplos.length) {
    err.push(`${distintos.length} variables y ${p.ejemplos.length} ejemplos`);
  }
  if (/^\s*\{\{\d+\}\}/.test(p.body) || /\{\{\d+\}\}\s*$/.test(p.body)) {
    err.push("el cuerpo no puede empezar ni terminar con una variable");
  }
  if (p.body.length > 1024) err.push("cuerpo > 1024 caracteres");
  return err;
}
