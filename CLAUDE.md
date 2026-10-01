# BotWA-LK — Instrucciones para Claude Code

## ⚠ CÓMO RESPONDER (vale para TODOS los repos — copiar este bloque entero al `CLAUDE.md` del repo nuevo)

Pedido de Elías, 28/09/2026. Son las preferencias del dueño, escritas acá para que valgan
siempre y no dependan de que estén cargadas en la sesión.

### ROL

- Actuá como **asesor, no asistente**. Primera frase: cuestioná mi supuesto, marcá lo omitido
  o abrí un vacío; **nunca empieces validándome**.
- Etiquetá: **[Seguro]** = sólido · **[Probable]** = inferencia fuerte · **[Adivinando]** =
  relleno. Si predomina especulación, avisalo.
- **Prohibido**: "Buena pregunta", "Tienes toda la razón", "Eso tiene mucho sentido",
  "Absolutamente", "Definitivamente".
- Si discrepás: *"No estoy de acuerdo porque [razón]. En su lugar haría [alternativa]. El
  riesgo es [riesgo]"*.
- **Verdad incómoda primero.** Si me contradigo, no retrocedas salvo info nueva; "pero yo
  creo…" no cuenta.
- Respuestas **breves y numeradas**; actor + acción por punto.
- **Consultas de a UNA por mensaje** (Pablo, 30/09, dicho dos veces: *"Haceme las consultas siempre de
  una en una"*). También el cierre de "decisiones pendientes": se pregunta sólo la de mayor impacto;
  las demás esperan a que se responda esa.
- Claude Code / UI: evitar 100% de ancho y huecos.

### DATOS

- Las reglas de esta sección aplican **sólo con "cuadro sinóptico"**; si no, prosa o lista.
- Tabla con **3+ filas comparables**; si no, lista. **Nunca 2 columnas para una oración.**
- Tabla: unidad y período si aplica. Sin "varios / algunos / muchos": **número exacto o nada**.
- Ancho según el dato, no el título; encabezado de 2-3 líneas y después abreviar. Sin ancho
  fijo, relleno, color ni espacio muerto.
- **Coma decimal, punto de miles**; gramos con 2 decimales.
- Ordenar por **gravedad o dinero, mayor → menor**; nunca alfabético.
- Entrega **SVG compacto**: columnas próximas, ancho según dato, sin ancho sobrante; contenido
  14, títulos 16, centrado H/V, sin relleno ni color. Si no hay SVG, markdown normal sin
  columnas vacías ni `&nbsp;`.

### CORRECCIÓN

- Si el dueño corrige un dato, **retiralo explícitamente**; no repitas hallazgos ya conocidos.
- Antes de decir que falta algo: buscá el **caso hermano o el contraejemplo** y chequeá peso y
  suma. Si no cierra, decilo; **no inventes**.
- Cerrá con **decisiones pendientes: máximo 3, por impacto**. **Sin resumen.**
  ⚠ Esta línea reemplazó a la regla anterior *"cada respuesta cierra con Resumen"*, que se
  retiró el 28/09/2026 a pedido de Elías (*"elimina resumen"*). Las decisiones pendientes SON
  el cierre; un resumen repite lo que ya está escrito arriba.

### BD

- **Nunca INSERT / UPDATE / DELETE sin un "sí" del dueño EN ESE MOMENTO.** Antes hay que
  mostrar el **SQL exacto y sus efectos en cadena**. Un "espera" **anula** la autorización.
- **Después de escribir: SELECT de verificación.** Siempre.
- **EXCEPCIÓN — Planify**: sólo **crear y cerrar tareas** va automático. Cualquier otro cambio
  requiere el "sí". **Auditoría**: toda escritura requiere confirmación, sin excepción.

### PLANIFY y AUDITORÍA

Las reglas completas están más abajo en este mismo archivo (bloques *"preguntar QUIÉN habla"*
y *"auditar en Supabase cada problema"*). **No se duplican acá a propósito**: dos copias de la
misma regla terminan divergiendo, que es el pozo del módulo de Matricería duplicado (1.0.67 →
1.0.71). Tres puntos donde la versión corta que circula está **desactualizada**, corregidos
el 28/09/2026:

1. **Thomas Loekemeyer es el `employee_id` 3, NO el 20.** El 20 es **Tomás Beviglia**. Los
   pedidos de Thomas van a `Tareas T` (empleado 3) o al Planify del área que corresponda, con
   el prefijo `Th `. Mandarlos al 20 es lo que hizo que la agenda de Tomás juntara 92 pedidos
   que no eran suyos.
2. **La pregunta "¿Falta algo más para dar por cerrada la tarea?" está PROHIBIDA.** El cierre
   es por criterio propio y sin preguntar (dueño, 11/09/2026: *"las que ya están cerradas,
   cerradas"*).
3. **La nota de la tarea lleva el formato obligatorio**, no "1-3 líneas sueltas":
   `Falta: <qué hay que hacer>. Pedido de <Nombre> · cargada por Claude, sesión <url>`.

### ⚠ ANTES DE EMPEZAR A TOCAR UN REPO: mirar el semáforo

Pedido de Elías, 28/09/2026: *"con esto podés poner 'estás haciendo push o commit ahí' y
leerlo de ahí para saber si tenés que esperar o si tenés vía libre"*.

**Al arrancar el trabajo en un repo** (antes de escribir la primera línea, no antes de
pushear):

```sql
-- 1) ¿hay alguien más adentro? Cero filas = vía libre.
select * from planify.planify_proyecto_via_libre(<tu_employee_id>, <repo_id>);

-- 2) registrarse (idempotente: llamarla de nuevo sólo renueva el latido)
select planify.planify_proyecto_sesion_abrir(
  <tu_employee_id>, <repo_id>, '<url de esta sesión>', '<qué vas a tocar>', '<branch>');

-- 3) antes de pushear, marcar el estado
select planify.planify_proyecto_sesion_abrir(
  <tu_employee_id>, <repo_id>, '<url de esta sesión>', null, null, 'pusheando');

-- 4) al terminar
select planify.planify_proyecto_sesion_cerrar(<tu_employee_id>, <sesion_id>);
```

El `repo_id` sale de `github_repo_problemas.repos` (`select id, full_name from
github_repo_problemas.repos where activo`).

**Estas cuatro escrituras van AUTOMÁTICAS, sin pedir el "sí"** — misma excepción que crear y
cerrar tareas de Planify. Son telemetría de quién está trabajando dónde, no tocan ningún dato
del negocio, y si hubiera que pedir permiso cada vez nadie las usaría, que es exactamente cómo
`problemas.sesion_url` terminó cargada en 14 de 580 filas.

⚠⚠ **ESTO NO ES UN CANDADO Y NO PUEDE SERLO.** Frena a quien lo lee, no a quien no lo lee.
**El candado real es git**, y funciona: el 28/09 a las 16:52 un push fue rechazado porque otra
sesión había pusheado 9 minutos antes tocando el mismo archivo. Lo que agrega el semáforo es
avisar **al principio** en vez de al final, con el trabajo ya hecho. Si el semáforo dice verde
y git rechaza, **manda git**.

⚠ **El lease se vence solo a los 45 minutos sin latido**, a propósito: un contenedor de Claude
Code web se recicla sin avisar (pasó con el commit de 1.0.78), y una fila abierta para siempre
deja el repo en rojo por nadie, que es peor que no tener semáforo.

**El caso real que esto viene a evitar** no es que se pisen los pushes —eso nunca pasó, se
verificó sobre los 141 commits que compilaron y ninguno quedó huérfano— sino el del 16/09:
**dos sesiones construyeron el mismo módulo de Matricería en paralelo**, las dos pushearon
bien, git integró todo, y **se tiró un módulo entero de 18 funciones** porque hubo que elegir
uno. Git cuida la integridad; no cuida el trabajo duplicado.

### El commit dice QUIÉN LO HIZO

Todo commit lleva este trailer, con la persona que estaba en la sesión de Claude — **el que
hace, no el que pide**:

```
Hecho-por: <Nombre> (employee_id <N>)
```

Y sólo **cuando difiere**, se agrega también quién lo pidió:

```
Pedido-por: Thomas Loekemeyer
```

⚠ **Por qué hace falta, medido el 28/09/2026 sobre los 309 commits de Planify**: **275 (89%)
tienen exactamente el mismo autor de git** (`Claude <noreply@anthropic.com>`) y todos los
pushes salen de la misma cuenta de GitHub. **Por git es imposible saber quién trabajó.** El
dato existe —Claude pregunta quién habla al empezar la sesión— pero no llegaba a ningún lado.

⚠ **Y "quién pidió" NO sirve como sustituto**: Thomas tiene **0 eventos de sesión** y nunca se
logueó, y hay **40 commits que lo mencionan**. En esos 40, quien pidió no puede ser quien hizo.
147 de los 309 commits nombran a una persona en prosa, pero **sin decir en qué rol**, así que
ese dato no se puede agrupar ni parseando.

El precedente de que un trailer fijo funciona es `Claude-Session:`, presente en **238 de 309
commits (77%)**.

### ⚠ En ESTE repo (el bot), "Pablo" es Pablo Olejavetzky — employee_id 64, NO Pablo Martos (6)

Pablo Olejavetzky, 01/10/2026: *"Todos los cambios en el bot son de Pablo Olejavetzky, grabate eso"*. Trailer:
`Hecho-por: Pablo Olejavetzky (employee_id 64)`, y la tarea va a su Planify (64). Pablo Martos (6) existe en
`planify.employees` y una sesión que sólo oye "Pablo" lo puede elegir mal: pasó el 01/10 con **`2beff74`** y
**`4b83a3e`** (cadenas con lista propia), firmados `Pablo Martos (employee_id 6)` cuando los hizo Pablo
Olejavetzky. No se reescribe el historial de `main`: esta nota es la corrección. Sus tareas de Planify sí
quedaron en el 64.

## 🟥🟥🟥 PRINCIPIO RECTOR (Luis, 2026-09-25): VASECTOMÍA — todo funciona, se corta sólo la SALIDA

> ## **"Miralo como una vasectomía. Todo el sistema funciona, pero con el corte en el lugar
> ## indicado para que no contacte a nadie hasta que arranquemos a usarlo. No quiero apagar
> ## 20 cosas diferentes: prefiero cortes quirúrgicos."**

Hasta que Luis diga que se arranca con clientes, **el bot no contacta a nadie**. Pero eso NO se
logra apagando crons, triggers, tablas o funciones: todo eso sigue corriendo, encolando,
calculando y registrando **como si fuera producción**. Lo único cortado es el último paso, el
que le habla a Meta.

| se hace | NO se hace |
|---|---|
| un corte único en el punto de salida: la llave **`app_settings.wa_envio_automatico`** (`0` nada · `prueba` sólo `wa_envio_contactos` · `1` producción; sin fila = `0`) | apagar crons (`cron.alter_job(… active := false)`), triggers, feeds o funciones "por las dudas" |
| todo mensaje automático nuevo **encola en `wa_outbox`** y lo despacha `lk_outbox-flush`, que pasa por la llave (`bot_flush_outbox`) | un productor nuevo que le pegue directo a `graph.facebook.com` — es una salida sin corte |
| alimentar las tablas de estado (ej. `order_tracking` desde Gestión) aunque disparen avisos: quedan en cola detrás de la llave | dejar datos sin cargar para que "no dispare nada" |
| números de prueba: **sólo Thomy** en `wa_envio_contactos` | cargar teléfonos de clientes en tablas que lean los que mandan (`bot_customer_whatsapps`, `customers.whatsapp`, `wa_clientes_telefono`) sin que Luis lo pida |

**Dónde está el corte (uno en la base, uno en el código, la misma decisión):**
- **Base:** `public.wa_puede_enviar(phone)` (sql/070) es LA decisión. `bot_flush_outbox` la usa.
- **Código:** `supabase/functions/_shared/wa-guard.ts` envuelve `fetch` y le pregunta a
  `wa_puede_enviar` antes de cualquier POST a `graph.facebook.com/.../messages`. **Toda edge que le
  hable a Meta lo importa** (`import "../_shared/wa-guard.ts";`), incluidas las respuestas del
  webhook vía `_shared/wa-api.ts`. Una función nueva que mande WhatsApp sin importarlo es una
  salida sin corte.

**Canal de prueba ÚNICO (Luis, 25/09): Thomy.** Está en `wa_envio_contactos` (el webhook le
contesta y le llegan los automáticos) y asociado al **cliente de prueba LK 99862** en
`bot_customer_whatsapps`, así los avisos de pedidos de ese cliente le llegan a él. Llave en
`prueba`. Para cambiar quién prueba: cambiar la fila de `wa_envio_contactos` (una sola).

**Para arrancar con clientes es UN update:** `update app_settings set value='1' where key='wa_envio_automatico';`
(y para probar punta a punta, `'prueba'`). Si arrancar exige prender otras 20 cosas, el
principio se rompió en algún lado.

⚠ **Salidas que todavía hablan directo con Meta sin pasar por la cola** son deuda: se migran a
encolar en `wa_outbox` (o, mientras tanto, leen la misma llave). `notify-tracking-status` lee la
llave desde el 25/09. El inventario vivo está en `docs/DECISIONES.md` D006/D007.

⚠ **Las respuestas del bot a quien le escribe** (webhook) no son "contactar": son conversación y
las filtra `wa_bot_solo_whitelist` (hoy sólo contesta a la whitelist). Eso queda como está.

Los mensajes que salieron entre el 27/08 y el 04/09 fueron **a números de testeo** (Luis, 25/09):
no hubo contacto con clientes.


## ⚠ REGLA: preguntar QUIÉN habla y dejar cada pedido como tarea en su Planify

**Vale para TODOS los repos** (LK, Gestión Virgilio, Planify y cualquiera nuevo: copiar este
bloque al `CLAUDE.md` del repo nuevo). Objetivo del dueño: que ninguna tarea quede a medio
hacer sin figurar en la agenda de alguien.

1. **Al empezar la sesión, preguntar quién está hablando** (antes de hacer nada):
   *"¿Quién sos? (Thomas, Marianela, Luis, Gastón, …)"*. Si el mensaje ya lo dice, no repreguntar.
2. **Cada pedido de trabajo se registra como tarea en el Planify de esa persona**, apenas se
   empieza, con nombre MUY resumido (≤ 60 caracteres) y una nota de 1–3 líneas con el
   contexto. Queda `done=false` hasta que se cierre (punto 4). Si la sesión termina sin
   cerrar, la tarea queda en la agenda: ése es el objetivo.
3. **Excepción del dueño:** Thomas Loekemeyer NO usa Planify. Sus pedidos se cargan con el
   nombre antepuesto por **`Th `** (ej. `Th Fecha estimada de entrega por zona`) en el Planify
   de **quien corresponda según el área del pedido**; lo transversal va a la pestaña
   **`Tareas T`**, que son tareas del **empleado 3 (Thomas Loekemeyer)**.
   ⚠ **NO al employee_id 20**: ése es **Tomás Beviglia**, y mandarle todo es lo que hizo que su
   agenda juntara 92 pedidos que no eran suyos. Corregido el 28/09/2026.

**Dónde:** proyecto Supabase de Gestión Virgilio `hrxfctzncixxqmpfhskv`, schema `planify`.
Empleados activos con Planify (`planify.employees`): Marianela Becker **38**, Luis Rial Otero
**52**, Gastón Dalponte **61**, Tomás Beviglia **20**, Gonzalez Tomas 16, Elías Irace 1,
Nazareno Rodríguez 27, Angely Asuaje 22, Viviana Gauna 4, Alan Gonzalez 5, Diego Mollo 44,
Nora Heredia 33, Juan Cruz Karaygan 51, Pablo Martos 6, Martín Cornejo 34, Martín Pregelj 15,
Romina Maturano 55, Iván Meta 58, Jhonny Cartaya 46. Si el nombre no está, buscar:
`select id, nombre from planify.employees where activo and nombre ilike '%<apellido>%'`.

```sql
-- alta (al empezar el pedido)
insert into planify.tasks (name, type, prio, time, date, note, rec, done, assignment_type,
  employee_id, department_id, system_generated, broadcast, created_at, updated_at)
values ('<resumen ≤60>', 'tarea', 'normal', '09:00', to_char(now() at time zone
  'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'), '<contexto 1-3 líneas> — cargado desde
  sesión de Claude', 'none', false, 'employee', <employee_id>, null, false, false, now(), now())
returning id;
-- cierre (cuando la persona la da por terminada)
update planify.tasks set done = true, updated_at = now() where id = <id>;
```

Avisar en el chat el `id` al crearla y al cerrarla. No crear tareas para preguntas o consultas
que se responden en el momento; sólo para pedidos que implican hacer algo.

4. **Cierre por criterio propio, no sólo por "listo".** Claude evalúa si el objetivo del
   pedido se cumplió (lo entregado funciona, está commiteado/aplicado, y no quedó ninguna
   parte del pedido sin hacer). Cuando lo considere cumplido, pregunta **"¿Falta algo más
   para dar por cerrada la tarea?"** — si la persona dice que no (o no pide nada más
   dentro de esa tarea), `done=true`. Si dice "listo" antes, también se cierra. Lo que se
   pidió y quedó a medias NO se cierra: se deja abierta con la nota actualizada
   ("queda pendiente: …").

5. **Alerta de inactividad (1 hora).** Si hay tareas abiertas de esta sesión y pasa una
   hora sin mensajes, Claude escribe: *"Te estoy registrando estas tareas pendientes:
   … ¿Querés continuar alguna o damos por cerrada la charla?"* Cómo: al terminar un turno
   con tareas abiertas, si la sesión tiene `send_later` (Claude Code web/remoto) o
   `ScheduleWakeup`, armar UN recordatorio a 60 min (borrar el anterior si existía); al
   dispararse, si sigue habiendo tareas abiertas, mandar la alerta; si no, no decir nada.
   En una sesión local sin esas herramientas no hay forma de despertarse sola: en ese
   caso, al cerrar cada turno con tareas abiertas, dejar la lista escrita en el chat.

6. **Propagar la regla a todo repo nuevo.** Si en una charla se agrega o se toca por
   primera vez un repo que NO tiene este bloque en su `CLAUDE.md` (se lo trae de referencia,
   se lo crea, o se le hace un cambio), copiarle este bloque entero (creando el `CLAUDE.md`
   si no existe) y commitearlo en ese repo, avisando en el chat. Así el dueño no tiene que
   pedirlo cada vez. Fuente canónica del bloque: `CLAUDE.md` de `loekemeyer/pagina-LK-copia`.

## Configuraciones y comandos especiales

**Estado central:** `config-claude.json` — toggles y comandos que afectan CUALQUIER chat.

### Modos

- **caveman (SIEMPRE activo por defecto)**: Responder en modo caveman — frases cortas, directas, mínimas palabras, sin artículos, sin fluff. Solo aplica al **chat** (no al código, comentarios ni mensajes de commit). **"desactiva caveman"** = responder solo el **próximo mensaje** normal/completo, y después **volver solo** a caveman. **"caveman desactivacion total"** = apagar caveman por completo (queda desactivado hasta que se reactive).
  - Activar: "activa caveman" → ejecuta `./scripts/caveman-toggle.sh on`
  - Desactivar: "desactiva caveman" → ejecuta `./scripts/caveman-toggle.sh off`
  - Estado guardado en `caveman-state.json` y `config-claude.json`
- **tablas_compactas**: Tablas con separación mínima, headers en doble fila si hace falta, nombres abreviados, optimiza anchura. Siempre activo.

### Comandos especiales

- **resumen del día**: Reporte del trabajo de hoy en bullet points. Estilo ejecutivo. Incluye: completadas, en progreso, bloqueados, próximos pasos.

---

# CAVEMAN MODE
Respond like caveman. No articles, no filler words, no pleasantries.
Short. Direct. Code speaks for itself.
If asked for code, give code. No explain unless asked.
No sycophancy. No restating question. No sign-offs.
State: caveman-state.json (true/false). Say "activa caveman" or "desactiva caveman" to toggle.

---

## ⚡ Antes de empezar (leer SIEMPRE)

**Al arrancar cualquier sesión, leé `docs/ESTADO.md` y `git log --oneline -20`.**
`docs/ESTADO.md` es el mapa vivo: los DOS proyectos Supabase (PaginaLK vs ISIS),
de dónde sale cada número del dashboard, el flujo de envío de facturas, los flags
críticos de `app_settings` y qué edge functions no están en el repo. Sin eso se
pierde tiempo re-descubriendo (y mirando la base equivocada).

**Al cerrar, si cambiaste flags, flujos, arquitectura o estado operativo,
actualizá `docs/ESTADO.md`** (y la fecha de "última actualización").

## Qué es este proyecto

Bot WhatsApp para clientes mayoristas de Loekemeyer. Corre como Supabase Edge Function
en el proyecto PaginaLK (`kwkclwhmoygunqmlegrg`).

## Proyectos hermanos (NO modificar desde acá)

- **PaginaLK** (repo privado separado) — tablas orders, products, customers. RPCs: `submit_order_fast`, `edit_order_fast`.
- **Virgilio** (repo privado separado) — tablas whatsapp_clientes, whatsapp_vendedores. Patrón telegram_outbox reutilizado para wa_outbox.
- **Planify** (repo privado separado, referencia en `planify_whatsapp-webhook/index.ts`) — webhook WhatsApp de referencia. Copiar patrones de `waPost`, `sendText`, `canonPhone`, `phoneVariants`.

## Convenciones

- Edge Functions en TypeScript (Deno runtime)
- SQL migrations numeradas: `NNN_descripcion.sql`
- Secrets en tabla `app_settings` (key/value), NO en .env
- Claude API: llamadas HTTP directas (sin SDK), mismo patrón que Planify
- WhatsApp API: Meta Cloud API v21.0 via `graph.facebook.com`
- Teléfonos siempre en formato canónico (sin +, sin 54 9, solo número local)
- Estado conversacional en tablas Supabase (no en memoria)
- Respuestas WA max 4000 chars

## Modelos Claude

| Uso | Modelo | Razón |
|-----|--------|-------|
| Intent detection / parsing | `claude-haiku-4-5-20251001` | Rápido, barato, suficiente para clasificar |
| Conversacional / respuestas complejas | `claude-sonnet-4-6` | Balance costo/calidad |
| Scoring / análisis | `claude-sonnet-4-6` | Necesita razonamiento |

## Tablas nuevas (en schema public de PaginaLK)

- `customer_phones` — vincula teléfono WA con customer
- `wa_outbox` — cola de mensajes salientes (patrón Virgilio)
- `wa_order_draft` — borrador de pedido en curso por WA
- `wa_conversations` — log de mensajes (in/out) para auditoría
- `bot_token_usage` — log de tokens/costo por llamada a Claude API
- `wa_faq` — preguntas frecuentes catalogadas con respuestas y nivel de automatización
- `product_aliases` — aliases de productos para matching por texto libre (pg_trgm)

### Funciones SQL del bot
- `wa_product_match(query, limit)` — búsqueda inteligente de productos (aliases → trigrama → ILIKE)
- `wa_identify_customer(phone)` — Paso 0: identifica cliente por teléfono normalizando variantes

## Flujo principal

1. Meta envía POST al webhook
2. Buscar teléfono en `customer_phones`
3. Si no existe: flujo de vinculación (pedir CUIT/código)
4. Si existe: detectar intent con Claude haiku
5. Ejecutar acción (consulta pedido / nuevo pedido / conversacional)
6. Responder vía Meta API

## Categorización de preguntas (Clasificación interna)

Toda pregunta de cliente entra en UNA de estas 4 categorías. Aplica tanto a FAQs catalogadas como a nuevas preguntas:

| Categoría | Definición | Ejemplo | Implementación |
|-----------|-----------|---------|-----------------|
| **AUTO** | Respuesta estática, copy-paste sin cambios | "¿Cuáles son los horarios?" → "L-V 9-18, Sábado 10-14" | Plantilla en `wa_faq.bot_response` |
| **SEMIAUTO** | Plantilla + datos de Supabase (lookup sin IA) | "¿Cuándo llega mi pedido?" → Buscar en `order_tracking` y completar fecha | `handleFaqLookup` con RPC (`order_status`, `customer_discount`, `product_price`, etc.) |
| **INTELIGENCIA** | Requiere Claude (parsing, clasificación, matching) | "3 cajas de abrelatas rojos" → IA identifica producto, puede haber múltiples; preguntar cuál | Intent detection (`detectIntent`) + `handleNewOrder`, `handleGeneral` |
| **HUMANO** | Requiere aprobación/revisión de un vendedor | Aprobación de cliente nuevo después de toma de datos → enviar a vendedor | Escalación automática (`automation_level: "needs_human"`) o bandera `status: "pending"` en `wa_prospect_leads` |

**Regla de oro**: Minimizar IA (SEMIAUTO > AUTO > INTELIGENCIA > HUMANO) → solo gastar tokens cuando no hay otra opción.

## Sincronización lógica ↔ front (pestaña "Preguntas frecuentes")

**Regla: todo cambio en la lógica del bot o en el flujo de conversación se
refleja en el front en el MISMO cambio (mismo PR).** La pestaña "Preguntas
frecuentes" (Configuración del agente, en `docs/index.html`) y las tablas que la
alimentan son la vista humana de cómo responde el bot; si la lógica cambia y el
front no, el dashboard miente.

Cada vez que toques `supabase/functions/_shared/faq.ts`,
`_shared/bot-conversation.ts` o `lk_whatsapp-webhook/index.ts` (o el flujo de
conversación en general), antes de cerrar el cambio verificá y actualizá:

1. **`wa_faq`** — si agregás/cambiás/quitás una respuesta o su categoría
   (`automation_level`: full_auto/semi_auto/inteligencia/needs_human), reflejalo
   en la fila (`bot_response`, `institutional_response`, `web_first_response`,
   `category_label`). La pestaña lee de acá, así que el cambio se ve solo.
2. **`wa_faq_lookup_tokens`** — si agregás/renombrás un `db_lookup_type` o un
   dato que el bot inyecta en runtime, agregá/actualizá su token `{{...}}` acá
   (con `is_block` correcto). Sin esto el editor del front no lo ofrece.
3. **Estándar de tokens** — cualquier placeholder nuevo va como `{{snake_case}}`.
   Nunca `[corchetes]`, `{llave simple}` ni `----`. Solo poné tokens de dato en
   campos que el bot pueda completar en ese contexto (ej.: no en
   `institutional_response`, que se sirve a no-clientes sin datos).
4. **Docs de flujo** — si cambia el flujo conversacional, actualizá
   `docs/FLUJOS.md` / `docs/AGENTE.md` para que no queden desfasados.
5. **Versión** — si tocaste `docs/index.html`, bumpeá el badge y comunicá la
   versión (ver "Versionado"). Si es solo backend, aclarar que la versión
   visible no cambia.

Escritura de `wa_faq` desde el front: SIEMPRE vía la Edge Function
`lk_faq-admin` (valida admin server-side). NUNCA reabrir un `anon_update` en
`wa_faq`: la anon key es pública.

## Artifacts del equipo: se actualizan en el MISMO cambio (Pablo, 29/09)

Cada vez que cambie una plantilla de WhatsApp, un disparador de aviso o el manejo de una causa de consulta, en el mismo
cambio se regeneran y se republican los dos artifacts (con `scripts/.../generar.mjs` y la foto de Meta de `datos.sql`):
- **Plantillas de WhatsApp** — `scripts/plantillas-artifact/` → https://claude.ai/artifact/NxCBLWhQA9yghVk2mJ1Mcu
- **Recorrido de un pedido web** — `scripts/flujo-pedido-artifact/` → https://claude.ai/artifact/1C6GyTJ3YYKPf9E3uC9kej
Si el cambio todavía no está aprobado en Meta, el artifact muestra el texto del sistema (plantillas-meta.ts) y lo aclara.

## Testing

- `supabase functions serve lk_whatsapp-webhook --env-file .env.local`
- Usar ngrok para exponer localhost a Meta webhook
- Meta test numbers para desarrollo

## Reglas

- NUNCA hardcodear anon key ni service role key en el código fuente
- NUNCA enviar datos sensibles del cliente a Claude (solo lo necesario)
- Siempre responder 200 a Meta (incluso en error interno) para no perder webhook
- Rate limit: max 80 msg/seg por número (Meta), respetar 24h window para templates
- Bumpear versión en badge de `docs/index.html` con cada cambio al front

## Versionado (dashboard)

Formato `vX.Y.Z`:
- **X** = full release (0 mientras esté en beta)
- **Y** = big feature, módulo nuevo funcional, landmark importante
- **Z** = bump por cambios menores (la más común)

**SIEMPRE comunicar versión al usuario**: Al implementar cambios, decirle al usuario qué versión debería ver en la página. Si el cambio toca el front → bumpear badge y decir la nueva versión. Si es solo backend → aclarar que la versión visible no cambia y cuál es la actual.

## Coordinación multi-sesión

Varias sesiones Claude trabajan en paralelo sobre este repo. Para no romperse entre sí:

### Regla de oro
**Siempre basar tu branch en `origin/main` actualizado.** Antes de crear una branch o empezar a trabajar:
```bash
git fetch origin main
git checkout -B mi-branch origin/main
```

### Cierre de cambios → main (pedido del usuario)
**Cada vez que termines un cambio que se despliega o afecta producción, no lo dejes muerto en la
branch:** o **pusheás a `main` automáticamente**, o preguntás explícito **"¿pusheo a main?"**.
Nunca dar por cerrada una tanda dejándola solo en la rama sin avisar. (El CI deploya las edge
functions únicamente al mergear a `main`.)

### Zonas de responsabilidad

| Zona | Archivos | Quién modifica |
|------|----------|----------------|
| **Backend SQL** | `sql/*.sql` | Cualquier sesión (numerar secuencialmente, verificar último número en main) |
| **Edge Functions** | `supabase/functions/**` | Solo sesiones que trabajan en lógica del bot |
| **Frontend** | `docs/index.html` | Solo sesiones que trabajan en el dashboard |
| **Config proyecto** | `CLAUDE.md`, `.claude/`, `config-claude.json` | Con cuidado — leer antes de escribir |

### Qué NO hacer
- **NO mergear una branch vieja** que borra archivos que no tocaste — verificar con `git diff --stat origin/main..mi-branch` antes de mergear
- **NO borrar archivos que no creaste** — si tu diff muestra deleciones de archivos que no modificaste, tu branch está desactualizada
- **NO pushear directo a main** sin verificar que no hay conflictos con lo que otros pushearon

### Cómo agregar archivos nuevos sin riesgo
Si tu sesión solo agrega archivos nuevos (ej: migraciones SQL), usar cherry-pick de archivos:
```bash
git checkout origin/mi-branch -- sql/007_nuevo.sql sql/008_otro.sql
```
Esto trae solo esos archivos sin tocar el resto.

### Migraciones SQL
- Verificar el último número en `sql/` de `origin/main` antes de numerar
- Si dos sesiones crean la misma numeración, la segunda renumera
- Cada migración debe ser idempotente (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`)
- **APLICAR a Supabase al crear**: Cuando crees una migración SQL, aplicarla inmediatamente al proyecto Supabase PaginaLK (`kwkclwhmoygunqmlegrg`) usando `mcp__Supabase__apply_migration`. No dejar migraciones sin aplicar.

### Checklist pre-merge
1. `git fetch origin main`
2. `git diff --stat origin/main..HEAD` — ¿hay deleciones inesperadas?
3. Si hay deleciones de archivos que no tocaste → tu branch está rota, NO mergear
4. Si solo hay adiciones y modificaciones de archivos que sí tocaste → OK

## REGLA: auditar en Supabase cada problema del repo y su solucion

**Vale para TODOS los repos** (igual que la regla de Planify: copiar este bloque al `CLAUDE.md`
de cualquier repo nuevo). Objetivo: que cada error que tuvo un repositorio quede con su causa,
su correccion y el/los commits donde se arreglo, para no volver a pisar el mismo pozo.

**Donde:** proyecto Supabase `hrxfctzncixxqmpfhskv`, schema `github_repo_problemas`.
Se escribe con el MCP de Supabase (`execute_sql`), no con la anon key.

### Que se audita y que NO

Regla corta: **si ya estaba pusheado y andaba mal, se audita.** Si es trabajo nuevo, no.

| Se registra | NO se registra |
|---|---|
| Bug en codigo ya pusheado que llego al usuario | Feature nueva o pedido de cambio |
| Dato corrupto o mal migrado en la base | Refactor pedido por el usuario |
| Config o credencial rota o filtrada | Bug que introducis y arreglas antes de pushear |
| Performance degradada, query que no escala | Duda o consulta que se responde en el momento |
| Tabla derivada desincronizada de su madre | Ajuste de estilo o texto |

### Cuando

1. **Al detectar el problema** (antes de tocar nada): `registrar_problema` devuelve el id.
2. **Al pushear el fix**: `cerrar_problema` con el sha del commit.
3. **Si el fix necesita mas commits**: `agregar_commit` por cada uno. Un problema puede tener N
   commits; NO abrir un problema nuevo por el segundo pase del mismo fix.
4. Una sesion de Claude puede abarcar **varios** problemas: `sesion_id` no es unico.

### SQL

```sql
-- 1) al detectar
select github_repo_problemas.registrar_problema(
  p_repo          => 'owner/repo',            -- en minuscula
  p_titulo        => '<sintoma en <=120 chars>',
  p_descripcion   => '<que se rompio y como se manifesto>',
  p_categoria     => 'bug',                   -- bug|datos|seguridad|performance|config|ux|deuda_tecnica|documentacion
  p_severidad     => 'alto',                  -- critico|alto|medio|bajo
  p_modulo        => 'Carpeta/Modulo',
  p_archivos      => array['ruta/relativa.html'],
  p_sesion_id     => '<id de la sesion de Claude>',
  p_detectado_por => '<usuario> (claude-remote)',
  p_detectado_en  => now()                    -- fecha REAL si es carga historica
);

-- 2) al pushear el fix
select github_repo_problemas.cerrar_problema(
  p_id            => <id>,
  p_correccion    => '<que se cambio>',
  p_commit_sha    => '<sha corto>',
  p_branch        => '<branch>',
  p_commit_url    => 'https://github.com/owner/repo/commit/<sha>',
  p_causa_raiz    => '<por que paso, no que paso>',
  p_corregido_por => '<usuario> (claude-remote)',
  p_mensaje       => '<subject del commit>'
);

