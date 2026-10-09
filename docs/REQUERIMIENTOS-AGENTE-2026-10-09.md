# Requerimientos de arquitectura y memoria del agente — contrastados con lo que existe

> 09/10/2026. Documento de requerimientos que trajo Pablo ("Requerimientos de Arquitectura y Memoria para
> Agente de WhatsApp"), puesto al lado del código y de mediciones de la base PaginaLK (`kwkclwhmoygunqmlegrg`).
> Etiquetas: **[Seguro]** medido o leído en el código · **[Probable]** inferencia fuerte · **[Adivinando]** relleno.

## Lo que el documento supone y no se cumple

1. **[Seguro] La base no es el cuello de botella.** El documento reserva 1 a 2 s para "consulta a base de
   datos por ID". Medido el 09/10 con `EXPLAIN ANALYZE`: leer los 200 mensajes del teléfono con más historial
   de `bot_historial_chat` por el índice `(telefono, creado_en desc)` tarda **0,11 ms**. La tabla tiene 1.681
   filas de 34 teléfonos (552 kB). Faltan cuatro órdenes de magnitud para que la base pese.
2. **[Seguro] El prompt no son 2.600 tokens: son unos 14.500.** Promedio de entrada por llamada en
   `bot_llm_intentos`: 14.563 tokens en el webhook con Sonnet 4.6, 14.158 con Haiku y 8.695 con Gemini. El
   historial es una parte menor: el grueso son las reglas fijas, el contexto del cliente y las 22 herramientas.
3. **[Seguro] Una respuesta de la IA no es una llamada: son 1,8 de promedio** (herramientas). El tiempo se va
   en el modelo, no en la base.

## Medición de latencia (sólo el tiempo del modelo, suma de las llamadas de un turno)

Fuente: `bot_llm_intentos.duracion_ms`, agrupado por turno (una `iteracion` 1 abre turno). No incluye la
lectura de la base, la herramienta ni el envío a Meta.

| Función · modelo | Turnos | Llam./turno | p50 (s) | p90 (s) | Máx (s) | > 6 s |
|---|--:|--:|--:|--:|--:|--:|
| Simulador · Sonnet 4.6 | 17 | 2,6 | 7,0 | 13,1 | 33,0 | 10 |
| Webhook real · Sonnet 4.6 | 12 | 1,8 | 4,4 | 7,3 | 9,0 | 4 |
| Simulador · Haiku 4.5 | 58 | 1,8 | 1,4 | 5,7 | 16,2 | 5 |

Por llamada suelta: Gemini 3.5 flash-lite p50 1,2 s y p90 8,0 s (774 llamadas, 156 fallidas).

**[Seguro] Con Sonnet, 1 de cada 3 turnos reales ya pasa los 6 s** (4 de 12). El objetivo de 3 a 6 s se cumple
en la mediana y se rompe en la cola. Muestra chica: 12 turnos reales desde el 08/10.

⚠ **[Seguro] `wa_conversations` no sirve para medir latencia**: las 156 filas `in` tienen 0,0 s hasta su
respuesta (se graban juntas). Y desde el 05/10 no tiene filas: el historial real del agente es
`bot_historial_chat`. Hoy **no existe ninguna medición de punta a punta** (llegada del mensaje → envío a Meta).

## Requerimiento por requerimiento

### 1. Memoria por cliente

| Pide | Estado | Dónde |
|---|---|---|
| Casillero por número de WhatsApp | **Existe** | `bot_historial_chat` (`telefono`, `rol`, `contenido`, `creado_en`), escrita por RPC `bot_guardar_mensaje` (`_shared/bot-conversation.ts`) |
| Historial indexado por teléfono | **Existe en producción, no en el repo** | índice `bot_historial_chat_telefono_creado_en_idx` vivo en la base. Ninguna migración de `sql/` lo crea |
| Lectura del historial | **Existe** | `historialDelTurno` lee hasta 200 por teléfono. `_shared/ventana-historial.ts` manda al modelo 16 a 23 mensajes anclados (para el caché) más la charla anterior (corte de 12 h) hasta 8.750 caracteres o 60 mensajes |
| Resumen estructurado (JSON) | **Existe parcial** | "Hechos de la charla" (`_shared/hechos-charla.ts`): derivaciones de 7 días y acciones del bot de 24 h, armado por código, sin IA |
| Embeddings | **No existe, y no hace falta hoy** [Probable] | con 34 teléfonos y un prompt de 14.500 tokens, buscar por similitud agrega una llamada y latencia para ahorrar nada. Se revisa si un cliente pasa de unos 500 mensajes |

### 2. Tiempo de respuesta 3 a 6 s

| Pide | Estado |
|---|---|
| Query por ID 1 a 2 s | **Ya cumple con margen**: 0,11 ms (ver arriba) |
| LLM 1 a 3 s | **No cumple con Sonnet** (p50 4,4 s por turno). Haiku sí en la mediana (1,4 s) |
| Envío 1 s | **No medido** |
| Total 3 a 6 s | **No medido de punta a punta.** Falta una columna o tabla con llegada y salida por turno |

Timeouts vigentes (`_shared/timeouts.ts`): 30 s por llamada (Sonnet, Haiku, Gemma), 8 s Gemini. Hasta 5 vueltas
por turno.

### 3. Fricción en WhatsApp

| Pide | Estado | Costo de hacerlo |
|---|---|---|
| Indicador "escribiendo…" | **No existe.** `markRead` (`_shared/wa-api.ts`) manda `status: "read"` sin `typing_indicator` | Bajo [Probable]: agregar `typing_indicator: { type: "text" }` a ese mismo POST. Meta lo muestra hasta 25 s o hasta la respuesta. Pasa por `wa-guard` igual que hoy |
| Aviso inmediato "Dame un segundo…" | **No existe** | Medio. Exige contestarle 200 a Meta antes de procesar: hoy el webhook hace `await handleMessage` y recién después devuelve 200 (`lk_whatsapp-webhook/index.ts`). Duplica los mensajes que recibe el cliente |
| Indexar por cliente | **Existe** (punto 1) | — |

**No estoy de acuerdo con el aviso de texto como regla general** porque con p50 de 4,4 s el cliente recibiría dos
mensajes en la mayoría de los turnos para ahorrarse una espera que el "escribiendo…" ya cubre. En su lugar haría
el indicador siempre y, como mucho, un aviso de texto sólo cuando el turno pase de unos 8 s. El riesgo es que el
indicador se apague a los 25 s en los turnos largos (máximo medido 33 s en el Simulador).

### 4. Los 8 puntos de definición del agente

| Punto | Dónde está hoy |
|---|---|
| Propósito | `docs/AGENTE.md` (Objetivo) y `wa_agente_config` id 1 (editable desde Configuración del agente) |
| Rol / persona | idem: tono "breve, amable, profesional, argentino" |
| Contexto operativo | `buildSystemPrompt` (`_shared/bot-conversation.ts`): cliente, código, descuentos, mínimo, formas de pago, URL |
| Instrucciones / reglas | `_shared/agente-fijos.ts`: `REGLAS_OPERATIVAS`, `REGLA_PEDIDOS_WA`, bloque de Seguridad |
| Entradas | texto del cliente + ventana de historial + bloque `<contexto_del_sistema>` (hora, hechos, ejemplos aprobados, pistas) |
| Herramientas | 22 en `bot-conversation.ts` (`buscar_productos`, `consultar_mis_pedidos`, `armar_pedido`, `confirmar_pedido`, `derivar_a_persona`…). Las de pedido se quitan si los pedidos por WhatsApp están apagados |
| Salidas | texto libre, 3-4 párrafos máx., negrita con un asterisco, `max_tokens` 1024, corte a 4.000 caracteres, filtro de salida y canario |
| Excepciones | cadena de modelos por prioridad (`wa_agente_modelos`, 5 min de enfriamiento si uno cae), respaldo final Sonnet, alerta a una persona |

**Falta [Seguro]:** si todos los modelos fallan o vencen, **el cliente no recibe nada** (se alerta a una persona y
queda en silencio hasta que conteste). Es el hueco de "manejo de excepciones" que más le pega al cliente.
**Falta [Seguro]:** los 8 puntos no están en un solo lugar: están repartidos entre `docs/AGENTE.md`,
`agente-fijos.ts` y `bot-conversation.ts`. Este documento hace de índice.

## Qué haría, por impacto

1. **Medir punta a punta** (llegada → envío a Meta) por turno. Sin eso el SLA de 3 a 6 s no se puede ni afirmar
   ni negar. Costo: una columna o tabla y dos marcas de tiempo.
2. **Mensaje al cliente cuando la IA falla** (hoy silencio). Ej.: "Se me complicó, ya le paso tu consulta a
   alguien del equipo". Sale por la llave de envío como todo lo demás.
3. **Indicador "escribiendo…"** en el `markRead`.
4. **Llevar al repo el índice de `bot_historial_chat`** que ya existe en producción (migración idempotente con
   `create index if not exists`), así una base reconstruida desde `sql/` no lo pierde.
5. Aviso de texto inmediato y embeddings: no por ahora (razones arriba).
