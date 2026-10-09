# Estimación y cronograma de salida a producción

Pedido de Pablo Olejavetzky. Preparado el 9 de octubre de 2026, con inicio el **martes 13 de octubre de 2026**, fechas de Argentina y disponibilidad de **4–6 horas por jornada**.

Alcance: bot de WhatsApp para consultas, pedidos en precarga con revisión humana, derivaciones al equipo mediante Planify y memoria persistente por cliente. Incluye revisar el historial anual importado y los clientes con varios contactos. La carga directa de pedidos sin revisión humana queda para una etapa posterior.

## Plazo propuesto

| Hito | Objetivo provisional | Condición |
|---|---|---|
| Piloto con 2–5 clientes | 28–30 de octubre | Identidades verificadas, memoria comprobada y circuito completo de pedidos/avisos funcionando |
| Habilitación gradual a una etapa mayor | 4–6 de noviembre | Piloto estable, equipo disponible y bloqueos críticos cerrados |
| Auditoría completa de contactos e historial | A dimensionar con la muestra del 13/10 | Depende del volumen pendiente y de la revisión humana de asociaciones ambiguas |

El calendario base tiene **17 jornadas hábiles**, del 13/10 al 04/11. Con dos jornadas adicionales para memoria/auditoría, pasa a **19 jornadas**, hasta el 06/11. A 4–6 horas por jornada equivale a **68–114 horas de dedicación reservada**, incluyendo implementación, pruebas, decisiones, coordinación y seguimiento del piloto. El trabajo técnico requiere capacidad de desarrollo además de la disponibilidad de Pablo.

Las fechas son una estimación condicionada. La importación restante, los permisos de prueba, las identidades ambiguas y los cambios necesarios de recuperación pueden ampliar el plazo. La auditoría anual completa no tiene una fecha garantizada: el día 13 se debe estimar su esfuerzo restante. El piloto propuesto usa sólo cuentas y contactos validados; las asociaciones pendientes mantienen sus restricciones.

## Base de la estimación

Se revisó el repo al 09/10/2026, incluyendo main hasta `825e1b4`. Los datos de cobertura siguientes provienen de `ESTADO.md` y SQL del repo; aún requieren verificación directa en la base.

- La confirmación de pedidos ya compara el resumen renglón por renglón. Las pruebas de la compuerta de main `0713505` se ejecutaron en esta revisión: **105 chequeos conformes**, sin red ni IA. Sigue siendo necesaria la validación del comportamiento con el modelo real y de las operaciones en la base.
- Existe `wa_memoria_cliente`, identificada por **marca + código**, y el runner ya incorpora la lectura de la ficha aprobada del cliente de LK. La integración equivalente para Chef debe verificarse. La actualización incremental con charlas nuevas sigue pendiente según la documentación actual.
- Se documentan **27.348 mensajes de 664 cuentas**, del 09/06/2025 al 09/06/2026. Falta el período del 10/06/2026 a la fecha actual y el script inicial de importación no está en el repo.
- Se excluyen **87 conversaciones compartidas**, 65 entre LK/CH. Según sql/138, **504 cuentas** tienen conversación propia elegible y **160** sólo aparecen en conversaciones compartidas. El modelo puede proponer asociaciones con evidencia; éstas no conceden acceso a datos privados por sí solas.
- Las pruebas operativas anteriores con servicios simulados reprodujeron derivaciones anunciadas sin persistencia, respuestas perdidas ante rechazo de Meta y efectos repetidos por herramientas dentro de un turno. Se debe comprobar cuáles siguen presentes en la versión elegida y corregirlos antes del piloto.
- No se certificaron aquí el aislamiento real entre clientes en PostgreSQL, los pedidos finales en Gestión ni la entrega completa bot → aviso → Planify. Leer y cerrar tareas propias en Planify se comprobó por separado.
- El problema registrado en la tarea 5343, sobre edición de campos protegidos de `customers`, necesita reproducción o evidencia de protección efectiva antes del piloto.

Los avances del repo se descuentan del trabajo pendiente al iniciar cada jornada. No se vuelve a implementar una función que ya existe; se verifica su comportamiento y se cubren las partes faltantes.

## Plan día por día

