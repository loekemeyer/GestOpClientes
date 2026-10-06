// Aviso al cliente cuando escribe FUERA del horario de atención y el bot lo pasa a una persona (Pablo Olejavetzky, 06/10/2026:
// "qué pasa si un cliente manda un mensaje un sábado"). Hasta acá el bot contestaba 24/7 y, al derivar, decía "una persona del equipo le
// escribe por acá" sin decir cuándo.
//
// Un solo punto de enganche (en vez de tocar los ~20 lugares que crean alertas): el webhook lo llama DESPUÉS de procesar el mensaje.
//   · Dentro de horario no hace nada ni consulta la base (sólo mira la hora).
//   · Fuera de horario mira si ese mismo turno dejó una alerta que espera a una persona (esperaRespuestaDePersona) y, si sí, manda UN
//     mensaje aparte: "Ahora estamos fuera del horario de atención (…). Tu consulta quedó registrada y te respondemos el lunes desde las 9 h."
//   · Una vez cada 12 h por número, para no repetirlo en cada mensaje de la misma charla.
// El horario sale de app_settings.wa_derivaciones.horario (Configuración › Derivaciones) más los feriados del calendario de Planify (feriados.ts);
// sin nada guardado, lunes a viernes de 9 a 17.
// El envío pasa por el mismo `enviarTexto` del webhook: respeta la llave de envío y la lista de prueba como cualquier respuesta del bot.
import { getSetting, supabase } from "./supabase.ts";
import { categoria } from "./alertas-vencimiento.ts";
import { conCalendario, dentroDeHorario, esperaRespuestaDePersona, leerHorario, PREFIJO_AVISO, textoAviso } from "./horario.ts";
import { cargarCalendario } from "./feriados.ts";

const NO_REPETIR_HORAS = 12;

export async function avisarFueraDeHorario(phone: string, desde: Date, enviar: (texto: string) => Promise<void>): Promise<void> {
  try {
    let guardado: unknown;
    try { guardado = JSON.parse((await getSetting("wa_derivaciones")) ?? "{}")?.horario; } catch { guardado = undefined; }
    // Horario guardado + feriados del calendario de Planify (un lunes feriado es "fuera de horario" aunque sea lunes de 9 a 17).
    const h = conCalendario(leerHorario(guardado), await cargarCalendario());
    const ahora = new Date();
    if (dentroDeHorario(ahora, h)) return;
    // ¿Este turno dejó una alerta que espera una persona? (2 s de margen por el reloj entre la base y la función)
    const { data } = await supabase.from("wa_alertas_humano").select("tipo, contexto")
      .eq("phone", phone).gte("created_at", new Date(desde.getTime() - 2000).toISOString())
      .in("estado", ["pendiente", "notificado"]).limit(10);
    if (!(data ?? []).some((a) => esperaRespuestaDePersona(categoria(a)))) return;
    // Ya se le avisó hace poco → no se repite.
    const { count } = await supabase.from("bot_historial_chat").select("id", { count: "exact", head: true })
      .eq("telefono", phone).eq("rol", "assistant")
      .gte("creado_en", new Date(ahora.getTime() - NO_REPETIR_HORAS * 3_600_000).toISOString())
      .like("contenido", `${PREFIJO_AVISO}%`);
    if ((count ?? 0) > 0) return;
    await enviar(textoAviso(ahora, h));
  } catch (e) {
    // El aviso es un extra: si algo falla no puede tumbar la respuesta que ya salió.
    console.error("[fuera de horario] no se pudo avisar:", e instanceof Error ? e.message : e);
  }
}
