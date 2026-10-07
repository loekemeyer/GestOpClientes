// Pruebas del estado de un pedido que se RETIRA (supabase/functions/_shared/fecha-retiro.ts) y del texto completo de la lista de pedidos (pedidos-marca.ts, textoPedidosChef).
// Pablo Olejavetzky, 06 y 07/10/2026 (correcciones m21, m24, m25, m2, m68): "programado para el lunes 05/10" y, ya facturado, "listo para retirar desde el martes 06/10"; el título dice "que falta retirar".
// Correr: deno run --allow-env tests/fecha-retiro.test.ts   (sale con código 1 si algo falla)
// pedidos-marca.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { textoEstadoRetiro, tituloPorRetiro, tituloConfirmado, pideConfirmacionPedido } = await import("../supabase/functions/_shared/fecha-retiro.ts");
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

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
