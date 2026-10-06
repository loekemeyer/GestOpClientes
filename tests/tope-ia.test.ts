// Pruebas del aviso de tope de consultas de IA (supabase/functions/_shared/tope-ia.ts). Lógica pura, sin red.
// Correr: deno run tests/tope-ia.test.ts   (sale con código 1 si algo falla)
import { contextoAlertaTope, esperaHastaProximaHora, mensajeTope, TOPE_MSG_DEFAULT } from "../supabase/functions/_shared/tope-ia.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const utc = (s: string) => new Date(s);

// ── Espera hasta la próxima hora en punto (el contador se reinicia ahí) ──
igual("17:15 UTC → faltan 45 min, reinicia 15:00 ART", esperaHastaProximaHora(utc("2026-10-06T17:15:00Z")), { minutos: 45, hora: "15:00", espera: "45 minutos" });
igual("17:59:30 → 1 minuto (se redondea para arriba)", esperaHastaProximaHora(utc("2026-10-06T17:59:30Z")), { minutos: 1, hora: "15:00", espera: "1 minuto" });
igual("17:00:00 justo → 60 minutos", esperaHastaProximaHora(utc("2026-10-06T17:00:00Z")), { minutos: 60, hora: "15:00", espera: "60 minutos" });
igual("17:00:01 → 60 minutos (59,98 sube a 60)", esperaHastaProximaHora(utc("2026-10-06T17:00:01Z")).minutos, 60);
igual("17:58:00 → 2 minutos", esperaHastaProximaHora(utc("2026-10-06T17:58:00Z")).espera, "2 minutos");
igual("02:30 UTC → reinicia 00:00 ART (cruce de medianoche local)", esperaHastaProximaHora(utc("2026-10-06T02:30:00Z")), { minutos: 30, hora: "00:00", espera: "30 minutos" });
igual("03:10 UTC → reinicia 01:00 ART", esperaHastaProximaHora(utc("2026-10-06T03:10:00Z")).hora, "01:00");
igual("23:40 UTC → reinicia 21:00 ART", esperaHastaProximaHora(utc("2026-10-06T23:40:00Z")).hora, "21:00");

// ── Mensaje ──
const m = mensajeTope(null, 20, utc("2026-10-06T17:15:00Z"));
igual("default: sin variables sin reemplazar", m.includes("{{"), false);
igual("default: dice el máximo, la espera y la hora", [m.includes("20 por hora"), m.includes("en 45 minutos"), m.includes("las 15:00")], [true, true, true]);
igual("default: ya no dice 'problemas en este momento'", m.includes("problemas"), false);
igual("vacío → default", mensajeTope("", 20, utc("2026-10-06T17:15:00Z")), m);
igual("sólo espacios → default", mensajeTope("   \n ", 20, utc("2026-10-06T17:15:00Z")), m);
igual("undefined → default", mensajeTope(undefined, 20, utc("2026-10-06T17:15:00Z")), m);
igual("personalizado con variables", mensajeTope("Tope de {{limite}}. Volvé en {{espera}} ({{hora}} h).", 30, utc("2026-10-06T17:59:30Z")), "Tope de 30. Volvé en 1 minuto (15:00 h).");
igual("variables con espacios {{ espera }}", mensajeTope("En {{ espera }}", 20, utc("2026-10-06T17:15:00Z")), "En 45 minutos");
igual("variable repetida se reemplaza todas las veces", mensajeTope("{{hora}} / {{hora}}", 20, utc("2026-10-06T17:15:00Z")), "15:00 / 15:00");
igual("texto viejo guardado, sin variables: sale tal cual", mensajeTope("Estamos con problemas en este momento, probá contactarte de vuelta en una hora.", 20, utc("2026-10-06T17:15:00Z")), "Estamos con problemas en este momento, probá contactarte de vuelta en una hora.");
igual("variable desconocida queda visible (se nota en el chat de prueba)", mensajeTope("Hola {{nombre}}", 20, utc("2026-10-06T17:15:00Z")), "Hola {{nombre}}");
igual("el default tiene exactamente las 3 variables conocidas", (TOPE_MSG_DEFAULT.match(/\{\{[a-z_]+\}\}/g) ?? []).sort(), ["{{espera}}", "{{hora}}", "{{limite}}"]);
igual("el default entra holgado en un mensaje de WhatsApp (< 400 caracteres)", TOPE_MSG_DEFAULT.length < 400, true);

// ── Alerta para una persona (motivo tope_ia) ──
const c = contextoAlertaTope(20, "necesito 50 cajas del 501", "Bazar Farimar", utc("2026-10-06T17:15:00Z"));
igual("alerta: motivo tope_ia y límite", [c.motivo, c.limite], ["tope_ia", 20]);
igual("alerta: dice a qué hora vuelve a poder escribir", String(c.detalle).includes("a las 15:00"), true);
igual("alerta: dice el máximo", String(c.detalle).includes("máximo de 20 consultas por hora"), true);
igual("alerta: guarda el último mensaje y la razón social", [c.texto_recibido, c.razon_social], ["necesito 50 cajas del 501", "Bazar Farimar"]);
igual("alerta: el último mensaje se corta a 200 caracteres", String(contextoAlertaTope(20, "x".repeat(500), null, utc("2026-10-06T17:15:00Z")).texto_recibido).length, 200);
igual("alerta: sin razón social queda null", contextoAlertaTope(20, "hola", undefined, utc("2026-10-06T17:15:00Z")).razon_social, null);
igual("alerta: texto vacío no rompe", contextoAlertaTope(20, undefined as unknown as string, null, utc("2026-10-06T17:15:00Z")).texto_recibido, "");
igual("alerta: no fija 'urgente' (lo decide notificarHumano por el texto)", "urgente" in c, false);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
