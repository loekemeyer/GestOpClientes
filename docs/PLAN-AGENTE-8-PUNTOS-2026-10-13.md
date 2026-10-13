# Plan: los 8 puntos de definición del agente, de "parcial" a "ok"

Pedido de Pablo Olejavetzky, 13/10/2026: *"Me gustaría armar un plan para que estos 8 puntos pasen a estar ok"*. Los 8
puntos son los de la lista genérica de cómo se arma un agente (objetivo, contexto, memoria, herramientas, planificación,
ciclo de ejecución, límites, evaluación). Este plan los contrasta con lo que hay en el código y la base al 13/10 y dice qué
falta, en qué orden, quién y para cuándo. Se cuelga del calendario de `PLAN-PRODUCCION-2026-10-13.md` (corte viernes
16/10, piloto lunes 19/10): **no agrega fechas nuevas ni corre el piloto**.

Etiquetas: **[Seguro]** leído en el código o medido · **[Probable]** inferencia fuerte · **[Adivinando]** relleno.

## 0. Supuesto que ordena todo el plan

El punto 1 ("pasar de responder mensajes a buscar un resultado concreto") no dice **qué resultado**. Sin eso no se puede
construir el 5 (qué planificar), el 6 (qué revisar) ni el 8 (qué medir). El plan asume, hasta que Pablo diga otra cosa:

> **Resultado concreto = la consulta queda resuelta sin pasar a una persona, y si es un pedido, queda en precarga tal
> como el vendedor la aprueba (sin cambios).**

Por qué esa y no "pedido cargado en Gestión sin revisión": la revisión humana de pedidos es decisión vigente del plan de
producción (`PEDIDOS_POR_WHATSAPP = false`, precarga con aprobación) y el corte de salida es de Luis. Cambiarla no es de
este plan: la levanta Luis o Thomas. Si se cambia el supuesto, cambian los puntos 1, 6 y 8; los otros cinco quedan igual.

## 1. Estado por punto y qué falta

### P1 · Objetivo con resultado medible — hoy NO

- **[Seguro] Hoy:** `docs/AGENTE.md` › Objetivo y `wa_agente_config` id 1 dicen "respuesta útil, breve y correcta, o
  derivar". No hay ninguna medida de si la consulta quedó resuelta: `wa_agente_evals` compara caminos, no resultados.
- **Falta:**
  1. Una frase de resultado en `AGENTE.md` › Objetivo y en `wa_agente_config` (la que lee el prompt), con el supuesto de
     la sección 0.
  2. **Una vista SQL `v_wa_resultado_charla`** (PaginaLK) que clasifique cada charla cerrada (12 h sin mensajes, mismo
     corte que la memoria) en: `resuelta` (contestó la IA o la capa fija y no hubo derivación ni alerta), `derivada`
     (`wa_alertas_humano` con motivo de cliente), `precarga_aprobada_sin_cambios`, `precarga_con_cambios`,
     `sin_respuesta` (turno sin salida: modelos caídos, filtro de salida). Fuentes: `bot_historial_chat`,
     `wa_alertas_humano`, `bot_auditoria`, `wa_turno_tiempos`, `wa_prospect_leads`/precargas.
- **Costo:** US$ 0. **Dueño:** Claude (código), Pablo (confirma la definición). **Para:** jueves 16/10.
- **Ok cuando:** la vista devuelve una fila por charla real de Damián y del canal de prueba, y los 5 estados se ven a
  mano en Conversaciones.

### P2 · Contexto — hoy OK

- **[Seguro] Hoy:** `buildSystemPrompt` (cliente, código, descuentos, mínimo, formas de pago, URL), reglas en
  `agente-fijos.ts`, ficha de memoria, bloque `<contexto_del_sistema>` por turno. 14.500 tokens de entrada por llamada
  (`bot_llm_intentos`), con caché.
- **Falta (no bloquea):** los 8 puntos viven en tres lugares (`AGENTE.md`, `agente-fijos.ts`, `bot-conversation.ts`);
  `REQUERIMIENTOS-AGENTE-2026-10-09.md` § 4 hace de índice. Mantener ese índice al día es la única acción.
- **Ok cuando:** ya. Revisión en fase 3 si el prompt pasa de 16.000 tokens (podar reglas que la eval muestre inútiles).

### P3 · Memoria — hoy OK con dos huecos