Cada jornada apunta a 4–6 horas. Si el criterio de cierre no se cumple, se reestima el calendario antes de ampliar el uso.

| Fecha | Trabajo | Criterio de cierre |
|---|---|---|
| **Mar 13/10** | Confirmar versión desplegada, accesos y responsable humano. Revisar permisos/descuentos. Medir cobertura del historial y analizar una muestra de hasta 100 conversaciones, incluidos contactos desconocidos y ambiguos. | Bloqueos identificados; volumen, calidad y esfuerzo restante de la auditoría estimados. |
| **Mié 14/10** | Corregir o verificar la protección de campos de clientes y el manejo de errores al guardar derivaciones. | Datos protegidos; un aviso que falla no se anuncia como guardado y conserva una vía de recuperación. |
| **Jue 15/10** | Recuperar respuestas rechazadas por Meta con estados persistentes y reintento separado de la recepción. | Un fallo recuperable no pierde la respuesta ni crea otro pedido; el historial refleja el estado real de envío. |
| **Vie 16/10** | Evitar precargas y alertas repetidas dentro de un turno; revisar mensajes simultáneos y múltiples. | Una confirmación produce una sola precarga; cada mensaje tiene un tratamiento definido. |
| **Lun 19/10** | Revisar fichas existentes y asociaciones de contactos. Preparar la importación faltante y deduplicación, con fuentes y fechas. Definir cómo corregir y borrar recuerdos. | Identidades y cobertura de las cuentas del piloto verificadas; plan concreto para casos ambiguos y datos pendientes. |
| **Mar 20/10** | Implementar o verificar la actualización incremental de memoria y la recuperación para varios contactos autorizados; comprobar LK/CH. | La memoria se actualiza con charlas nuevas, persiste tras reinicios y conserva la separación por cuenta y contacto. |
| **Mié 21/10** | Probar recuerdos antiguos con fechas simuladas, conversaciones largas, cambios de modelo, correcciones, borrado y reasignación de teléfono. Medir costo/tiempo. | Recupera hechos relevantes sin mezclar clientes ni usar recuerdos como autorización para operar. Si falta trabajo, reservar dos jornadas adicionales y mover los hitos. |
| **Jue 22/10** | Validar pedidos: un solo “sí”, cambios de cantidades, pago, entrega y precio al guardar. Revisar recuperación si falla el descarte de una precarga. | Se guarda lo aprobado y los errores no dejan operaciones sin seguimiento. Las pruebas pagas se presupuestan antes de ejecutarlas. |
| **Vie 23/10** | Probar el circuito real: WhatsApp → bot → precarga/derivación → alerta → tarea en Planify; verificar acceso a datos propios y ajenos. | El caso llega al responsable correcto y se comprueba el aislamiento real entre clientes. |
| **Lun 26/10** | Validar toma y cierre de casos por el equipo. Revisar las alarmas reprogramadas remotamente en Planify. | Seguimiento comprobado. Para alarmas: app validada o procedimiento operativo documentado. |
| **Mar 27/10** | Ajustar presupuesto, límites, destinatarios y plantillas. Corregir asociaciones temporales de prueba según las autorizaciones existentes. Ensayar pausa y atención manual. | Clientes del piloto permitidos, configuración comprobada y mecanismo de pausa disponible. |
| **Mié 28/10** | Iniciar piloto con **2–5 clientes** y revisión humana de pedidos. Revisar conversaciones, recuerdos y avisos. | Cero incidentes críticos pendientes; pausar si aparecen datos expuestos, pedidos distintos, duplicación o derivaciones perdidas. |
| **Jue 29/10** | Revisar el piloto: costos, tiempos, errores, avisos y memoria entre charlas/contactos. | Evidencia de funcionamiento real y lista priorizada de ajustes. |
| **Vie 30/10** | Corregir lo observado y repetir las pruebas afectadas, incluidas caídas del modelo, Meta y base. | Recuperación comprobada y problemas críticos resueltos. |
| **Lun 02/11** | Ampliar a **10–20 clientes** sólo si el piloto está estable, manteniendo revisión humana. | Equipo capaz de atender la demanda, avisos recibidos y gasto dentro del presupuesto decidido. |
| **Mar 03/11** | Revisar resultados y preparar la decisión de lanzamiento, responsables y procedimiento de incidentes. | Bloqueos cerrados y evidencia suficiente para habilitar una etapa mayor. |
| **Mié 04/11** | Habilitar una etapa mayor y monitorizar. | Producción gradual con atención y métricas; si faltan criterios, mantener el piloto y reestimar. |

