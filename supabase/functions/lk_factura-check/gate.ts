// gate — decide si una llamada a lk_factura-check pasa, según la llave y el secreto (auditoría 02/10/2026, hallazgo 3.1.1).
//
// El endpoint es público (verify_jwt = false: lo llama pg_net desde Gestión). Sin gate, cualquiera con la URL podía disparar
// envíos al número de redirección y reclamar grupos en wa_grupo_listo. Los llamadores legítimos mandan el header
// `x-lk-secret` con un secreto guardado en el Vault de GESTIÓN (lk_factura_check_secret): el trigger wa_factura_notificar,
// el cron wa_barrido_avisos y lk_notif-sim. La edge lo lee de Gestión con wa_factura_check_secret() (sólo service_role).
//
// Llave app_settings.wa_factura_check_gate (PaginaLK), en tres escalones para no cortar el pipeline de facturas:
//   · sin fila o "0" → apagado: no se chequea nada (como siempre).
//   · "log"          → se chequea y se registra en los logs lo que NO trae un secreto válido, pero pasa igual.
//   · "1"            → se rechaza con 401 lo que no trae un secreto válido (falla cerrada: si no se puede leer el secreto, no pasa).
//
// Lógica pura, sin red ni estado: se prueba en tests/gate-factura-check.test.ts.

export type ModoGate = "off" | "log" | "on";

export function modoDeGate(valor: string | null | undefined): ModoGate {
  const t = String(valor ?? "").trim().toLowerCase();
  if (t === "1" || t === "on") return "on";
  if (t === "log") return "log";
  return "off";
}

/** Comparación en tiempo constante (no corta en el primer carácter distinto). La longitud del secreto no es secreta. */
export function igualesConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

export interface DecisionGate {
  pasa: boolean;
  /** true = hay que dejar una línea en los logs (llamada sin secreto válido). */
  registrar: boolean;
  motivo: string;
}

export function decidirGate(modo: ModoGate, recibido: string, esperado: string | null): DecisionGate {
  if (modo === "off") return { pasa: true, registrar: false, motivo: "gate apagado" };
  const valido = !!esperado && recibido.length > 0 && igualesConstante(recibido, esperado);
  if (valido) return { pasa: true, registrar: false, motivo: "secreto válido" };
  const motivo = !recibido
    ? "sin x-lk-secret"
    : !esperado
    ? "no se pudo leer el secreto esperado"
    : "x-lk-secret no coincide";
  return { pasa: modo === "log", registrar: true, motivo };
}