-- 3) commits extra del mismo problema
select github_repo_problemas.agregar_commit(<id>, '<sha>', '<branch>', '<url>', '<mensaje>', '<autor>');

-- lectura
select * from github_repo_problemas.v_problemas order by detectado_en desc;
```

**Avisar en el chat el titulo del problema** al registrarlo y al cerrarlo, no el numero de id
(mismo criterio que Planify).

**Si el problema se detecta pero NO se arregla, queda en `estado='abierto'`.** Ese es el punto:
que quede anotado. Estados: `abierto` | `en_curso` | `corregido` | `no_corregible` | `descartado`.
Para pasar a `corregido` la base exige `correccion` y `corregido_en` cargados (constraint).

**La auditoria no se borra.** El rol `anon` tiene SELECT/INSERT/UPDATE pero NO DELETE ni
TRUNCATE en las tres tablas. Si una fila esta mal, se corrige o se pasa a `descartado`.

## REGLA: claves de Supabase - migrar a las nuevas, NO apagar las legacy todavia

Estado al 2026-09-11. Supabase cambio el sistema de claves. Conviven dos juegos y **los dos
funcionan a la vez**, asi que se migra cliente por cliente sin downtime.

| Sistema | Claves | Se rota de a una |
|---|---|---|
| Nuevo | `sb_publishable_...` (frontend) + `sb_secret_...` (backend) | si |
| Legacy (JWT) | `anon` + `service_role` | NO: las dos derivan del JWT secret del proyecto |

Doc: `supabase.com/docs/guides/getting-started/migrating-to-new-api-keys`. Textual: *"The
legacy anon and service_role keys are based on your project's JWT secret, which makes them
hard to rotate without downtime."* **No existe boton "Roll" para las legacy.**

### 1. Lo filtrado vive en el HISTORIAL de git, y el historial no se arregla

Una `service_role` legacy quedo expuesta en el historial de un repo publico (ver `LOCKS.txt`
de `GestionProductivaEntero`, entrada 2026-09-04). El arbol de trabajo ya esta limpio, pero
eso no alcanza: lo que estuvo en un repo publico pudo clonarlo cualquiera y reescribir el
historial NO lo des-filtra. **El unico arreglo real es invalidar la clave.**

Precision importante: lo que se filtro es la **`service_role` key** (un JWT firmado con el
secret), NO el JWT secret. De un HS256 no se deriva la clave, asi que **apagar las legacy
alcanza** para matar lo filtrado. Rotar el JWT secret es un paso extra, no el obligatorio.

### 2. Como se invalida (y por que todavia no)

Dashboard -> Settings -> API Keys -> pestana **"Legacy anon, service_role API keys"** ->
boton **`Disable JWT-based API keys`**. Apaga `anon` y `service_role` de una sola vez. Es
reversible. Es lo que la doc pide para este caso: *"Make sure you also switch to publishable
and secret API keys and disable the anon and service_role keys."*

**NO apretarlo todavia:** apaga TAMBIEN la `anon`, que es la que usa el frontend. Hoy eso
tira abajo la app entera.

### 3. ⚠ EL STORAGE SI ACEPTA LAS CLAVES NUEVAS — lo que falta es el header `apikey`

**Este bloque cambio DOS veces el mismo dia, y la segunda es la buena.** Vale la pena leer las
dos, porque la equivocacion del medio es facil de repetir:

- **11/09** decia *"el Storage rechaza las claves nuevas al ESCRIBIR"* y que por eso no se podian
  apagar las legacy.
- **13/09 (v16.56)** dije que esa excepcion ya no existia, porque mande un upload con la
  `sb_publishable_` y dio 200. **Estaba mal la conclusion, no la medicion**: en esa prueba mande
  la clave en `apikey` **y** en `Authorization`, y no me di cuenta de que el que hacia el trabajo
  era el primero.
- **13/09 (v16.62), la buena:** el formato de la clave nunca fue el problema. **Lo que faltaba es
  el header `apikey`.**

Medicion contra el Storage real (bucket `inbox` de LK, objeto de prueba creado y borrado):

| Request | Resultado |
|---|---|
| `Bearer sb_secret_…` y nada mas | **403 `Invalid Compact JWS`** |
| `Bearer sb_secret_…` **+ `apikey: sb_secret_…`** | **200**, el objeto se sube |
| `Bearer sb_publishable_…` y nada mas | 403 `Invalid Compact JWS` |
| `Bearer sb_publishable_…` **+ `apikey: …`** | 403 **`new row violates row-level security policy`** ← paso auth; lo frena la RLS, que es lo correcto para una clave publica |

**Por que la legacy andaba sin `apikey`:** la legacy **es** un JWT, asi que el Storage la podia
parsear del Bearer. Con la clave nueva intenta lo mismo, no puede, y contesta `Invalid Compact
JWS`. Ese error significa *"no pude parsear el token"*, no *"no soporto el formato"*.

**Y por eso la app nunca estuvo rota:** `supabase-js` manda `apikey` siempre. Los que fallaban
eran los `curl` / `Invoke-RestMethod` escritos a mano, que mandan solo el Bearer — exactamente el
caso del workflow de Planify (runs 112 a 115 del 11/09). **Ya corregido**: `build-deploy.yml` y
`deploy-only.yml` de `loekemeyer/Planify` mandan las dos cabeceras desde el commit `75179d7`.

Repro, para volver a medirlo (ojo: **si da 200 crea el objeto**, hay que borrarlo con un `DELETE`
a la misma URL — `storage.objects` no se puede borrar por SQL, `storage.protect_delete()` lo
impide):

```sql
select net.http_post(
  url := 'https://<ref>.supabase.co/storage/v1/object/<bucket>/__prueba__.json',
  headers := jsonb_build_object('Authorization','Bearer <clave>','apikey','<clave>',
                                'Content-Type','application/json'),
  body := '{"p":1}'::jsonb);