Si la memoria/auditoría consume dos jornadas adicionales, se desplazan los pasos posteriores: piloto el **30/10** y habilitación mayor el **06/11**. Si el volumen o las asociaciones ambiguas requieren más esfuerzo, se revisa el calendario completo. Se necesita un responsable de atención y contingencia durante el piloto, incluidos períodos entre jornadas.

## Memoria e historial anual

El requisito es recordar información útil del cliente entre charlas, incluso meses después y tras reinicios o cambios de modelo. Los precios, saldos, permisos y estados de pedidos se consultan en su fuente actual. Los hechos de una empresa y los de cada persona/contacto tienen ámbitos de acceso definidos.

La auditoría producirá:

1. **Mapa de cuentas y contactos:** empresa, cuenta, números normalizados, evidencia de asociación, validación y vigencia. Un número puede representar más de una cuenta o cambiar de dueño.
2. **Memoria individual:** preferencias confirmadas, acuerdos históricos y seguimiento mediante fuentes actuales. Cada conclusión debe conservar fecha y procedencia.
3. **Conocimiento general revisado:** preguntas frecuentes y procedimientos útiles extraídos de charlas humanas, con excepciones y contradicciones identificadas antes de publicarlos como reglas.

Primero se mide una muestra y se decide presupuesto y procesamiento por lotes. Se conserva el original, se evita pagar reprocesamiento y se valida el registro de gasto y el control de tandas concurrentes. La generación inicial de fichas con Haiku y una auditoría con un modelo más potente son operaciones distintas con presupuestos separados.

La ficha compacta existente no ofrece por sí sola búsqueda de cualquier mensaje antiguo. Si ese comportamiento forma parte del alcance final, se dimensiona y prueba la recuperación de fragmentos con fecha, autor y fuente. El conocimiento general extraído se revisa antes de incorporarlo como política comercial.

## Condiciones para habilitar más clientes

- Protección de campos y aislamiento real entre clientes comprobados.
- Pedidos que coinciden con lo aprobado, sin efectos duplicados.
- Avisos y respuestas con persistencia, entrega/reintento y seguimiento verificables.
- Memoria correcta para las identidades habilitadas, actualización incremental y comportamiento definido ante una asociación desconocida o ambigua.
- Presupuesto medido, límites definidos, responsables disponibles y pausa ensayada.
- Pruebas de las rutas de producción completadas; el simulador y los mocks no sustituyen el circuito real.

## Dependencias y trabajo posterior

Se necesitan acceso de lectura al historial y fichas, configuración de prueba para operaciones controladas, disponibilidad del equipo para resolver identidades y validar conocimiento, y las exportaciones faltantes. La revisión directa del historial en esta sesión quedó bloqueada por el proxy antes de alcanzar Supabase; se preparó la ampliación de red en el entorno, pendiente de aplicar y verificar. No se presupone acceso por haber guardado la configuración.

El experimento con Mistral gratuito, el conocimiento técnico ampliado de artículos y mejoras cosméticas pueden seguir después. Cuando un dato técnico o comercial no esté validado, el bot debe reconocer el límite y derivar. La vigencia de precios sí se confirma si afecta presupuestos o pedidos.

Tareas de Planify relacionadas: **5343** (seguridad de clientes), **5273** (endurecimiento), **5474** (un solo sí), **5314** (presupuesto), **5267** (avisos) y **5532** (memoria inicial/incremental). Este documento no reprograma esas tareas ni habilita clientes, genera fichas o autoriza un gasto.

Referencias: [estado actual](ESTADO.md), [memoria y requerimientos](REQUERIMIENTOS-AGENTE-2026-10-09.md), [comportamiento del agente](AGENTE.md) y [flujos](FLUJOS.md). Revisar el estado desplegado al empezar y actualizar este cronograma cuando cambien las dependencias o resultados.