- **[Seguro] Hoy:** ventana 16-23 mensajes + charla anterior completa (12 h), hechos de charla por código (7 días de
  derivaciones, 24 h de acciones), ficha por cliente (`wa_memoria_cliente`, 504 fichas, incremental cada hora).
- **Falta:**
  1. Fichas de los clientes del piloto revisadas a mano (ya está en fase 1 del plan de producción). Criterio: no mezcla
     clientes, sin datos personales ni porcentajes, nada que no salga del historial.
  2. Historial de WhatsApp Business del 10/06/2026 a hoy: no importado, sin dueño, y el script de la primera carga no
     está en el repo. Hay que escribirlo con deduplicación (misma charla, fecha y texto) antes de la segunda carga.
  3. Llevar al repo el índice `bot_historial_chat_telefono_creado_en_idx` que existe en la base y en ninguna migración
     (`create index if not exists`).
- **Costo:** 1 y 3, US$ 0. 2: rearmar fichas de los clientes que cambiaron, Haiku, [Probable] US$ 1 a 3 con estimativo
  y "sí". **Dueño:** 1 Pablo (revisa) · 2 sin dueño: Pablo decide quién exporta · 3 Claude. **Para:** 1 y 3 viernes
  16/10 · 2 fase 3 (26 al 30/10), fuera del camino crítico.
- **Ok cuando:** las fichas del piloto tienen `revisada_por` cargado y el índice está en `sql/`.

### P4 · Herramientas — hoy OK

- **[Seguro] Hoy:** 22 herramientas en `bot-conversation.ts` (`buscar_productos`, `consultar_mis_pedidos`,
  `consultar_mi_entrega`, `consultar_kb`, `armar_pedido`, `confirmar_pedido`, `derivar_a_persona`, `anotar_duda`…).
- **Falta:** ninguna herramienta nueva para el piloto. Lo que el bot no sabe (si lo que mandó llegó, si la derivación fue
  tomada) se resuelve en P6 inyectándolo en hechos de charla, no con una herramienta: una herramienta sería una llamada
  más por turno y el modelo no la usaría por su cuenta.
- **Ok cuando:** ya. Se agrega una herramienta sólo si la eval de P8 muestra una consulta que se deriva por no tener dato.

### P5 · Planificación — hoy NO como paso explícito

- **[Seguro] Hoy:** loop de hasta 5 vueltas de herramientas por turno; el modelo decide una por una. La regla
  "CONSULTÁ ANTES DE PREGUNTAR" (13/10) es el único ordenamiento. Tras 5 vueltas sin contestar, pasa a una persona.
- **No estoy de acuerdo con agregar un módulo de planificación** (una llamada previa que escriba el plan) porque suma
  una llamada y 1 a 2 s a un turno que con Sonnet 4.6 ya tiene p50 de 4,4 s y p90 de 7,3 s, y el requerimiento es de 3 a
  6 s. En su lugar haría tres cosas baratas. El riesgo es que una consulta de 3 o más pasos siga saliendo mal; eso se ve
  en la eval, no se adivina.
- **Falta:**
  1. **Regla fija "ANTES DE ACTUAR"** en `agente-fijos.ts`, 3 líneas: qué necesita saber, qué herramienta lo da, recién
     después actuar o preguntar. Es la generalización de "consultá antes de preguntar", que ya corrigió 5 de 34 casos de
     Haiku.
  2. **Casos de evaluación de varios pasos** en `wa_agente_evals` (hoy casi todos son de 1 o 2 herramientas):
     "anulá el pedido y hacelo de nuevo con 10 cajas", "agregá 2 del 505 al pedido de ayer y decime cuándo llega",
     "¿tenés stock del 654 y a qué precio me queda con mi descuento?". Entre 6 y 10 casos, con el camino esperado.
  3. **Pensamiento del modelo como planificación**, sólo si el modelo del piloto es Sonnet 5.5 (ya soportado con esfuerzo
     bajo, commit `974b634`). Con Sonnet 4.6 no hay nada que prender.
- **Costo:** 1 y 2, US$ 0 (Gemini en la eval nocturna). Medir los casos nuevos con Sonnet 4.6: US$ 0,035 por caso,
  unos US$ 0,35, con estimativo y "sí". **Dueño:** Claude. **Para:** jueves 16/10 (regla y casos), medición fase 1.
