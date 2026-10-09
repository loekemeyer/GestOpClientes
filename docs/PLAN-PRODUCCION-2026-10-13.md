# Plan de salida a producción por compuertas

Pedido de Pablo Olejavetzky, 09/10/2026. Reemplaza la estimación por jornadas del mismo día (commit `aac3332`, queda en el
historial de git). Arranca el **martes 13/10/2026** (el 12 es feriado), con las decisiones de la sección 2.

Alcance: bot de WhatsApp para consultas, pedidos en precarga con revisión humana, derivaciones al equipo por Planify y
memoria por cliente. La carga directa de pedidos sin revisión humana queda para después.

**Por qué compuertas y no un calendario de 17 jornadas.** La versión anterior reservaba 11 jornadas de validación antes del
piloto, con Simulador y servicios simulados, que ella misma decía que no reemplazan el circuito real. La evidencia sale del
tráfico real, y el cuello de botella no es el código: la memoria inicial, su lectura y la incremental salieron en unos 50
minutos el 09/10 (`d93e398` → `aaead53`). Lo lento es lo humano: aprobar clientes, que el equipo tome los casos, revisar
charlas. Cada fase tiene fecha objetivo y una condición para pasar. Si no se cumple, no se avanza y se reestima.

## 1. Estado medido el 09/10 (en la base, no en los docs)

1. **Llaves:** `wa_envio_automatico = prueba` y `wa_bot_solo_whitelist = 1`. La whitelist tiene 2 filas: Thomy (canal
   de prueba) y Damián (Chef 411, real desde el 02/10).
2. **Uso real:** Damián escribió **19 mensajes en 2 días** desde el 02/10 (`bot_historial_chat`). Prueba que el circuito
   anda con un cliente real, pero no alcanza como evidencia de piloto.
3. **Envíos:** 314 estados de Meta en 7 días, **5 fallidos**, todos fotos a Damián (131053). La causa de las fotos está
   corregida (`docs/ESTADO.md`). Lo que sigue abierto es lo general: Meta rechaza **después** de aceptar, y el bot ya le
   dijo al cliente "listo".
4. **Memoria:** **504 fichas** generadas y `aprobada` (US$ 1,53), sin revisión humana. Las lee el agente para clientes
   de LK. La incremental corre cada hora desde el 09/10. Falta el historial del 10/06/2026 a hoy (no importado), y 160
   clientes sólo aparecen en charlas compartidas.
5. **Gasto de IA:** US$ 5,28 en 7 días, casi todo pruebas (`bot_token_usage`).
6. **Latencia del modelo (turnos reales):** Sonnet 4.6 tiene p50 4,4 s y p90 7,3 s, con 4 de 12 turnos por encima de 6 s.
   Haiku 4.5 en el Simulador: p50 1,4 s. El requerimiento es 1 a 3 s (`docs/REQUERIMIENTOS-AGENTE-2026-10-09.md`).
   Haiku 5.5 y Sonnet 5.5 ya están soportados y no hay medición real de ninguno de los dos.
7. **Tareas de Planify abiertas que tocan el lanzamiento** (todas de Pablo, 64): 5343 (un cliente edita su descuento en
   `customers`), 5273 (endurecer seguridad), 5314 (tope de gasto), 5474 (un solo sí), 5267 (avisos a Ventas), 5532 (memoria).

## 2. Decisiones del martes 13/10 (en orden de impacto)

Sin la 1 no hay piloto. Las otras se pueden tomar dentro de la fase 0.

1. **Qué 3 a 5 clientes entran al piloto, y quién los aprueba (Luis o Thomas).** La regla de no contactar a nadie
   (`CLAUDE.md`) exige que sea uno de ellos. Criterio sugerido: clientes con charla propia en el historial (tienen ficha),
   que ya compran por WhatsApp y que tienen un contacto que responde. Hace falta saber también si Damián cuenta como uno.
