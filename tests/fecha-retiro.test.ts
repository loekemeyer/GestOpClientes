// Pruebas del estado de un pedido que se RETIRA (supabase/functions/_shared/fecha-retiro.ts) y del texto completo de la lista de pedidos (pedidos-marca.ts, textoPedidosChef).
// Pablo Olejavetzky, 06 y 07/10/2026 (correcciones m21, m24, m25, m2, m68): "programado para el lunes 05/10" y, ya facturado, "listo para retirar desde el martes 06/10"; el título dice "que falta retirar".
// Correr: deno run --allow-env tests/fecha-retiro.test.ts   (sale con código 1 si algo falla)
// pedidos-marca.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { estadoParaAnular, lineaParaAnular, textoEstadoTrasAviso, palabraCerrados, textoDemasCerrados, textoEstadoRetiro, tituloPorRetiro, tituloConfirmado, pideConfirmacionPedido, diaConFecha, estadoRetiroParaIA, textoLlegando, depositoAbierto, PREGUNTA_FRANJA, textoRetiroConfirmado, textoFranjaConfirmada, franjaDeRetiro, retiroInformado } = await import("../supabase/functions/_shared/fecha-retiro.ts");
const { textoPedidosChef } = await import("../supabase/functions/_shared/pedidos-marca.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

igual("programado: 'programado para el lunes 05/10' (el texto que aprobó Pablo el 06/10)", textoEstadoRetiro("programado", "🚚 programado", "lunes 05/10"), "🚚 programado para el lunes 05/10");
igual("facturado con día: 'listo para retirar desde el martes 06/10' (texto aprobado el 07/10)", textoEstadoRetiro("facturado", "🧾 facturado, listo para salir", "martes 06/10"), "🧾 facturado, listo para retirar desde el martes 06/10");
igual("facturado sin día", textoEstadoRetiro("facturado", "🧾 facturado, listo para salir", null), "🧾 facturado, listo para retirar");
igual("en preparación con día", textoEstadoRetiro("en preparacion", "🛠️ en preparación en el depósito", "miércoles 07/10"), "🛠️ en preparación en el depósito: va a estar listo para retirar desde el miércoles 07/10");
igual("en preparación sin día: queda como está", textoEstadoRetiro("en preparacion", "🛠️ en preparación en el depósito", null), "🛠️ en preparación en el depósito");
igual("programado sin día: queda como está", textoEstadoRetiro("programado", "🚚 programado", null), "🚚 programado");
igual("ningún caso dice 'listo para salir' en un retiro", /listo para salir/.test(textoEstadoRetiro("facturado", "🧾 facturado, listo para salir", "lunes 05/10")), false);

igual("título: un solo pedido de retiro", tituloPorRetiro([true], true), "este es tu pedido que falta retirar");
igual("título: varios, todos de retiro", tituloPorRetiro([true, true], false), "estos son tus pedidos que faltan retirar");
igual("título: retiro mezclado con reparto", tituloPorRetiro([true, false], false), "estos son tus pedidos pendientes");
igual("título: nada de retiro → el de siempre", tituloPorRetiro([false, false], false), null);
igual("título de Chef", tituloPorRetiro([true], true, "de Chef"), "este es tu pedido de Chef que falta retirar");

// m2 (07/10): "¿está confirmado?" abre la lista con "tu pedido está confirmado:".
igual("título confirmado: un pedido", tituloConfirmado(true), "tu pedido está confirmado");
igual("título confirmado: varios", tituloConfirmado(false), "tus pedidos están confirmados");
for (const t of ["Hice un pedido hace 10 días, quería saber si está confirmado", "¿Ya confirmaron mi pedido?", "¿Tienen la confirmación del pedido?", "el pedido está confirmada?"])
  igual(`pide confirmación: ${t}`, pideConfirmacionPedido(t), true);
for (const t of ["¿Sabés cuándo me entregan el pedido?", "Hace 10 días hice un pedido, quería saber el estado", "¿Hoy entregan el pedido?", "Nos llegó al mail las facturas"])
  igual(`no pide confirmación: ${t}`, pideConfirmacionPedido(t), false);

// m1 y m23 (07/10): el estado de un retiro redactado para la IA; nunca "salió".
igual("día con fecha", diaConFecha("2026-10-06"), "martes 06/10");
igual("día con fecha (domingo)", diaConFecha("2026-10-04T00:00:00+00:00"), "domingo 04/10");
igual("IA: facturado → 'listo para retirar desde el martes 06/10' (m23 y m1)", estadoRetiroParaIA("facturado", "2026-10-06"), "facturado y listo para retirar desde el martes 06/10");
igual("IA: entregado → 'retirado el martes 06/10' (m1)", estadoRetiroParaIA("entregado", "2026-10-06"), "retirado el martes 06/10");
igual("IA: entregado sin fecha", estadoRetiroParaIA("entregado", null), "retirado");
igual("IA: programado", estadoRetiroParaIA("programado", "2026-10-05"), "programado para el lunes 05/10");
igual("IA: en preparación", estadoRetiroParaIA("en preparacion", "2026-10-05"), "en preparación en el depósito; va a estar listo para retirar desde el lunes 05/10");
igual("IA: recibido", estadoRetiroParaIA("recibido", null), "recibido, todavía sin fecha");
for (const e of ["recibido", "programado", "en preparacion", "facturado", "entregado"]) igual(`IA: ningún estado de retiro dice 'salió' ni 'entreg' (${e})`, /sali[óo]|sale\b|entreg/i.test(estadoRetiroParaIA(e, "2026-10-06")), false);

// El texto completo (lista de Chef, mismo formato que la de Loekemeyer).
const ped = (o: Record<string, unknown>) => ({ creado: "2026-09-30T15:00:00Z", estado: "facturado", fecha_entrega: "2026-10-06", retiro: "2026-10-06", sucursal: null, reingreso: null, entregado_at: null, ...o });
const t1 = textoPedidosChef("Chef SRL", [ped({}) as never], "2026-10-06", { cierre: false });
igual("lista de un pedido de retiro facturado", t1, "Chef SRL, este es tu pedido de Chef que falta retirar:\n\n1️⃣ Pedido del 30/09 — 🧾 facturado, listo para retirar desde el martes 06/10");
const t2 = textoPedidosChef("Chef SRL", [ped({ retiro: null }) as never], "2026-10-06", { cierre: false });
igual("lista de un pedido de reparto: sigue igual", t2, "Chef SRL, este es tu pedido de Chef que falta entregar:\n\n1️⃣ Pedido del 30/09 — 🧾 facturado, listo para salir: sale el martes 06/10");
const t3 = textoPedidosChef("Chef SRL", [ped({}) as never, ped({ retiro: null, creado: "2026-09-29T15:00:00Z" }) as never], "2026-10-06", { cierre: false });
igual("lista mezclada: título 'pendientes'", t3.startsWith("Chef SRL, estos son tus pedidos de Chef pendientes:"), true);
const t4 = textoPedidosChef("Chef SRL", [ped({ fecha_entrega: "2026-10-01", retiro: "2026-10-01" }) as never], "2026-10-06", { cierre: false });
igual("retiro facturado con fecha pasada: sin día, igual dice 'listo para retirar'", t4.includes("— 🧾 facturado, listo para retirar") && !t4.includes("desde el"), true);

// ── m36 y m37 (07/10): retiro con la pregunta de la franja y el aviso a Ventas ──
igual("m36/m37: el texto aprobado por Pablo (con la pregunta)", textoRetiroConfirmado("30/09", "jueves 08/10", true),
  "Sí, podés retirar tu pedido del 30/09 el jueves 08/10, de 9 a 12 o de 13 a 16:30 h, en Virgilio 2788.\n¿Pasás por la mañana o por la tarde? Le avisamos a Ventas para que lo tenga a mano.");
igual("hoy pasado el mediodía: sin la pregunta, con el aviso", textoRetiroConfirmado("30/09", "miércoles 07/10", false),
  "Sí, podés retirar tu pedido del 30/09 el miércoles 07/10, de 9 a 12 o de 13 a 16:30 h, en Virgilio 2788.\nLe avisamos a Ventas para que lo tenga a mano.");
igual("la respuesta a la franja (texto aprobado)", textoFranjaConfirmada("jueves 08/10", "mañana"), "Perfecto, te esperamos el jueves 08/10 por la mañana. Ya le avisamos a Ventas.");
igual("la respuesta a la franja, tarde", textoFranjaConfirmada("jueves 08/10", "tarde"), "Perfecto, te esperamos el jueves 08/10 por la tarde. Ya le avisamos a Ventas.");
igual("la pregunta es la marca del texto", textoRetiroConfirmado("30/09", "jueves 08/10", true).includes(PREGUNTA_FRANJA), true);
for (const [msg, esp] of [["A la mañana", "mañana"], ["por la mañana", "mañana"], ["mañana", "mañana"], ["Temprano", "mañana"], ["Por la tarde", "tarde"], ["tarde", "tarde"],
  ["paso a la tarde, después de las 14", "tarde"], ["mañana a la tarde", "tarde"], ["a la mañana o a la tarde", null], ["gracias", null], ["sí", null], ["¿mañana puedo pasar?", null],
  ["Buenas tardes, quería hacer otra consulta sobre mi pedido, que no me llegó la factura y necesito que me la manden por mail", null]] as Array<[string, string | null]>) {
  igual(`franja: "${msg}"`, franjaDeRetiro(msg), esp);
}
const ult = textoRetiroConfirmado("30/09", "jueves 08/10", true);
igual("retiroInformado saca el pedido y el día del mensaje con la pregunta", retiroInformado(ult), { del: "30/09", dia: "jueves 08/10" });
igual("retiroInformado: sin la pregunta (hoy pasado el mediodía) no es una pregunta pendiente", retiroInformado(textoRetiroConfirmado("30/09", "jueves 08/10", false)), null);
igual("retiroInformado: otro mensaje del bot", retiroInformado("Tu pedido del 30/09 está programado."), null);
igual("retiroInformado: vacío", retiroInformado(""), null);

// ── m39 (07/10): "Estoy llegando, ¿me esperan?" ──
igual("m39: el texto aprobado por Pablo", textoLlegando("Estamos en Virgilio 2788, Villa Devoto, de lunes a viernes de 9 a 12 y de 13 a 16:30 (de 12 a 13 cerramos para almorzar)."),
  "Le aviso ahora mismo a Ventas para confirmar que te puedan esperar y te escribimos por este medio en un momento.\nEstamos en Virgilio 2788, Villa Devoto, de lunes a viernes de 9 a 12 y de 13 a 16:30 (de 12 a 13 cerramos para almorzar).");
igual("m39: ya no promete '¡Te esperamos!'", /Te esperamos/.test(textoLlegando("x")), false);
// 2026-10-07 es miércoles; la hora de Argentina es UTC-3
const ar = (iso: string) => new Date(iso);
igual("depósito: miércoles 10:00 abierto", depositoAbierto(ar("2026-10-07T13:00:00Z")), true);
igual("depósito: miércoles 08:59 cerrado", depositoAbierto(ar("2026-10-07T11:59:00Z")), false);
igual("depósito: miércoles 09:00 abierto", depositoAbierto(ar("2026-10-07T12:00:00Z")), true);
igual("depósito: miércoles 11:59 abierto", depositoAbierto(ar("2026-10-07T14:59:00Z")), true);
igual("depósito: miércoles 12:30 (almuerzo) cerrado", depositoAbierto(ar("2026-10-07T15:30:00Z")), false);
igual("depósito: miércoles 13:00 abierto", depositoAbierto(ar("2026-10-07T16:00:00Z")), true);
igual("depósito: miércoles 16:29 abierto", depositoAbierto(ar("2026-10-07T19:29:00Z")), true);
igual("depósito: miércoles 16:30 cerrado", depositoAbierto(ar("2026-10-07T19:30:00Z")), false);
igual("depósito: sábado 10:00 cerrado", depositoAbierto(ar("2026-10-10T13:00:00Z")), false);
igual("depósito: domingo 10:00 cerrado", depositoAbierto(ar("2026-10-11T13:00:00Z")), false);
igual("depósito: viernes 13:00 abierto", depositoAbierto(ar("2026-10-09T16:00:00Z")), true);
igual("depósito: feriado cerrado aunque sea día y hora hábil", depositoAbierto(ar("2026-10-07T13:00:00Z"), ["2026-10-07"]), false);
igual("depósito: 23:30 del martes en UTC ya es miércoles 20:30 AR: cerrado", depositoAbierto(ar("2026-10-07T23:30:00Z")), false);

// Anulación, respuesta a un aviso y pedidos cerrados de quien RETIRA (Pablo, 16/10, corrida 17, auditoría 862): nunca «sale», «listo para salir» ni «entregados».
igual("anular retiro facturado (m16, mp03)", estadoParaAnular("facturado", "2026-10-20", true), "ya está facturado y listo para retirar desde el martes 20/10");
igual("anular retiro programado", estadoParaAnular("programado", "2026-10-20", true), "ya está programado para el martes 20/10");
igual("anular retiro en preparación", estadoParaAnular("en preparacion", "2026-10-20", true), "ya está en preparación en el depósito; va a estar listo para retirar desde el martes 20/10");
igual("anular retiro recibido: igual que antes", estadoParaAnular("recibido", null, true), "todavía no entró en preparación");
igual("anular reparto facturado: igual que antes", estadoParaAnular("facturado", "2026-10-20", false), "ya está facturado y listo para salir");
igual("anular reparto programado: igual que antes", estadoParaAnular("programado", "2026-10-20", false), "ya está programado (sale el martes 20/10)");
igual("anular reparto programado sin fecha", estadoParaAnular("programado", null, false), "ya está programado");
for (const e of ["programado", "en preparacion", "facturado"]) igual(`anular retiro: ningún estado dice 'sal' (${e})`, /sal(e|ir|i[óo])\b/i.test(estadoParaAnular(e, "2026-10-20", true)), false);
igual("lista para anular, retiro facturado", lineaParaAnular("facturado", "2026-10-20", true), "facturado y listo para retirar desde el martes 20/10");
igual("lista para anular, reparto programado: igual que antes", lineaParaAnular("programado", "2026-10-20", false), "programado, sale el martes 20/10");
igual("lista para anular, recibido", lineaParaAnular("recibido", null, true), "recibido, todavía sin fecha de salida");
igual("tras aviso, retiro facturado", textoEstadoTrasAviso(" del 15/10", "facturado", "2026-10-20", true), "Tu pedido del 15/10 está facturado y listo para retirar desde el martes 20/10. Cualquier cambio te avisamos por este medio.");
igual("tras aviso, retiro entregado = retirado", textoEstadoTrasAviso(" del 15/10", "entregado", "2026-10-20", true), "Tu pedido del 15/10 figura como retirado el martes 20/10.");
igual("tras aviso, retiro sin fecha", textoEstadoTrasAviso(" del 15/10", "recibido", null, true), "Tu pedido del 15/10 está recibido y todavía no tiene fecha para retirar. Te avisamos por este medio apenas la tenga.");
igual("tras aviso, reparto programado: igual que antes", textoEstadoTrasAviso(" del 15/10", "programado", "2026-10-20", false), "Tu pedido del 15/10 está programado y sale el martes 20/10. Cualquier cambio te avisamos por este medio.");
igual("tras aviso, reparto entregado: igual que antes", textoEstadoTrasAviso("", "entregado", "2026-10-20", false), "Tu pedido figura como entregado el martes 20/10. Si no lo recibiste, avisanos por este medio y lo revisamos.");
igual("cerrados: todos retiro", palabraCerrados([true, true]), "retirados");
igual("cerrados: ninguno retiro", palabraCerrados([false]), "entregados");
igual("cerrados: mezcla", palabraCerrados([true, false]), "entregados o retirados");
igual("demás cerrados de quien retira (m14, m68)", textoDemasCerrados([true, true, true]), "Los demás pedidos ya están retirados. ");
igual("demás cerrados: ninguno oculto", textoDemasCerrados([]), "");
igual("Chef: lista con otro pedido retirado oculto dice «retirados»", (textoPedidosChef("Chef", [ped({}), ped({ creado: "2026-09-01T15:00:00Z", estado: "entregado", entregado_at: "2026-09-05", fecha_entrega: "2026-09-05", retiro: "2026-09-05" })], "2026-10-05") ?? "").includes("Los demás pedidos ya están retirados."), true);
igual("Chef: todos retirados", (textoPedidosChef("Chef", [ped({ estado: "entregado", entregado_at: "2026-09-05", fecha_entrega: "2026-09-05", retiro: "2026-09-05" })], "2026-10-05") ?? "").includes("todos tus pedidos de Chef están retirados. El último, del 30/09, se retiró el sábado 05/09"), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