- **Ok cuando:** los casos de varios pasos pasan con el modelo del piloto en la corrida nocturna 3 noches seguidas.

### P6 · Ciclo observar → decidir → actuar → **revisar** — hoy parcial

- **[Seguro] Hoy:** observar, decidir y actuar existen (loop). Revisar no: tres huecos.
  1. **Meta rechaza después de aceptar y el bot ya dijo "listo"** (caso de las fotos del 08/10; fase 0, punto 3, abierto).
  2. **Todos los modelos caen → el cliente no recibe nada** (se alerta a una persona, el cliente queda en silencio).
  3. **Derivación anunciada que no llegó a Planify**: hoy la ve el mail de fallas (alertas vencidas) y el piloto se pausa
     si pasa. No hay chequeo en el turno.
- **Falta:**
  1. Trigger en `wa_message_status`: con `status = 'failed'` de un `wamid` que salió del bot (texto, foto o plantilla),
     escribir en `bot_auditoria` "no llegó: <qué>, código <n>" y abrir alerta interna si es un mensaje al cliente. Como
     `hechos-charla.ts` lee `bot_auditoria`, en el turno siguiente el agente ve "la foto del 505 no le llegó" y no repite
     "ya te la mandé". Requiere guardar el `wamid` de cada envío del bot (hoy la foto no lo guarda).
  2. Mensaje fijo al cliente cuando la cadena de modelos agota los intentos: "Se me complicó, ya le paso tu consulta a
     alguien del equipo", encolado en `wa_outbox` (pasa por la llave) + la alerta que ya existe.
  3. Nada nuevo: hechos de charla ya muestra el estado de la derivación (abierta o atendida); la pausa del piloto cubre
     el resto.
- **Costo:** US$ 0 (SQL + código, pruebas locales). **Dueño:** Claude. **Para:** 1 miércoles 14/10 (es compuerta de
  fase 0) · 2 jueves 16/10.
- **Ok cuando:** una foto a un número inválido del canal de prueba deja fila en `bot_auditoria` y el turno siguiente del
  Simulador la muestra en hechos de charla; y con `wa_agente_modelos` vacío el canal de prueba recibe el mensaje fijo.
- **Avance 13/10 (Pablo: "arrancá con P6"):** 6.1 y 6.2 hechos el mismo día (`sql/140`, `_shared/envios-bot.ts`, `hechos-charla.ts`,
  `RESPALDO_IA_CAIDA`). Probado en la base con rollback y con pruebas locales. **Falta para el "ok":** un rechazo real de Meta al canal de
  prueba visto en hechos de charla, y que Pablo apruebe el texto de IA caída. Detalle en `ESTADO.md` (13/10).

### P7 · Límites — hoy OK

- **[Seguro] Hoy:** permisos default-deny, no confirma pedidos, `derivar_a_persona`, `anotar_duda`, filtro de salida,
  canario, tope diario de gasto (aviso US$ 1, corte US$ 2), whitelist, llave `wa_envio_automatico`, trigger de
  `customers` (13/10).
- **Falta (ya en el plan de producción):** la pausa ensayada (fase 0, punto 5) y recalibrar el tope diario con tráfico
  real (tarea 5314: con Sonnet, US$ 2 son unos 20 turnos por día).
- **Ok cuando:** la pausa se ensayó una vez antes del 16/10 y el tope se revisa el 23/10 con `bot_token_usage` del piloto.

### P8 · Evaluar y mejorar — hoy mide proceso, no resultado

- **[Seguro] Hoy:** 84 casos cada noche con Gemini (US$ 0) comparados contra la corrida anterior; correcciones del
  artifact → ejemplos aprobados; puntaje de respuestas (`lk_ia-puntaje`); `v_wa_turno_tiempos` para latencia.
- **Falta:**
  1. **Vista `v_wa_resultado_semana`** sobre la de P1: por semana, consultas, % que llegó a la IA, % resueltas sin
     persona, % derivadas, % precargas aprobadas sin cambios, p50 y p90 de respuesta, gasto en US$. Es la medida del
     punto 1; sin ella el piloto se evalúa a ojo.
  2. **Esa vista en el reporte quincenal** (`lk_reporte-quincenal` ya existe) y en Configuración del agente › Evaluación
     (una fila arriba de la tabla de casos; bump de versión del dashboard).
  3. **Vuelta de mejora con regla:** cada charla `derivada` o `sin_respuesta` del piloto se mira en la revisión diaria
     (30 a 45 min ya previstos) y termina en una de cuatro: corrección en el artifact (A o B), cambio de capa fija (C),
     tarea de Planify (D), o "correcta, así tenía que derivar". Lo que se repite 3 veces pasa a caso de `wa_agente_evals`.