2. **Modelo de producción para el agente.** Las opciones son Sonnet 4.6 (medido, lento en la cola), Haiku 5.5 (barato y
   rápido, sin medición real) o Sonnet 5.5 (sin medir). Propuesta: medir Haiku 5.5 y Sonnet 5.5 con los casos de evaluación
   el 13/10, después de un estimativo y un "sí" (regla de gasto), y decidir con latencia, costo y aciertos en la mano.
3. **Responsable por sector** que toma los casos del piloto en Planify en el día, y quién cubre fuera de horario.
4. **Tope de gasto mensual** para producción (tarea 5314). Hoy no hay número: ver la sección 6.
5. **Quién exporta el historial del 10/06/2026 a hoy**, y para cuándo. No bloquea el piloto, pero son los 4 meses más
   recientes y los que más pesan en la memoria.

## 3. Compuertas

| Fase | Fechas objetivo | Qué se hace | Para pasar a la siguiente |
|---|---|---|---|
| 0 · Lo que bloquea | Mar 13 – Mié 14/10 | Seguridad, envíos fallidos, modelo, pausa (detalle abajo) | Las 5 cosas comprobadas en la base real |
| 1 · Circuito con el equipo | Jue 15 – Vie 16/10 | Una derivación y una precarga reales, punta a punta. Fichas del piloto revisadas a mano | El caso llega al responsable correcto y se cierra |
| 2 · Piloto | Lun 19 – Vie 23/10 | 3 a 5 clientes en la whitelist: el bot les contesta y les llegan sus avisos. Nadie más. Pedidos con revisión humana | 50+ mensajes de clientes, 0 incidentes críticos, 0 derivaciones perdidas |
| 3 · Ampliación | Lun 26 – Vie 30/10 | 15 a 20 clientes. En paralelo: historial faltante y mensajes simultáneos | Gasto y latencia dentro de lo decidido. El equipo da abasto |
| 4 · Avisos automáticos | desde Lun 02/11 | `wa_envio_automatico` pasa a `1` | Decisión aparte de Luis o Thomas |

### Fase 0 · Lo que bloquea (Mar 13 – Mié 14/10)

1. **Tarea 5343:** reproducir con un teléfono de prueba que un cliente no puede tocar campos protegidos de `customers`
   (descuento, condición, lista). Si puede, se corrige antes de seguir.
2. **Aislamiento entre clientes:** desde dos teléfonos de prueba vinculados a dos clientes distintos, pedir datos del otro
   (pedidos, facturas, saldo, ficha). Tiene que dar cero en la base real, no en el Simulador.
3. **Envío rechazado por Meta después de aceptado:** cuando llega un `failed` en `wa_message_status` de algo que el bot
   ya dio por enviado, que quede registrado y le llegue a alguien (alerta o reintento). Hoy el bot no se entera.
4. **Modelo de producción:** la decisión 2 de la sección 2.
5. **Pausa ensayada:** apagar y prender las respuestas a clientes del piloto sin tocar código (`wa_bot_solo_whitelist` y
   whitelist), y comprobar que la atención manual sigue funcionando.

### Fase 1 · Circuito con el equipo (Jue 15 – Vie 16/10)

1. Desde el canal de prueba, asociado a un cliente del piloto: una consulta que deriva y un pedido que queda en precarga.
   La alerta tiene que llegar a Planify, la persona del sector la toma y la cierra, y el pedido aparece en Gestión con lo
   que se aprobó.
2. Revisar a mano las fichas de memoria de los clientes del piloto (nacieron aprobadas sin revisión): que no mezclen
   clientes, no tengan datos personales ni porcentajes y no afirmen cosas que no salen del historial.
3. Cargar los clientes del piloto en `wa_envio_contactos` y `bot_customer_whatsapps`, con la aprobación de la decisión 1.

### Fase 2 · Piloto (Lun 19 – Vie 23/10)

1. El bot contesta a los clientes del piloto. **La llave sigue en `prueba`**: con ella, los avisos automáticos de pedidos
   y facturas salen sólo a los números de la whitelist, así que los del piloto también los reciben. Eso es parte de lo que
   se aprueba en la decisión 1.
