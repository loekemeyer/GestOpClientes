// Ficha de memoria por cliente: armado del historial y limpieza de la ficha (supabase/functions/_shared/memoria-cliente.ts).
// Pablo Olejavetzky, 09/10/2026. Sin red, sin IA, US$ 0.
// Correr: deno run tests/memoria-cliente.test.ts   (sale con código 1 si algo falla)
import { limpiarFicha, sistemaFicha, textoHistorial } from "../supabase/functions/_shared/memoria-cliente.ts";

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

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
