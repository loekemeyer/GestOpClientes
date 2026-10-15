# Proyección de costos del agente de WhatsApp (por API)

> Análisis pedido por Pablo Olejavetzky, 13–15/10/2026. Estimativo de cuánto costaría atender
> con un agente de IA toda la comunicación de WhatsApp de un año, separado por quién cobra cada API.
> Es una **proyección**, no la factura real. Los números de la IA salen de mediciones del propio
> sistema (`bot_token_usage`, estimación del código, no la factura de Anthropic).

## Arquitectura considerada

Caso: cliente escribe por WhatsApp → entra a un servidor donde corre el agente → el agente consulta
datos (cliente, descuento, programación) → responde al cliente por WhatsApp. El agente **es** un
modelo de IA (hoy Claude, de Anthropic).

⚠ Hoy el bot **ya corre en Supabase Edge Functions** (`lk_whatsapp-webhook`), no en Vercel ni
Cloudflare. El cuadro final usa esa arquitectura real: el servidor no es una cuarta factura, va
incluido en lo que ya se paga de Supabase.

## Qué API cobra y cuál no

| API | ¿Cobra? | Detalle |
|---|---|---|
| **IA / Anthropic** | Sí, por token | Es el agente. Único costo que escala con el texto. |
| **Meta / WhatsApp** | Sí, por plantilla | Ver abajo. Las respuestas dentro de la ventana de 24 h (conversación de servicio) NO cobran. |
| **Supabase** | No por consulta | Va dentro del plan. Da igual 1 "carpeta"/tabla o 10. |
| **Servidor** (Vercel / Cloudflare / Supabase EF) | Depende del proveedor | Ver "Dónde corre el agente". |
| **GitHub** | No | Sólo guarda el código y lo despliega. No interviene por mensaje. |

## Meta / WhatsApp: ventana de 24 h y plantillas

- El cliente escribe primero → abre una **ventana de servicio de 24 h**. Mientras está abierta, las
  respuestas del bot NO cobran.
- Pasadas las 24 h, la empresa reinicia la charla con una **plantilla pre-aprobada** (texto fijo con
  variables de la base; **no pasa por la IA** → US$ 0 de Anthropic). Esa plantilla la cobra Meta.
- ⚠ **Desde el 1/10/2026 Meta cobra las plantillas de utilidad aunque se manden dentro de la
  ventana** (antes eran gratis adentro). [Probable, verificar en el rate card de Meta]
- Tarifa utility Argentina: **~US$ 0,026 por mensaje** [Probable, 10/2026].
- ⚠ Si una plantilla reabre la charla y el cliente responde, esa respuesta vuelve a gastar IA.

## Datos reales del historial (`public."Wpp_Historial_Clientes"`)

Medido el 13/10/2026:
- 27.348 mensajes · 613 hilos (`conversacion_id`) · 11.256 entrantes del cliente (`rol='user'`) ·
  16.092 de la empresa (`rol='assistant'`).
- Rango 09/06/2025 → 09/06/2026 = 12 meses. ~664 clientes (según `sql/137`).
- **Ventanas de conversación de 24 h: 5.716 en el año = ~476/mes.**
- **Mensajes entrantes: ~938/mes** (lo que dispararía al agente).

Triggers de Meta (avisos que inicia la empresa): el conteo por texto del historial subestima
(los avisos se disparan por **eventos de pedido**, no por mensajes de chat). El dashboard
"Proyección de avisos y gasto" los cuenta de los eventos reales: **~1.211/mes** (promedio Jun–Sep),
× US$ 0,026 = **~US$ 31,49/mes**.

## Dónde corre el agente (costo del servidor)

| Opción | Costo/mes | Nota |
|---|--:|---|
| **Supabase Edge Functions** | US$ 0 | Incluido en el plan de Supabase. Es donde ya vive el bot. |
| **Cloudflare Workers** | US$ 0–5 | Free: 100.000 req/día (uso comercial OK), muy por encima de las ~938/mes. Paid US$ 5/mes. |
| **Vercel** | US$ 20 | Hobby es sólo uso NO comercial → un bot del negocio obliga a Pro US$ 20/mes. |

Mínimos gratis (por USO no se excede a esta escala; lo que cobra es el **tipo de plan**):
- **Supabase free**: 500.000 invocaciones Edge / mes, 500 MB base, ~5 GB egress; ⚠ se **pausa**
  tras 1 semana inactivo → producción 24/7 obliga a **Pro ~US$ 25/mes**.
- **Cloudflare free**: 100.000 req/día, sin restricción comercial.
- **Vercel Hobby free**: ~1 M invocaciones, pero **no comercial**.

## Precio de los modelos (tarifa oficial Anthropic, 10/2026)

