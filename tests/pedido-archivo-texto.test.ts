// El mensaje al cliente cuando manda un cotizador o un pedido por archivo (supabase/functions/_shared/pedido-archivo.ts, textoConfirmacion).
// Pablo Olejavetzky, 06/10/2026 (corrección m41): (1) si los precios coinciden con la web NO se le dice nada, el control es en silencio; sólo se avisa lo que no coincide;
// (2) si el cliente tiene VARIAS direcciones de entrega, se le pregunta para cuál es el pedido ("eso es muy importante").
// Correr: deno run --allow-env --allow-net --allow-read tests/pedido-archivo-texto.test.ts   (sale con código 1 si algo falla)
// pedido-archivo.ts importa _shared/supabase.ts, que arma el cliente al cargar: se le dan una URL y una clave falsas (no se conecta).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "clave-falsa");
const { textoConfirmacion, bloqueSucursales } = await import("../supabase/functions/_shared/pedido-archivo.ts");

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n  real:     ${JSON.stringify(real)}\n  esperado: ${JSON.stringify(esperado)}`); }
}
const arts = [
  { original: "512", cod: "512", descripcion: "Abrelatas Mariposa Capuchon Rojo", product_id: "a", cajas: 5, uxb: 12, estado: "ok" as const },
  { original: "503E", cod: "503E", descripcion: "Abrelatas Doble Engranaje", product_id: "b", cajas: 2, uxb: 12, estado: "ok" as const },
];
const base = "Recibimos tu cotizador. Leímos esto:\n• 5 cajas de Abrelatas Mariposa Capuchon Rojo (cód. 512)\n• 2 cajas de Abrelatas Doble Engranaje (cód. 503E)\n\nForma de pago marcada en el cotizador: *Contado (25%)*.";
const dosDirs = [{ slot: 1, direccion: "Av. Siempreviva 742, Springfield", tipo: "reparto propio" }, { slot: 2, direccion: "Calle Falsa 123, Shelbyville", tipo: "por expreso Vesprini" }];

// Todo coincide: exactamente el mensaje que mandó Pablo, sin ninguna aclaración de que coincide.
igual("coincide: no dice nada de los precios, pregunta artículos y valores", textoConfirmacion(arts, { cotizador: true, seguir: true, condicion_code: 8, comparacion: { texto: "", hayDiferencias: false } }),
  base + "\n\n¿Confirmás los artículos y los valores? Respondé *sí* y seguimos con la forma de pago y la entrega, o decinos qué cambiar.");
igual("no menciona 'coinciden' ni el total", /coinciden|Total que figura|✅/.test(textoConfirmacion(arts, { cotizador: true, seguir: true, condicion_code: 8, comparacion: { texto: "", hayDiferencias: false } })), false);
// Con una sola dirección no se pregunta nada de sucursales.
igual("una sola dirección: no pregunta sucursal", textoConfirmacion(arts, { cotizador: true, seguir: true, condicion_code: 8, comparacion: { texto: "", hayDiferencias: false }, sucursales: [dosDirs[0]] }).includes("direcciones"), false);
igual("sin direcciones: no pregunta sucursal", bloqueSucursales([]), "");
// Con diferencias: se avisa y se pide confirmar los valores de la web.
const aviso = "💰 Ojo, tu cotizador puede estar desactualizado: estos valores no coinciden con los de la web.\n• Abrelatas Mariposa Capuchon Rojo (cód. 512): en tu cotizador $22.200 por caja; en la web $46.080 por caja.\nTotal que figura en tu cotizador: $172.695,60 (con sus precios).";
igual("con diferencia: avisa y pide confirmar los valores de la web", textoConfirmacion(arts, { cotizador: true, seguir: true, condicion_code: 8, comparacion: { texto: aviso, hayDiferencias: true } }),
  base + "\n\n" + aviso + "\n\n¿Confirmás los artículos y los valores de la web? Respondé *sí* y seguimos con la forma de pago y la entrega, o decinos qué cambiar.");
// Varias direcciones: pregunta para cuál es (con el número = slot) y pide el número en la respuesta.
const conSuc = textoConfirmacion(arts, { cotizador: true, seguir: true, condicion_code: 8, comparacion: { texto: "", hayDiferencias: false }, sucursales: dosDirs });
igual("varias direcciones: las lista con su número", conSuc.includes("📍 Tu cuenta tiene 2 direcciones de entrega. *¿Para cuál es este pedido?*\n1) Av. Siempreviva 742, Springfield (reparto propio)\n2) Calle Falsa 123, Shelbyville (por expreso Vesprini)"), true);
igual("varias direcciones: pide el número y confirma artículos y valores", conSuc.endsWith("Respondé el número de la dirección y, si los artículos y los valores están bien, seguimos con la forma de pago. O decinos qué cambiar."), true);
igual("varias direcciones con diferencia: pide los valores de la web", textoConfirmacion(arts, { cotizador: true, seguir: true, comparacion: { texto: aviso, hayDiferencias: true }, sucursales: dosDirs }).endsWith("si los artículos y los valores de la web están bien, seguimos con la forma de pago. O decinos qué cambiar."), true);
igual("varias direcciones sin comparación (foto o PDF): sólo los artículos", textoConfirmacion(arts, { seguir: true, sucursales: dosDirs }).endsWith("si los artículos están bien, seguimos con la forma de pago. O decinos qué cambiar."), true);
igual("pedidos por WhatsApp apagados: una persona lo carga", textoConfirmacion(arts, { cotizador: true, seguir: false, comparacion: { texto: "", hayDiferencias: false }, sucursales: dosDirs }).endsWith("Respondé el número de la dirección y *sí* si los artículos y los valores están bien, y una persona lo carga. O decinos qué cambiar."), true);
// Muchas direcciones (hay cuentas con 19): se corta la lista.
const muchas = Array.from({ length: 19 }, (_, i) => ({ slot: i + 1, direccion: `Calle ${i + 1}`, tipo: "reparto propio" }));
const b = bloqueSucursales(muchas);
igual("19 direcciones: lista 12 y avisa que hay más", b.split("\n").length === 14 && b.endsWith("… y 7 más: decinos la dirección."), true);
// Líneas con duda (❓): la pregunta de la dirección también va.
const dudosa = [{ original: "abrelatas", cod: null, descripcion: null, product_id: null, cajas: 2, uxb: null, estado: "dudoso" as const, opciones: [{ cod: "501", descripcion: "Abrelatas A Manija" }, { cod: "512", descripcion: "Abrelatas Mariposa" }] }];
const t3 = textoConfirmacion(dudosa, { seguir: true, sucursales: dosDirs });
igual("con ❓ y varias direcciones: pregunta cuál artículo y el número de la dirección", t3.includes("📍 Tu cuenta tiene 2 direcciones") && t3.includes("el número de la dirección"), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo bien");
