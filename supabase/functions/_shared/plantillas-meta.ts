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
// Criterio de texto (Pablo, 25/09): saludo "Hola {{1}}, te escribimos de Loekemeyer." y sin
// pie (el nombre del negocio ya lo muestra WhatsApp). Fechas sin año: la del pedido "dd/mm" y
// la de salida con día de la semana ("miércoles 30/09").
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
  // ── 0 · Pedido recibido (reemplaza el texto libre de trg_notify_order_created) ──
  {
    name: "pedido_recibido",
    language: ES, category: UT,
    disparo: "El pedido queda enviado (orders.sheets_sent pasa a true, sql/082). El total de orders es sin IVA.",
    // {{5}} (Pablo, 29/09): fecha estimada por la demora real del modo (p90 de 90 días) o, si retira y eligió día
    // en la web, ese día y franja. Lo arma wa_fecha_estimada_calc y queda en wa_fecha_estimada para medir cumplimiento.
    // Con la razón social (Pablo, 29/09: "por ser el primer mensaje"); los demás avisos van sin nombre. sql/104
    // (revierte sql/093, que la había sacado).
    // {{3}} (Pablo, 29/09): total con IVA y, entre paréntesis, el neto "+ IVA" — "por $896.668 ($741.048 + IVA)" — y una
    // línea en blanco después del saludo. Va como pedido_recibido_v2 (sistema de versiones): mientras la activa sea la
    // vieja, el disparador (sql/108) sigue mandando sólo el neto, porque ese texto ya dice "+ IVA".
    variables: ["razón social", "fecha del pedido (dd/mm)", "total con IVA y el neto: \"$896.668 ($741.048 + IVA)\"", "método de pago (texto limpio, sin el descuento)", "entrega estimada (texto)"],
    // Texto de Pablo (29/09): "Entrega estimada <día>" + "En breve te confirmamos el día exacto de programación".
    // {{5}} es sólo el día (y, si va por expreso o retira, la aclaración entre paréntesis): sql/087.
    body: "¡Hola {{1}}! Te escribimos de Loekemeyer.\n\nRecibimos tu pedido del {{2}} por {{3}}.\nMétodo de pago: {{4}}.\nEntrega estimada: {{5}}.\nEn breve te confirmamos el día exacto de programación.",
    ejemplos: ["Autoservicio Capo SA", "28/09", "$11.430 ($9.446 + IVA)", "contado", "martes 20/10"],
  },

  // ── 1 · Pedido programado ────────────────────────────────────────────────
  {
    name: "pedido_programado",
    language: ES, category: UT,
    disparo: "La NP entra a una tanda con fecha de salida en la Programación. Camión propio.",
    // Sin el saludo "Hola X, te escribimos de Loekemeyer" (Pablo, 29/09): ya se presentó en pedido_recibido. sql/088.
    // {{3}} = dirección de entrega del pedido (sucursal_entrega de Gestión, v_pedidos_web). sql/090.
    variables: ["fecha en que hizo el pedido (dd/mm)", "día de salida (día de semana + dd/mm)", "dirección de entrega"],
    body: "Tu pedido del {{1}} ya tiene fecha: lo entregamos el {{2}} en {{3}}.\nTe avisamos cuando salga en el camión.",
    ejemplos: ["22/09", "miércoles 30/09", "Lamadrid 157 - S.M. Tucumán"],
  },
  {
    name: "pedido_programado_expreso",
    language: ES, category: UT,
    disparo: "Idem pedido_programado, cuando el pedido sale por expreso.",
    // Sin la doble presentación (Pablo, 29/09). {{3}} es el nombre del expreso sin la palabra "Expreso" (sql/089).
    variables: ["fecha en que hizo el pedido (dd/mm)", "día de salida (día de semana + dd/mm)", "expreso (sin la palabra Expreso)"],
    body: "Tu pedido del {{1}} ya tiene fecha: lo despachamos el {{2}} a Expreso {{3}}.\nTe avisamos cuando lo entreguemos al expreso.",
    ejemplos: ["22/09", "miércoles 30/09", "Arias"],
  },
  {
    name: "pedido_programado_retira",
    language: ES, category: UT,
    disparo: "Idem pedido_programado, cuando el cliente retira en depósito.",
    // Sin la doble presentación (Pablo, 29/09, sql/092).
    variables: ["fecha en que hizo el pedido (dd/mm)", "día en que está listo (día de semana + dd/mm)"],
    body: "Tu pedido del {{1}} va a estar listo para retirar el {{2}}.\nTe confirmamos por este medio cuando puedas pasar a buscarlo.",
    ejemplos: ["22/09", "miércoles 30/09"],
  },
  {
    name: "pedido_reprogramado",
    language: ES, category: UT,
    disparo: "Cambia la fecha de salida de una NP ya avisada como programada.",
    // Sin la doble presentación (Pablo, 29/09, sql/092).
    variables: ["fecha en que hizo el pedido (dd/mm)", "nueva fecha de salida (día de semana + dd/mm)"],
    body: "Cambió la fecha de tu pedido del {{1}}: ahora sale el {{2}}.\nDisculpá las molestias.",
    ejemplos: ["22/09", "viernes 02/10"],
  },

  // (pedido_preparando se quitó el 29/09 a pedido de Pablo: "no tiene sentido". Sigue en Meta sin uso; sql/091.)

  // ── 4 · Tu pedido está en viaje ─────────────────────────────────────────
  {
    name: "pedido_en_viaje",
    language: ES, category: UT,
    disparo: "Carga Camión de la NP. Camión propio.",
    // Sin la doble presentación (Pablo, 29/09, sql/094). Pablo, 30/09 (auditoría): "sale hoy" en vez de "ya salió … Lo
    // recibís en el día": el cron de pedidos web lo manda a las 9 y 11 según la fecha planificada, aunque el camión no
    // haya salido, así que no se promete la entrega.
    variables: ["fecha en que hizo el pedido (dd/mm)", "dirección de entrega"],
    body: "Tu pedido del {{1}} sale hoy en el reparto hacia {{2}}.",
    ejemplos: ["22/09", "Av. Corrientes 3864"],
  },
  {
    name: "pedido_en_viaje_expreso",
    language: ES, category: UT,
    disparo: "Carga Camión de la NP, cuando sale por expreso (se entrega al expreso).",
    // Sin la doble presentación (Pablo, 29/09, sql/094). {{2}} = expreso sin la palabra "Expreso".
    variables: ["fecha en que hizo el pedido (dd/mm)", "expreso (sin la palabra Expreso)"],
    body: "Tu pedido del {{1}} ya salió hacia Expreso {{2}}.\nDesde ahí el expreso te lo lleva con sus tiempos de entrega.",
    ejemplos: ["22/09", "Arias"],
  },
  {
    name: "pedido_listo_retirar",
    language: ES, category: UT,
    // Horario = franjas de retiro de la web (9:00 a 12:00 y 13:00 a 16:30), Pablo 29/09.
    disparo: "Retira en depósito: el pedido web llega a 'facturado' en Gestión (cron lk_aviso-retiro-web, sql/083).",
    // Sin la doble presentación (Pablo, 29/09, sql/094).
    variables: ["fecha en que hizo el pedido (dd/mm)"],
    body: "Tu pedido del {{1}} está listo para retirar en Virgilio 2788, Villa Devoto.\nHorario: lunes a viernes de 9 a 12 y de 13 a 16:30 h.",
    ejemplos: ["22/09"],
  },

  // ── Pedido entregado (reparto propio). Pedido de Pablo Olejavetzky (28/09): el aviso de entregado
  //    depende de cómo se entregó — expreso usa pedido_en_viaje_expreso, retiro en mano no se avisa.
  {
    name: "pedido_entregado",
    language: ES, category: UT,
    disparo: "order_tracking pasa a 'entregado' y el pedido fue por reparto propio (no expreso ni retiro).",
    // Sin la doble presentación (Pablo, 29/09, sql/094).
    variables: ["fecha en que hizo el pedido (dd/mm)"],
    body: "Tu pedido del {{1}} fue entregado.\nSi falta algo o llegó algo mal, avisanos por acá.",
    ejemplos: ["22/09"],
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
  // Meta cuenta como "al final" una variable seguida sólo de puntuación ("Sale el {{3}}." → error 2388299).
  if (/^[\s¡¿"'(]*\{\{\d+\}\}/.test(p.body) || /\{\{\d+\}\}[\s.,;:!?)"']*$/.test(p.body)) {
    err.push("el cuerpo no puede empezar ni terminar con una variable (tampoco seguida sólo de un punto)");
  }
  if (p.body.length > 1024) err.push("cuerpo > 1024 caracteres");
  return err;
}

/**
 * Texto que leyó el cliente: el cuerpo de la plantilla con sus {{n}} reemplazados.
 * `params` es el jsonb de wa_outbox.template_params ({"1": …, "2": …}). null si la plantilla
 * no está definida acá (ej. las de factura), para que el que llama use su propio formato.
 */
export function renderPlantilla(name: string, params: Record<string, unknown> | null): string | null {
  const p = PLANTILLAS.find((x) => x.name === name);
  if (!p) return null;
  const vals = params ? Object.values(params).map((v) => String(v)) : [];
  return p.body.replace(/\{\{(\d+)\}\}/g, (m, n) => vals[Number(n) - 1] ?? m);
}
