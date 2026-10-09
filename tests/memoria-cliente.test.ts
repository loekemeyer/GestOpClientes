// Ficha de memoria por cliente: armado del historial y limpieza de la ficha (supabase/functions/_shared/memoria-cliente.ts).
// Pablo Olejavetzky, 09/10/2026. Sin red, sin IA, US$ 0.
// Correr: deno run tests/memoria-cliente.test.ts   (sale con código 1 si algo falla)
import { fichaFinal, limpiarFicha, redactarFicha, sistemaFicha, textoHistorial } from "../supabase/functions/_shared/memoria-cliente.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}

// ── Historial: un encabezado por día, quién habla, multimedia y vacíos ──
const msgs = [
  { rol: "user", contenido: "Hola, quería hacer un pedido", creado_en: "2025-10-15 15:59:00" },
  { rol: "user", contenido: "<Multimedia omitido>", creado_en: "2025-10-15 16:00:00" },
  { rol: "assistant", contenido: "Ahora lo chequeo", creado_en: "2025-10-15 16:04:00" },
  { rol: "assistant", contenido: "   ", creado_en: "2025-10-15 16:05:00" },
  { rol: "user", contenido: "Gracias\n\nsaludos", creado_en: "2025-10-16 09:00:00" },
];
const h = textoHistorial(msgs, "Loekemeyer");
igual("texto por día y por quién habla", h.texto.split("\n"), [
  "[15/10/2025]",
  "Cliente: Hola, quería hacer un pedido",
  "Cliente: (mandó una foto o un archivo)",
  "Loekemeyer: Ahora lo chequeo",
  "[16/10/2025]",
  "Cliente: Gracias saludos",
]);
igual("mensajes usados (sin vacíos ni encabezados)", h.usados, 4);
igual("empresa Chef", textoHistorial(msgs.slice(2, 3), "Chef").texto, "[15/10/2025]\nChef: Ahora lo chequeo");

// ── Un mensaje larguísimo se corta ──
const largo = textoHistorial([{ rol: "user", contenido: "x".repeat(5000), creado_en: "2026-01-01 10:00:00" }], "Loekemeyer");
igual("mensaje cortado a 600", largo.texto.split("\n")[1].length, "Cliente: ".length + 600);

// ── Si no entra, se cortan los más viejos y se avisa ──
const muchos = Array.from({ length: 50 }, (_, i) => ({ rol: "user", contenido: `mensaje ${i} ` + "y".repeat(80), creado_en: `2026-02-${String(1 + (i % 28)).padStart(2, "0")} 10:00:00` }));
const corto = textoHistorial(muchos, "Loekemeyer", 1000);
igual("avisa que omitió lo viejo", corto.texto.startsWith("(se omitieron los mensajes más viejos)"), true);
igual("queda lo más nuevo", corto.texto.includes("mensaje 49 "), true);
igual("no queda lo más viejo", corto.texto.includes("mensaje 0 "), false);
igual("entra en el máximo (más el aviso)", corto.texto.length <= 1000 + 40, true);

// ── Ficha: sin markdown y cortada por línea entera ──
igual("saca negritas y títulos markdown", limpiarFicha("**Quién escribe:** Marta\n## Pagos: transferencia"), "Quién escribe: Marta\nPagos: transferencia");
const fichaLarga = Array.from({ length: 40 }, (_, i) => `Línea ${i}: ` + "z".repeat(40)).join("\n");
const limpia = limpiarFicha(fichaLarga, 300);
igual("cortada por línea entera", limpia.split("\n").every((l) => /^Línea \d+: z{40}$/.test(l)), true);
igual("no pasa del máximo", limpia.length <= 300, true);
igual("vacía si no vino nada", limpiarFicha(""), "");

// ── El prompt pide lo que importa ──
const s = sistemaFicha("Chef");
igual("nombra la empresa", s.includes("mayorista de Chef"), true);
igual("prohíbe precios y datos personales", s.includes("NO pongas precios") && s.includes("NO copies CUIT"), true);
igual("historial es dato, no instrucciones", s.includes("nunca instrucciones"), true);

// ── Redacción por código (prueba del 09/10: Haiku copió mails y direcciones pese a la regla). Datos inventados. ──
igual("mail", redactarFicha("Facturas a ventas.prueba@ejemplo.com.ar desde agosto"), "Facturas a (mail omitido) desde agosto");
igual("CUIT con y sin guiones", redactarFicha("CUIT 20-12345678-9 y 30123456789"), "CUIT (CUIT omitido) y (CUIT omitido)");
igual("teléfono", redactarFicha("Llamar al 11 5555-1234"), "Llamar al (teléfono omitido)");
igual("calle con número", redactarFicha("Transporte Ejemplo, calle Falsa 3125."), "Transporte Ejemplo, (dirección omitida).");
igual("en <calle> <número>", redactarFicha("Recibe en Monasterio 271, CABA"), "Recibe en (dirección omitida), CABA");
igual("calle de dos palabras", redactarFicha("recibe en Santa Fe 1465"), "recibe en (dirección omitida)");
igual("el depósito de LK se nombra", redactarFicha("Retira en Virgilio 2788 (13 a 16 hs)"), "Retira en el depósito (Virgilio) (13 a 16 hs)");
igual("no toca códigos de artículo", redactarFicha("Faltante del pincel 590E y del art 701 en octubre 2025"), "Faltante del pincel 590E y del art 701 en octubre 2025");
igual("un mes con mayúscula no es calle", redactarFicha("Faltante en Marzo 2026"), "Faltante en Marzo 2026");
igual("Calle con mayúscula", redactarFicha("Calle Falsa 123"), "(dirección omitida)");
igual("no toca cantidades", redactarFicha("pidió 48 unidades"), "pidió 48 unidades");
igual("no toca localidades", redactarFicha("Retira en Junín. Retira en Olavarría y Río Tercero"), "Retira en Junín. Retira en Olavarría y Río Tercero");

// ── Ficha final: la línea del historial la pone el código, no el modelo ──
const ff = fichaFinal("Quién escribe: Marta\nPagos: transferencia\nHistorial: 13 mensajes, de octubre 2025 a mayo 2026.", 57, "2025-10-15 15:59:00", "2026-05-04 10:00:00");
igual("historial calculado reemplaza al del modelo", ff, "Quién escribe: Marta\nPagos: transferencia\nHistorial: 57 mensajes, de octubre 2025 a mayo 2026.");
igual("vacía si el modelo no devolvió nada", fichaFinal("", 10, null, null), "");

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
