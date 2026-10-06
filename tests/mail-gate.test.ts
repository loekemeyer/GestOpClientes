// Pruebas de la compuerta de solicitar_cambio_mail (supabase/functions/_shared/mail-gate.ts). Sin red, sin IA.
// Correr: deno run tests/mail-gate.test.ts   (sale con código 1 si algo falla)
import { mailEscritoPorElCliente, mailsEscritos, normalizarMail, REGLA_MAIL_NO_ESCRITO, VIGENCIA_MAIL_MS } from "../supabase/functions/_shared/mail-gate.ts";

let fallas = 0;
function igual(nombre: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`ok   ${nombre}`);
  else { fallas++; console.error(`FALLA ${nombre}\n   real:     ${a}\n   esperado: ${b}`); }
}
const AHORA = Date.parse("2026-10-06T19:00:00Z");
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();
const fila = (rol: string, contenido: string, min: number) => ({ rol, contenido, creado_en: hace(min) });
const va = (mail: string, textoCliente: string, historial: ReturnType<typeof fila>[]) => mailEscritoPorElCliente({ mail, textoCliente, historial, ahora: AHORA });

// ── Leer mails de un texto ──
igual("lee un mail suelto", mailsEscritos("juan@gmail.com"), ["juan@gmail.com"]);
igual("lo pasa a minúsculas", mailsEscritos("Mi mail es JUAN.Perez@Gmail.COM"), ["juan.perez@gmail.com"]);
igual("el punto final de la oración no es del mail", mailsEscritos("Mandalo a juan@gmail.com."), ["juan@gmail.com"]);
igual("entre signos", mailsEscritos("(juan@gmail.com), <ana@x.com.ar>; ¿bueno?"), ["juan@gmail.com", "ana@x.com.ar"]);
igual("sin repetir", mailsEscritos("juan@gmail.com y otra vez JUAN@gmail.com"), ["juan@gmail.com"]);
igual("sin mail: vacío", mailsEscritos("Te envío la correcta para que puedan reemplazarla"), []);
igual("una arroba suelta no es un mail", mailsEscritos("escribime a @juan o a juan@ o a juan@gmail"), []);
igual("normalizar: mailto: y espacios", normalizarMail("  mailto:Juan@Gmail.com "), "juan@gmail.com");

// ── Pasa: lo escribió el cliente ──
igual("ok: está en el mensaje de ahora", va("juan@gmail.com", "Cambiame el mail a juan@gmail.com", []), true);
igual("ok: sin importar mayúsculas", va("juan@gmail.com", "mi mail nuevo: JUAN@GMAIL.COM", []), true);
igual("ok: lo escribió antes y ahora confirma con un sí",
  va("juan@gmail.com", "sí", [fila("user", "sí", 0), fila("assistant", "¿Cambio tu mail a juan@gmail.com?", 1), fila("user", "quiero cambiar mi mail a juan@gmail.com", 2)]), true);
igual("ok: el mensaje de ahora ya está guardado y tiene el mail", va("juan@gmail.com", "es juan@gmail.com", [fila("user", "es juan@gmail.com", 0)]), true);
igual("ok: varios mails en un mensaje, el pedido es uno de ellos", va("ana@x.com.ar", "el viejo era juan@gmail.com, el nuevo ana@x.com.ar", []), true);
igual("ok: con punto final y mailto:", va("mailto:juan@gmail.com", "mandalo a juan@gmail.com.", []), true);
igual("ok: justo dentro de la vigencia", va("juan@gmail.com", "sí", [fila("user", "juan@gmail.com", VIGENCIA_MAIL_MS / 60_000 - 1)]), true);

// ── Bloquea: lo inventó el modelo (el caso 9.4 / m76 del 06/10) ──
const M76 = "Acabo de cargar un pedido en la web y noté que está cargada una dirección de correo que ya no tengo. Te envío la correcta para que puedan reemplazarla";
igual("BLOQUEA: m76, mail inventado con la razón social (corrida 1)", va("contacto@garbarinofranco.com.ar", M76, []), false);
igual("BLOQUEA: m76, mail inventado con la razón social (corrida 2)", va("garbarinofrancotomas@gmail.com", M76, [fila("user", M76, 0)]), false);
igual("BLOQUEA: sin historial ni mensaje con mail", va("juan@gmail.com", "", []), false);
igual("BLOQUEA: mail vacío", va("", "juan@gmail.com", []), false);
igual("BLOQUEA: el mail sólo aparece en lo que dijo el bot",
  va("juan@gmail.com", "sí", [fila("user", "sí", 0), fila("assistant", "¿Cambio tu mail a juan@gmail.com?", 1), fila("user", "quiero cambiar mi mail", 2)]), false);
igual("BLOQUEA: otra letra", va("juanx@gmail.com", "juan@gmail.com", []), false);
igual("BLOQUEA: otro dominio", va("juan@hotmail.com", "juan@gmail.com", []), false);
igual("BLOQUEA: dominio más corto que el que escribió", va("juan@gmail.com", "juan@gmail.com.ar", []), false);
igual("BLOQUEA: dominio más largo que el que escribió", va("juan@gmail.com.ar", "juan@gmail.com", []), false);
igual("BLOQUEA: lo escribió hace más de 12 horas", va("juan@gmail.com", "sí", [fila("user", "juan@gmail.com", VIGENCIA_MAIL_MS / 60_000 + 1)]), false);
igual("BLOQUEA: la fecha del mensaje no se lee", va("juan@gmail.com", "sí", [{ rol: "user", contenido: "juan@gmail.com", creado_en: "ayer" }]), false);
igual("BLOQUEA: el mail está en una herramienta o en otro rol", va("juan@gmail.com", "sí", [fila("tool", "juan@gmail.com", 1), fila("system", "juan@gmail.com", 1)]), false);
igual("BLOQUEA: dictado ('arroba') no pasa, hay que pedirle que lo escriba", va("juan@gmail.com", "juan arroba gmail punto com", []), false);

// ── La regla que ve el modelo ──
igual("la regla le dice qué hacer", /nombre@dominio\.com/.test(REGLA_MAIL_NO_ESCRITO) && /No lo armes/.test(REGLA_MAIL_NO_ESCRITO), true);

if (fallas) { console.error(`\n${fallas} falla(s)`); Deno.exit(1); }
console.log("\ntodo ok");