- **Costo:** US$ 0. **Dueño:** Claude (vistas y dashboard), Pablo (revisión diaria). **Para:** vistas jueves 16/10 ·
  primer reporte con datos reales viernes 23/10 (cierre del piloto).
- **Ok cuando:** el reporte del 23/10 sale de la vista, no de contar a mano, y cada derivada de la semana tiene su
  salida (A, B, C, D o correcta).

## 2. Orden y calendario (dentro del plan de producción, sin fechas nuevas)

| Cuándo | Qué | Punto | Dueño | US$ |
|---|---|---|---|---|
| Mar 13/10 | Pablo confirma o corrige el supuesto de la sección 0 | 1 | Pablo | 0 |
| Mié 14/10 | `failed` de Meta → `bot_auditoria` + alerta, con `wamid` de cada envío del bot | 6.1 | Claude | 0 |
| Jue 15/10 | Regla "ANTES DE ACTUAR" + 6 a 10 casos de varios pasos | 5.1, 5.2 | Claude | 0 |
| Jue 15/10 | Mensaje fijo al cliente cuando la IA falla | 6.2 | Claude | 0 |
| Jue 16/10 | Vista `v_wa_resultado_charla` + frase de resultado en `AGENTE.md` y `wa_agente_config` | 1 | Claude | 0 |
| Jue 16/10 | Vista semanal + reporte quincenal + fila en Evaluación | 8.1, 8.2 | Claude | 0 |
| Vie 16/10 | Fichas del piloto revisadas · índice al repo · pausa ensayada | 3.1, 3.3, 7 | Pablo / Claude | 0 |
| Vie 16/10 | Medir los casos de varios pasos con el modelo del piloto | 5 | Claude, con "sí" | ~0,35 |
| 19 al 23/10 | Revisión diaria con salida A/B/C/D por cada derivada | 8.3 | Pablo | 0 |
| Vie 23/10 | Primer reporte de resultado del piloto · revisar tope diario | 8, 7 | Claude / Pablo | 0 |
| 26 al 30/10 | Historial 10/06 a hoy: script con deduplicación, carga, rearmar fichas | 3.2 | sin dueño | 1 a 3 |

Todo lo de Claude entra en la regla de gasto US$ 0 (pruebas locales y Gemini) salvo la medición del 16/10, que lleva
estimativo y "sí". Las escrituras en la base de PaginaLK van con la excepción de Pablo de este repo (se ejecutan y se
informa el SQL, el efecto y el `SELECT`).

## 3. Qué NO entra en este plan

1. Pedidos cargados en Gestión sin revisión humana: decisión de Luis o Thomas, fuera de alcance.
2. Un módulo de planificación con llamada previa al modelo: ver P5.
3. Embeddings o búsqueda por similitud en el historial: `REQUERIMIENTOS-AGENTE-2026-10-09.md` ya lo descarta hasta que
   un cliente pase de unos 500 mensajes.
4. Herramientas nuevas: sólo si la eval de P8 muestra una consulta derivada por falta de dato.

## 4. Cómo se sabe que los 8 están "ok"

Un punto está ok cuando cumple su "Ok cuando" de la sección 1. Al 13/10: **2 y 4 ok; 3, 6 y 7 parciales; 1, 5 y 8 no.**
(Corregido el 13/10: la primera versión daba el 7 por ok, pero su propio criterio pide la pausa ensayada y el tope revisado, que
no están. El 6 pasó a parcial con lo hecho ese día.) **Tablero vivo:** https://claude.ai/artifact/DY3rYB4AtYejUZmEyE4VoG Objetivo: los 8 con su criterio cumplido al cierre del piloto, viernes 23/10, salvo 3.2 (historial faltante), que
es de fase 3.

Referencias: [plan de producción](PLAN-PRODUCCION-2026-10-13.md), [requerimientos y memoria](REQUERIMIENTOS-AGENTE-2026-10-09.md),
[comportamiento del agente](AGENTE.md), [estado](ESTADO.md).