| Modelo | US$/1M entrada | US$/1M salida | US$ por respuesta (medido/estimado) |
|---|--:|--:|--:|
| Haiku 5.5 | 0,10 | 0,50 | ~0,003 |
| Sonnet 4.6 | 3,00 | 15,00 | ~0,048 |
| Opus 5.5 | 4,00 | 20,00 | ~0,064 |

⚠ Opus ya NO es 5× Sonnet: en la generación actual es ~1,3×.

## Cuadro final (agente en Supabase Edge Functions)

Base: ~938 respuestas IA/mes, ~1.211 plantillas Meta/mes.

| Concepto (US$/mes) | Haiku | Sonnet | Opus |
|---|--:|--:|--:|
| Meta plantillas · 1.211 avisos | 31 | 31 | 31 |
| IA · 938 respuestas | 3 | 45 | 60 |
| Supabase · base + Edge Functions | 25 | 25 | 25 |
| Servidor aparte | 0 | 0 | 0 |
| Meta respuestas al cliente | 0 | 0 | 0 |
| **TOTAL / mes** | **59** | **101** | **116** |
| **TOTAL / año** | **708** | **1.212** | **1.392** |

- **Crédito de Anthropic (US$ 200/mes) cubre sólo la columna IA**: Haiku 1,5%, Sonnet 23%, Opus 30%.
  Sobra en los tres.
- **De bolsillo** (lo que el crédito NO cubre): Supabase US$ 25 + Meta US$ 31 = **US$ 56/mes fijos**,
  igual con cualquier modelo mientras el crédito alcance.
- Diferencia entre modelos = sólo la IA. Como la paga el crédito, de bolsillo los tres cuestan lo
  mismo hoy. Lectura: conviene Sonnet por calidad mientras el crédito cubra la IA.

## Decisión tomada (Pablo Olejavetzky, 15/10/2026)

**El agente conversacional va con Sonnet 4.6.** Razón: con los US$ 200/mes de crédito de Anthropic
cubriendo toda la IA (Sonnet usa el 23%), el gasto de bolsillo es el mismo que con Haiku
(US$ 56/mes: Supabase + Meta), y Sonnet da mejor calidad —consulta antes de preguntar en los
casos donde Haiku 5.5 preguntaba de más (1 a 2 de cada 34, ver `docs/ESTADO.md` 13/10)—.

Condición: la decisión vale **mientras el crédito alcance**. Si se agota el crédito o el volumen
sube y la IA pasa a salir de bolsillo (Sonnet ~US$ 45/mes vs Haiku ~US$ 3/mes), se revisa.

⚠ **Hoy, en producción, el modelo #1 del agente es Haiku 5.5** (cadena `wa_agente_modelos`, tarea
`general`, puesto así el 13/10 — ver `docs/ESTADO.md`). Aplicar esta decisión = poner Sonnet 4.6
de #1 en esa cadena, que es una **escritura en la base** (`UPDATE wa_agente_modelos`) y necesita el
"sí" de Pablo con el SQL a la vista en ese momento (regla de BD). No se cambió en esta sesión: queda
anotada la decisión, falta ejecutarla.

## Protección contra abuso

Ya existe en el código:
- **Rate limit por número**: 20 consultas/hora (`wa_check_rate_limit`, sql/012; aviso y alerta en
  `_shared/tope-ia.ts`).
- **Tope de gasto IA diario**: `app_settings.ia_tope_gasto_usd` (`_shared/tope-gasto.ts`). Red última:
  el 01/10/2026 el crédito se agotó y el agente dejó de contestar; por eso existe.
- **Whitelist**: `wa_bot_solo_whitelist` — hoy sólo contesta a números habilitados.

Falta (a construir si se abre a clientes):
1. Tope de llamadas IA por conversación/turno (un loop de herramientas puede disparar muchas).
2. Límite de tamaño de input (mensajes gigantes inflan tokens).
3. Alerta ANTES de cortar el tope diario (al 70–80%), no sólo al cortar.
4. Subir `ia_tope_gasto_usd` de US$ 2/día a ~US$ 3–4/día acorde al volumen real, con margen.

## Fuentes de los números

- IA: `bot_token_usage` y mediciones del 09–13/10/2026 (ver `docs/ESTADO.md`, entradas de esas fechas).
- Historial: `public."Wpp_Historial_Clientes"` (ver `sql/137_wa_memoria_cliente.sql`).
- Triggers Meta: dashboard "Proyección de avisos y gasto".
- Tarifas: Anthropic (skill claude-api), Cloudflare y Supabase (páginas oficiales), Meta (rate card AR).
  Las tarifas de terceros cambian seguido: verificar antes de presupuestar.
