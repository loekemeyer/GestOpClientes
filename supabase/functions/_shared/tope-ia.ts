// Aviso al cliente cuando pasa el tope de consultas de IA por hora (Pablo Olejavetzky, 06/10/2026: "tendríamos que tener algún
// mensaje de cooldown, porque puede ser algún error del cliente"). Hasta acá el aviso decía "Estamos con problemas en este momento,
// probá contactarte de vuelta en una hora": sonaba a falla del sistema, no decía cuánto esperar y, como el tope se reinicia a la hora en
// punto, el "en una hora" podía ser falso (a las 10:59 faltaba 1 minuto).
//
// El contador (`wa_check_rate_limit`, sql/012) cuenta por HORA DE RELOJ: la ventana se reinicia a la hora en punto. Por eso la espera
// real es "hasta la próxima hora en punto", y es lo que se le dice al cliente.
//
// El texto es editable desde el Panel (app_settings.wa_rate_limit_msg). Variables, con el estándar {{snake_case}}:
//   {{limite}}  consultas por hora permitidas (20)
//   {{espera}}  cuánto falta, con unidad: "1 minuto" / "25 minutos"
//   {{hora}}    a qué hora se reinicia, hora de Argentina: "15:00"
// Un texto guardado sin variables se manda tal cual. Lógica pura, sin red: se prueba en tests/tope-ia.test.ts.

export const TOPE_MSG_DEFAULT =
  "Recibimos muchas consultas seguidas desde este número (el máximo es {{limite}} por hora), así que hacemos una pausa. " +
  "Podés volver a escribirnos en {{espera}}, a partir de las {{hora}}. Si fue sin querer, no te preocupes: se reactiva solo.";

const HORA_MS = 3_600_000;
const OFFSET_ART_MS = -3 * HORA_MS; // Argentina, UTC-3 todo el año (igual que horario.ts)

/** Cuánto falta para la próxima hora en punto (donde se reinicia el contador) y a qué hora ART cae. */
export function esperaHastaProximaHora(ahora: Date): { minutos: number; hora: string; espera: string } {
  const resto = HORA_MS - (ahora.getTime() % HORA_MS); // 1 ms … 3.600.000 ms
  const minutos = Math.max(1, Math.ceil(resto / 60_000));
  const proxima = new Date(ahora.getTime() + resto + OFFSET_ART_MS); // "ms locales": se leen con getUTC*
  const hora = `${String(proxima.getUTCHours()).padStart(2, "0")}:00`;
  return { minutos, hora, espera: minutos === 1 ? "1 minuto" : `${minutos} minutos` };
}

/** Arma el aviso. `plantilla` es lo guardado en el Panel (vacío o sólo espacios → el texto por defecto). */
export function mensajeTope(plantilla: string | null | undefined, limite: number, ahora: Date): string {
  const base = (plantilla ?? "").trim() || TOPE_MSG_DEFAULT;
  const e = esperaHastaProximaHora(ahora);
  const valores: Record<string, string> = { limite: String(limite), espera: e.espera, hora: e.hora };
  return base.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => valores[k] ?? m);
}