2. Revisión diaria de 30 a 45 min: charlas, derivaciones, precargas, gasto y tiempo de respuesta (`wa_turno_tiempos`).
   Lo que aparece se corrige en el día.
3. **Se pausa** si aparecen: datos de otro cliente, un pedido distinto de lo aprobado, una precarga o alerta duplicada, una
   derivación anunciada que no llegó a Planify, o un mensaje que el cliente no recibió y el bot dio por mandado.

### Fase 3 · Ampliación (Lun 26 – Vie 30/10)

1. Pasar a 15 a 20 clientes, con la misma revisión humana de pedidos.
2. En paralelo, fuera del camino crítico: importar el historial faltante y regenerar o sumar a las fichas, mensajes
   simultáneos o en ráfaga de un mismo cliente, y medir de nuevo latencia y costo con tráfico real.

### Fase 4 · Avisos automáticos (desde Lun 02/11)

`wa_envio_automatico` pasa a `1`. Es una decisión distinta de que el bot conteste: con la llave en `1` **el bot inicia
el contacto** con todos los clientes que tengan teléfono vinculado, y cada plantilla se paga. La toman Luis o Thomas, con
el resultado de las fases 2 y 3 delante. Las filas que hoy quedan `held_no_whitelist` no se reenvían al pasar a `1`.

## 4. Qué queda fuera del camino crítico

Nada de esto bloquea el piloto si los clientes elegidos tienen charla propia y ficha:

1. La auditoría completa del historial anual (27.348 mensajes, 664 clientes).
2. Los 160 clientes que sólo aparecen en charlas compartidas.
3. El historial del 10/06/2026 a hoy.
4. Buscar mensajes viejos sueltos (la ficha resume, no busca). Se dimensiona sólo si el piloto muestra que hace falta.
5. Mistral gratis, el conocimiento técnico ampliado de artículos y lo cosmético.

## 5. Dueños

1. **Luis o Thomas:** aprobar la lista del piloto (decisión 1) antes del Mié 14/10, y la llave en `1` (fase 4).
2. **Pablo Olejavetzky:** decisiones 2, 4 y 5, revisión diaria del piloto y aprobar los gastos de prueba.
3. **Responsable de cada sector en Planify:** tomar los casos del piloto en el día (decisión 3).
4. **Sin dueño hoy:** exportar el historial del 10/06/2026 a hoy (decisión 5).
5. **Claude (sesiones):** el código de las fases 0 a 3, con pruebas locales en US$ 0 y Simulador con Gemini.

## 6. Costos

1. **Fase 0, medición de modelos:** sale de un estimativo que se presenta el 13/10 y se corre sólo con el "sí" (regla de
   gasto). Referencia del 09/10: Haiku 5.5, unos US$ 0,003 por caso.
2. **Piloto:** con 3 a 5 clientes, centavos por día. Sale medido de `bot_token_usage`.
3. **Producción [estimado sin tráfico real]:** unos US$ 18 por mes de IA (`docs/ESTADO.md`, sobre 12 consultas por día)
   más el techo de US$ 17,63 por mes de avisos al equipo por plantilla de utilidad. Total aproximado US$ 36 por mes.
   El piloto lo reemplaza por un número medido, y con ese número se fija el tope (decisión 4).

## 7. Qué se conserva de la versión anterior

1. Un criterio de cierre por fase y reestimar si no se cumple.
2. Las condiciones de pausa y la revisión humana de pedidos.
3. Los recuerdos de la memoria no autorizan a operar: precios, saldos, permisos y estados se consultan en su fuente.
4. No se reimplementa lo que ya existe: se verifica y se completa.
5. La generación de fichas y una auditoría con un modelo más caro son gastos separados.

Referencias: [estado actual](ESTADO.md), [memoria y requerimientos](REQUERIMIENTOS-AGENTE-2026-10-09.md),
[comportamiento del agente](AGENTE.md) y [flujos](FLUJOS.md).
