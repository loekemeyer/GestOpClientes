// Aviso de auditoría cuando un archivo del cliente trae texto que parece una orden para el bot (Pablo Olejavetzky, 07/10/2026: "agregá el escaneo del texto crudo y que
// mande aviso a algún sector dentro del dashboard para auditoría"). Módulo PURO (sin red ni base): se prueba en tests/archivo-sospechoso.test.ts.
//
// POR QUÉ: la IA que lee el archivo ya tiene la orden de ignorar lo que el archivo diga, y en la prueba del 07/10 la cumplió las 3 veces: sacó la orden en silencio.
// Para el pedido está bien, pero el equipo no se enteraba de que un cliente (o alguien que le pasó el archivo) escondió una orden en una planilla. El escaneo del
// texto crudo (dato-externo.ts › escanearTexto) no depende de lo que haga el modelo: si salta, se crea esta alerta.
//
// DÓNDE SE VE: Centro de mensajes › Tareas, en el sector "Auditoría" (docs/gestop2.js). Va sólo al dashboard: no abre tarea en Planify salvo que alguien lo elija en
// Configuración › Derivaciones (motivo `archivo_sospechoso`, mismo mecanismo que el resto). Es un aviso para mirar, no para contestar: semáforo verde, vence a las 24 h.
//
// QUÉ NO CUBRE: fotos y PDF (el código no ve su texto antes de la IA), ni la planilla "Conversor a ERP" del cotizador (se lee sin IA y sólo acepta códigos y cantidades).
import { type EscaneoTexto, lineaSegura } from "./dato-externo.ts";

/** Motivo y origen de la alerta. */
export const MOTIVO_ARCHIVO_SOSPECHOSO = "archivo_sospechoso";

/** Una alerta de éstas por número y por hora: alguien que manda 30 archivos seguidos no inunda la bandeja. El archivo de pedido sigue llevando su propia marca. */
export const VENTANA_AVISO_MS = 3_600_000;

/** Qué hizo la IA con la orden: "descarto" = ninguna línea de lo que devolvió la trae · "copio" = la devolvió en una línea (ya marcada como sospechosa y sin mostrarse al cliente). */
export type QueHizoLaIA = "descarto" | "copio";

export interface EntradaAlertaArchivo {
  archivo: string | null | undefined;
  escaneo: EscaneoTexto;
  /** `true` si alguna línea que devolvió la IA quedó marcada como `sospechosa`. */
  iaLaCopio: boolean;
  razonSocial?: string | null;
  /** La fila de `wa_comprobantes` donde quedó guardado el archivo: es lo que le da al dashboard el botón "Ver archivo original". */
  comprobanteId?: string | null;
}

/** Contexto de la alerta (`wa_alertas_humano.contexto`). Todo lo que viene del archivo pasa por `lineaSegura`: una sola línea, sin enlaces, corchetes ni etiquetas. */
export function contextoAlertaArchivo(e: EntradaAlertaArchivo): Record<string, unknown> {
  const ia: QueHizoLaIA = e.iaLaCopio ? "copio" : "descarto";
  return {
    motivo: MOTIVO_ARCHIVO_SOSPECHOSO,
    origen: MOTIVO_ARCHIVO_SOSPECHOSO,
    urgente: false,
    razon_social: e.razonSocial ?? null,
    ...(e.comprobanteId ? { comprobante_id: e.comprobanteId } : {}),
    archivo_sospechoso: {
      archivo: lineaSegura(e.archivo, 120) || null,
      motivos: e.escaneo.motivos.slice(0, 9).map((m) => lineaSegura(m, 80)),
      fragmentos: e.escaneo.fragmentos.slice(0, 3).map((f) => lineaSegura(f, 120)),
      cruzado: e.escaneo.cruzado === true,
      ia,
    },
  };
}