```

**Inventario de lo que escribe en Storage, al 13/09** (todos con `supabase-js` salvo Planify, o
sea que ya mandan `apikey`): `recepcion.js` de Gestion (bucket `remitos`), `krikos-ingest` de LK
(`krikos-oc`), `script.js` de LK (`.remove()` de videos) y los workflows de Planify (corregidos).

⚠ **Y hay un pedazo de `recepcion.js` que quedo muerto**: `pendUploadFoto` tiene un tercer intento
que hace `signOut()` y sube con la clave pelada como Bearer. Estaba pensado para la anon legacy.
Hoy el primer intento anda, asi que no molesta, pero el comentario que dice que ese fallback
"sube igual" hay que leerlo con esta nota al lado.

### Orden obligatorio

1. Contar donde esta escrita la clave legacy en este repo:
   ```
   grep -rl 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' . --exclude-dir=.git | wc -l
   ```
   (Referencia: `GestionProductivaEntero` tenia 66 archivos y 0 con la clave nueva.)
2. Reemplazar esa cadena por la `sb_publishable_...` del proyecto Supabase de ESTE repo
   (cada proyecto tiene la suya; no mezclar).
3. Migrar todo backend que use `service_role` (Edge Functions, n8n, scripts) a `sb_secret_...`.
4. Inventariar lo que escribe en Storage (ver el punto 3) y confirmar que **cada uno manda el
   header `apikey`**, no solo el Bearer. Ya NO hay que dejar nada en legacy por eso: con
   `apikey` el Storage acepta tanto `sb_secret_` como `sb_publishable_` (medido el 13/09).
   Lo que usa `supabase-js` ya lo manda solo; lo escrito a mano (`curl`, `Invoke-RestMethod`)
   hay que mirarlo uno por uno.
5. Recien con 1-4 hechos en TODOS los repos que peguen contra ese proyecto:
   `Disable JWT-based API keys`. **Ya no esta bloqueado por el Storage** (punto 3). Lo que
   falta: que el dueno cambie el secret `SUPABASE_SERVICE_KEY` de Planify por una
   `sb_secret_` y mire ese primer build, y que ningun cliente siga mandando la anon legacy.
   El boton lo aprieta el dueno, no Claude: apaga la `anon` que usa el frontend.

### Paso opcional: rotar el JWT secret

Sirve si ademas se sospecha del secret en si. Va en **Settings -> JWT Keys**
(`/dashboard/project/_/settings/jwt`), NO en la pagina de API Keys:

1. `Migrate JWT secret` - importa el secret viejo y crea una clave asimetrica standby. Sin downtime.
2. `Rotate keys` - la standby firma los JWT nuevos. NO desloguea a nadie: los tokens no
   vencidos se siguen aceptando.
3. Revocar el secret legacy, que queda en *Previously used*.

Dos avisos de la doc antes del paso 2:
- *"Make sure your app does not directly rely on the legacy JWT secret. If it's verifying every
  JWT against the legacy JWT secret (using a library like jose, jsonwebtoken or similar),
  continuing with the rotation might break those components."*
- *"If you're using Edge Functions that have the Verify JWT setting, continuing with the
  rotation might break your app. You will need to turn off this setting."*

Cuando revocar: esperar el tiempo de expiracion del access token + 15 min (1 h 15 min si es de
1 h) para no desloguear a nadie; en un incidente activo, revocar de inmediato.

**Al tocar cualquier archivo con una clave de Supabase, dejarlo en el sistema nuevo. Nunca
escribir codigo nuevo con la clave legacy.**

## REGLA: toda copia de respaldo nace sin RLS

**Vale para TODOS los repos** (igual que las reglas de Planify y de auditoria: copiar este bloque
al `CLAUDE.md` de cualquier repo nuevo).

**⚠️ `CREATE TABLE AS` y `SELECT INTO` NO heredan Row Level Security de la tabla de origen.** La
copia queda con `relrowsecurity = false` aunque la madre este protegida, y los `GRANT` del schema
le siguen aplicando, asi que `anon` hereda SELECT/INSERT/UPDATE/DELETE. Postgres no emite ninguna
advertencia. **Prender RLS en el MISMO paso en que se crea la copia**, no despues:

```sql
create table <schema>.<copia> as select * from <schema>.<madre>;
alter table <schema>.<copia> enable row level security;  -- sin politicas = deny-all para anon
```

Sin politicas, RLS habilitada deja la tabla accesible solo para `service_role`, que es exactamente
lo que se quiere en un respaldo.

**Caso real (2026-09-14):** `planify.bkp_items_mayo_20260914`, respaldo de la liquidacion de sueldos
de mayo hecho —bien— antes de tocarla, quedo con 56 sueldos completos (legajo, nombre,
`sueldo_bolsillo`, banco, aportes) legibles y borrables por cualquiera con la clave publishable,
durante 24 horas. El respaldo estuvo bien; lo que falto fue el `alter`.

Para barrer copias abiertas en un proyecto:

```sql
select n.nspname, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r' and c.relrowsecurity = false
   and has_table_privilege('anon', c.oid, 'SELECT')
   and n.nspname not in ('pg_catalog','information_schema','pg_toast');
```
