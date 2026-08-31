import { supabase } from "./supabase.ts";

/** Documento rector por defecto si no hay fila en wa_agente_config. */
const DEFAULT_AGENTE_MD = `# Agente de Gestión Operativa de Clientes

## Objetivo
Responder las consultas de clientes mayoristas que no tienen plantilla
automática. Dar una respuesta útil, breve y correcta en tono de la marca, o
derivar a un humano cuando corresponda.

## Limitaciones y Permisos
- No inventa pedidos, precios, stock ni fechas.
- No confirma pedidos, cambios ni cancelaciones por sí mismo.
- No comparte datos de un cliente con otro.
- No negocia precios ni condiciones fuera de sistema.`;

/** Lee el documento rector vivo del agente (tabla wa_agente_config, id=1). */
export async function getAgenteConfig(): Promise<string> {
  try {
    const { data } = await supabase
      .from("wa_agente_config")
      .select("contenido")
      .eq("id", 1)
      .maybeSingle();
    const md = (data?.contenido ?? "").trim();
    return md.length ? md : DEFAULT_AGENTE_MD;
  } catch (_e) {
    return DEFAULT_AGENTE_MD;
  }
}

/**
 * Construye el system prompt del agente conversacional a partir del documento
 * rector editable + el contexto del cliente. Editar el módulo "Configuración
 * del agente" cambia este prompt en tiempo real.
 */
export async function buildAgenteSystem(businessName: string): Promise<string> {
  const rector = await getAgenteConfig();
  return `Sos el asistente virtual de Loekemeyer Hnos, una empresa mayorista de artículos de cocina y bazar.
Estás hablando con ${businessName} por WhatsApp.

Tu comportamiento se rige por el siguiente documento. Respetalo estrictamente:
no hagas nada que las Limitaciones prohíben y no asumas permisos que no estén
explícitos. Si algo no está claro (objetivo, límite o permiso), derivá a un
vendedor en vez de improvisar.

---
${rector}
---

Respondé de forma breve, amable y profesional. No inventes información sobre
pedidos ni precios. Si no sabés algo, sugerí contactar a ventas.`;
}

/** Registra una duda del agente en la cola de Consultas. */
export async function logAgenteConsulta(
  pregunta: string,
  contexto?: string,
  origen?: string,
): Promise<void> {
  try {
    await supabase.from("wa_agente_consultas").insert({
      pregunta,
      contexto: contexto ?? null,
      origen: origen ?? "agente",
    });
  } catch (_e) { /* no bloquear la respuesta por un fallo de log */ }
}
