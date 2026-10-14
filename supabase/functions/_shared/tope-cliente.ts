// Tope de gasto de IA POR CLIENTE (Pablo Olejavetzky, 14/10/2026: "el tope va a ser 2 USD por cliente por día, 5 USD por semana"). Segunda de las dos
// capas acordadas; la otra es el medidor mensual del pozo (_shared/presupuesto-ia.ts).
//
// Qué cuida y en qué se diferencia de las otras dos:
//   • tope-gasto.ts  = corte DIARIO GLOBAL (la suma de TODOS los clientes). Frena al agente para todos ese día.
//   • presupuesto-ia = MEDIDOR MENSUAL del pozo. Sólo avisa, no corta.
//   • esto           = corte POR CLIENTE. Frena a UN cliente que se dispara (bucle, abuso, un archivo enorme), sin tocar a los demás.
//
// Qué cuenta: lo que gastó ESE teléfono en la ventana (bot_token_usage con function_name = lk_whatsapp-webhook y ese phone). El día y la semana son los
// de Argentina (la semana arranca el lunes 00:00). Dos topes a la vez: salta el que se cruce primero.
//
// ⚠ Los dos números se pisan a propósito (se lo marqué a Pablo, los dejó así): US$ 2/día pero US$ 5/semana significa que con 3 días llenos (US$ 6) ya
// se pasó la semana, así que el semanal corta antes que el diario en casi todos los casos. El diario queda como sub-límite para una explosión en un
// solo día. Si se quiere que el diario pese por sí solo, el semanal tiene que ser >= 7 x el diario.
//
// Qué hace al cortar: a ese cliente NO se le llama al agente; recibe el mismo aviso fijo que el tope diario (MSG_TOPE_GASTO, sin montos) y se deja UNA
// alerta para una persona, una vez por día por teléfono (igual que el tope diario). Las FAQ y los flujos sin IA siguen contestando.
//
// Se cambia sin deploy en app_settings: `ia_tope_cliente_dia_usd` (defecto 2; 0 apaga el diario) y `ia_tope_cliente_semana_usd` (defecto 5; 0 apaga el
// semanal). Los dos en 0 apagan la capa entera. Módulo PURO (sin red ni base). Se prueba en tests/tope-cliente.test.ts.

import { inicioDiaArgentina } from "./tope-gasto.ts";

export const TOPE_CLIENTE_DIA_USD_DEFAULT = 2;
export const TOPE_CLIENTE_SEMANA_USD_DEFAULT = 5;

const HORA_MS = 3_600_000;
const OFFSET_ART_MS = -3 * HORA_MS; // Argentina, UTC-3 todo el año
const DIA_MS = 86_400_000;

export type NivelCliente = "ok" | "tope";
export type LimiteCliente = "dia" | "semana";
export interface TopesCliente { dia: number; semana: number }

/** Instante (ms UTC) del lunes 00:00 ART de la semana a la que pertenece `ahoraMs`. Se apoya en inicioDiaArgentina (00:00 ART de hoy) y retrocede hasta el lunes. */
export function inicioSemanaArgentina(ahoraMs: number): number {
  const iniDia = inicioDiaArgentina(ahoraMs); // 00:00 ART de hoy, en ms UTC
  const local = new Date(iniDia + OFFSET_ART_MS); // "fecha local" de ese 00:00
  const dow = local.getUTCDay(); // 0 = domingo … 6 = sábado
  const desdeLunes = (dow + 6) % 7; // lunes = 0, domingo = 6
  return iniDia - desdeLunes * DIA_MS;
}

/** Un monto de app_settings: acepta "2", "2.5" y "2,5". Vacío, ausente, no numérico o negativo → el valor por defecto. 0 es válido (apaga ese tope). */
function monto(crudo: unknown, porDefecto: number): number {
  if (crudo === null || crudo === undefined) return porDefecto;
  const t = String(crudo).trim().replace(",", ".");
  if (!t) return porDefecto;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
}

/** Los topes por cliente guardados en app_settings (`ia_tope_cliente_dia_usd`, `ia_tope_cliente_semana_usd`). */
export function topesClienteDeSettings(diaCrudo: unknown, semanaCrudo: unknown): TopesCliente {
  return { dia: monto(diaCrudo, TOPE_CLIENTE_DIA_USD_DEFAULT), semana: monto(semanaCrudo, TOPE_CLIENTE_SEMANA_USD_DEFAULT) };
}

/**
 * ¿El cliente pasó algún tope? Un tope en 0 está apagado y no cuenta. Si cruzó los dos, se reporta `semana` (es el más chico/más significativo: cuida el
 * acumulado, no un pico de un día). El webhook lee el gasto del día y de la semana de ESE teléfono y llama acá.
 */
export function nivelClienteGasto(gastoDia: number, gastoSemana: number, t: TopesCliente): { nivel: NivelCliente; limite: LimiteCliente | null } {
  const topeSemana = t.semana > 0 && gastoSemana >= t.semana;
  const topeDia = t.dia > 0 && gastoDia >= t.dia;
  if (topeSemana) return { nivel: "tope", limite: "semana" };
  if (topeDia) return { nivel: "tope", limite: "dia" };
  return { nivel: "ok", limite: null };
}

const usd = (n: number) => (Math.round(n * 100) / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Contexto de la alerta para una persona. Reusa el motivo `tope_gasto` (misma categoría, semáforo y destino en Derivaciones que el gasto diario) con
 * `nivel: "cliente"` y `limite` ("dia" | "semana"), así no hace falta un motivo nuevo. No se marca urgente: un cliente solo no amenaza el pozo.
 */
export function contextoAlertaCliente(
  limite: LimiteCliente, gastoDia: number, gastoSemana: number, t: TopesCliente, texto: string, razonSocial: string | null | undefined,
): Record<string, unknown> {
  const detalle = limite === "semana"
    ? `Este cliente ya gastó US$ ${usd(gastoSemana)} de IA esta semana (el tope por cliente es US$ ${usd(t.semana)}/semana). El agente no le ` +
      "contesta más hasta el lunes y recibió un aviso fijo: mirá el chat y contestale vos. A los demás clientes el agente les sigue contestando."
    : `Este cliente ya gastó US$ ${usd(gastoDia)} de IA hoy (el tope por cliente es US$ ${usd(t.dia)}/día). El agente no le contesta más hasta las ` +
      "00:00 y recibió un aviso fijo: mirá el chat y contestale vos. A los demás clientes el agente les sigue contestando.";
  return {
    motivo: "tope_gasto",
    nivel: "cliente",
    limite,
    gasto_dia_usd: Math.round(gastoDia * 10_000) / 10_000,
    gasto_semana_usd: Math.round(gastoSemana * 10_000) / 10_000,
    tope_dia_usd: t.dia,
    tope_semana_usd: t.semana,
    detalle,
    texto_recibido: String(texto ?? "").slice(0, 200),
    razon_social: razonSocial ?? null,
  };
}
