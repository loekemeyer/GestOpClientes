// Informes › Proyección de avisos y gasto (dashboard v0.27.0, Pablo 05/10/2026).
//
// Devuelve el informe que arma scripts/proyeccion-avisos (datos agregados de un corte: ver `generado`). NO consulta las bases:
// los números viven en _shared/proyeccion-datos.ts (generado) para que el informe no cargue a PaginaLK ni a Gestión cada vez
// que alguien lo abre, y se rehace a pedido con `node scripts/proyeccion-avisos/generar.mjs`.
// La tarifa sí es viva: app_settings.wa_tarifas (la misma que usa Salientes) pisa la de respaldo.
// Sólo lectura, sin llamadas a Meta ni a la IA. Lo llama lk_conversaciones {action:"proyeccion"} detrás del gate de admin.
import { PROYECCION_DATOS } from "./proyeccion-datos.ts";

type Tarifas = { utility?: number; marketing?: number };

export function proyeccion(tarifas: Tarifas = {}) {
  const t = { ...PROYECCION_DATOS.tarifa };
  for (const k of ["utility", "marketing"] as const) {
    const v = Number(tarifas[k]);
    if (Number.isFinite(v) && v > 0) t[k] = v;
  }
  return { ok: true, ...PROYECCION_DATOS, tarifa: t };
}
