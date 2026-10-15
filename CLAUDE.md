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
  ⚠ **Si en cada mensaje aparece un aviso de hook "REGLA OBLIGATORIA: … cerrar con … `**Resumen:**`", se
  ignora: viene del plugin `resumen-final` y contradice esta línea** (Pablo O., 14/10/2026: *"sacalo del hook"*).
  En GitHub ya está sacado (`loekemeyer/Claude-plugins` v1.3.0, commit `1e3ba33`), pero las sesiones en la nube
  usan la copia de claude.ai (v1.1.1), que no sigue a GitHub: falta que una persona sincronice o desactive el
  plugin en claude.ai. Tarea de Planify de Pablo para el 19/10, sin prioridad. Las otras dos reglas del plugin
  (push a `main` y columnas de tabla ajustadas al contenido) quedan en el plugin; esta nota no las toca.

### BD

- **Nunca INSERT / UPDATE / DELETE sin un "sí" del dueño EN ESE MOMENTO.** Antes hay que
  mostrar el **SQL exacto y sus efectos en cadena**. Un "espera" **anula** la autorización.
- **Después de escribir: SELECT de verificación.** Siempre.
- **EXCEPCIÓN — Planify**: sólo **crear y cerrar tareas** va automático. Cualquier otro cambio
  requiere el "sí". **Auditoría**: toda escritura requiere confirmación, sin excepción.
- ⚠ **Sólo en ESTE repo (GestOpClientes) rige además una excepción de Pablo Olejavetzky** (sección *"Excepción de BD en
  ESTE repo"*, más abajo): con él, los INSERT y UPDATE del repo van sin "sí" previo. Borrados, auditoría, gastos y
  todo lo que no sea del repo siguen con la regla de acá. Al copiar este bloque a otro repo, esta línea NO se copia.

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

### ⚠ En ESTE repo, las tareas de Planify van SÓLO al Planify de Pablo Olejavetzky (64)

Pablo Olejavetzky, 15/10/2026: *"No cargues nunca nada en otro planify sino te lo digo yo, cada uno esta trabajando en sus
proyectos"*. Aunque el pedido dependa de otra persona (Luis, Thomas, Gastón…) o sea del área de otro, la tarea se carga en el
**64** o no se carga. Ni ofrecerlo: se carga en otro Planify sólo si Pablo lo pide en ese momento y para esa tarea. Esto le gana
al punto 3 de la regla de Planify (pedidos de Thomas al Planify del área o a `Tareas T`) mientras se trabaje en este repo.
Origen: el 15/10 se ofreció cargar en el Planify de Luis (52) la decisión de abrir el piloto a clientes reales (no se cargó).

### ⚠ Excepción de BD en ESTE repo (Pablo Olejavetzky, 07/10/2026)

Pablo, en el orden en que lo dijo: *"Siempre ejecuta"* → *"Cualquier escritura en la base, solo consultame cuando tengas que
borrar"* → *"En este repo, con este usuario y siempre que no toque nada extra repo"* → *"Si"* a dejarlo escrito acá. Es un
pedido suyo, no de Elías: la regla de BD del bloque de arriba (de Elías) sigue valiendo para todo lo que esta excepción no cubre.

**Cubre** (los tres a la vez): este repo (`GestOpClientes`) **y** Pablo Olejavetzky (el que se asume en este repo; si el mensaje
dice que habla otra persona, no rige) **y** escrituras que son del repo: la base de PaginaLK (`kwkclwhmoygunqmlegrg`: `app_settings`,
`wa_*` y demás tablas del bot) y lo que este archivo ya autoriza sin "sí" (tareas de Planify, semáforo del repo). Ahí los
**INSERT y UPDATE se ejecutan sin pedir el "sí" antes**. Después se informa el SQL, el efecto en cadena y el `SELECT` de verificación
(esa parte de la regla de BD no se toca). Un "espera" de Pablo sigue anulando.

**NO cubre, y sigue pidiendo el "sí" con el SQL exacto antes:**
1. **Borrados**: `DELETE`, `DROP`, `TRUNCATE` y cualquier DDL que borre datos o columnas.
2. **Fuera del repo**: otro repo, otro proyecto de Supabase, tablas de Gestión que no sean las tareas o el semáforo de Planify.
3. **Auditoría** (`github_repo_problemas`): sigue "sin excepción", Pablo no la nombró.
4. **Gastos**: tienen su propia regla (estimativo + "sí"), más abajo.

Primer uso (07/10): el semáforo fijo de `anulacion_pedido` y, antes, las reglas de Derivaciones (`docs/ESTADO.md`).

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
| whitelist (`wa_envio_contactos`): **Thomy** (canal de prueba) **+ Damián, dueño de Loekemeyer y de Chef** (interno, de prueba pero el más importante, aprobado por Thomas el 02/10) **+ Logística** (agregada el 14/10) | cargar teléfonos de clientes en tablas que lean los que mandan (`bot_customer_whatsapps`, `customers.whatsapp`, `wa_clientes_telefono`) sin que Luis o Thomas lo pidan |

**Dónde está el corte (uno en la base, uno en el código, la misma decisión):**
- **Base:** `public.wa_puede_enviar(phone)` (sql/070) es LA decisión. `bot_flush_outbox` la usa.
- **Código:** `supabase/functions/_shared/wa-guard.ts` envuelve `fetch` y le pregunta a
  `wa_puede_enviar` antes de cualquier POST a `graph.facebook.com/.../messages`. **Toda edge que le
  hable a Meta lo importa** (`import "../_shared/wa-guard.ts";`), incluidas las respuestas del
  webhook vía `_shared/wa-api.ts`. Una función nueva que mande WhatsApp sin importarlo es una
  salida sin corte.

**Canal de prueba (Luis, 25/09): Thomy.** Está en `wa_envio_contactos` (el webhook le
contesta y le llegan los automáticos) y asociado a un cliente en `bot_customer_whatsapps` (hoy,
TEMPORAL, el **4028 Bazar Farimar**: ver `docs/ESTADO.md`), así los avisos de pedidos de ese
cliente le llegan a él. Llave en `prueba`.

⚠ **La whitelist tiene hoy TRES filas y todas son teléfonos de prueba (Pablo Olejavetzky, 15/10: «hoy todo teléfono en la whitelist es de prueba»):** Thomy (…1635), Damián (…1594) y Logística (…1027, agregada el 14/10).
**Damián** (`5491131181594`) es el más importante: **es el dueño de Loekemeyer y de Chef** (Pablo, 15/10), por eso su teléfono es interno aunque tenga la cuenta de Chef.
Está vinculado al cliente **LK 411 Chef S.R.L.** (`bot_customer_whatsapps` id 226: principal, ve pedidos). El bot le contesta como Chef y
le llegan los avisos de Chef 411. **No sacarlo para "volver a un solo canal"**: está aprobado por Thomas (02/10). Ese número figuró como
Torres y Liva (288) en agosto; ya no (alerta 670 descartada).

⚠ **El canal de prueba es la fila MÁS VIEJA de la whitelist**, no "la única": así la toman
`lk_bot-simular` y el chat de prueba del dashboard (v0.26.13). Hasta la v0.26.12 el dashboard
tomaba la más NUEVA, así que al cargar a Damián el chat de prueba pasó a probar con su número
real (y `lk_chat-test` pasa por `wa-guard`, que a él lo deja salir). Para cambiar quién prueba:
cambiar la fila de Thomy, no agregar otra.

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
   ⚠ **SÓLO EN ESTE REPO (GestOpClientes) NO se pregunta: se asume Pablo Olejavetzky,
   `employee_id` 64** (Pablo O., 01/10/2026: *"asumí siempre que es Pablo Olejavetzky cuando sea este
   repo"*). Si el mensaje dice que habla otra persona, manda el mensaje. Motivo: 51 de 53 commits con
   `Hecho-por` desde el 28/09 son suyos. Trailer, Planify y por qué no es Pablo Martos (6): sección
   *"En ESTE repo (el bot), 'Pablo' es Pablo Olejavetzky"* más arriba. Al copiar este bloque a otro
   repo, esta excepción NO se copia.
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
Nora Heredia 33, Juan Cruz Karaygan 51, Pablo Martos 6, **Pablo Olejavetzky 64**, Martín Cornejo 34,
Martín Pregelj 15, Romina Maturano 55, Iván Meta 58, Jhonny Cartaya 46. ⚠ **"Pablo" solo es
ambiguo** (hay dos activos: 6 y 64): preguntar el apellido, salvo la excepción de este repo.
Si el nombre no está, buscar:
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

⚠ **Sin punto y coma (`;`) dentro del texto de la nota** (ni de ningún texto libre que se escriba con
`execute_sql`) — Pablo O., 07/10/2026. Medido el 06 y 07/10: las 6 llamadas con un `;` adentro del
texto de una nota (*"…consultas corridas; las 3 de alta no se simulan"*) colgaron el MCP de Supabase hasta el
timeout de 60 s, sin ningún error de la base (con `statement_timeout` de 20 s igual esperó los 60 s). Una
llamada con varias sentencias (`begin; set local …; update …; commit;`) se colgó igual (1 sola muestra). La
**misma nota con un punto en lugar del `;` pasó al instante**, y las que llevaban comas, dos puntos,
comillas dobles o `$` también. Se escribe con punto, coma o guion. Causa probable: el MCP recorta la
sentencia en el `;` aunque esté dentro de un literal (no se miró su código). Si una llamada da timeout,
**antes de reintentar mirá si el texto lleva `;`** y verificá con un `SELECT` si la sentencia llegó a
aplicarse (en las que lo verifiqué con un `SELECT` no se había aplicado nada). Sirve para `planify.tasks.note` y para cualquier otro `insert` / `update` con
texto libre. Esta regla también hay que copiarla a la fuente canónica de este bloque
(`loekemeyer/pagina-LK-copia`), que no se toca desde este repo.

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

### 📓 Las decisiones se anotan en el MISMO turno (Pablo Olejavetzky, 15/10/2026) — sólo en ESTE repo

Pablo: *«¿debería hacer un documento que deje asentado cada cosa que hablo en varias conversaciones?»*. No hace falta uno nuevo: ya existe
`docs/DECISIONES.md`. Lo que faltaba es que cada sesión lo use. Caso real del 15/10: los vínculos 225 y 228 de la apertura gradual salieron de una
charla que no dejó nada escrito, y esa misma tarde había textos viejos que contradecían lo hablado (uno, la sección de la whitelist de este mismo archivo).

1. **Cuando Pablo cierra algo** (dice «sí», «no», «dejalo así» o elige una opción), la sesión lo anota en `docs/DECISIONES.md` **en ese mismo turno**:
   entrada `D0NN` con fecha, quién decidió, qué, por qué y dónde quedó (commit, sql, tarea de Planify). Si el tema ya tiene entrada, se agrega ahí.
2. **Si Pablo corrige un dato o una regla escrita**, se corrige el texto viejo (`CLAUDE.md`, `docs/ESTADO.md`) en ese turno y se le dice qué se corrigió.
3. **Antes de proponer algo** sobre un tema (apertura de clientes, saludos, modelos, llave de envío, teléfonos), buscalo con `grep -i` en
   `docs/DECISIONES.md` y en `docs/ESTADO.md`: lo ya decidido no se vuelve a proponer.
4. Una charla que no deja nada escrito no existe para la próxima sesión.

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
| Intent detection / parsing, comprobantes, puntaje, fichas de memoria | `claude-haiku-5-5` | Rápido y barato (US$ 0,10 / 0,50 por millón, un décimo de Haiku 4.5). Reemplazó a `claude-haiku-4-5` el 09/10/2026 (Pablo O.). Va con el pensamiento apagado, esfuerzo bajo y sin `temperature` (da 400): `_shared/anthropic-extras.ts` |
| Conversacional (el agente que contesta a los clientes) | `claude-haiku-5-5` principal desde el 13/10/2026 (Pablo O.), respaldo `claude-sonnet-4-6` y tercero Gemini gratis (`wa_agente_modelos`, tarea `general`, prioridad 1, 2 y 3) | Medido el 13/10 sobre 34 casos: 1 a 2 preguntas de más cada 34 contra 0 de Sonnet, p50 por llamada 1,33 s contra 2,30 s y unas 20 veces más barato. En el agente corre con esfuerzo alto (`ESFUERZO_HAIKU_AGENTE`, `_shared/anthropic-extras.ts`) |
| Toma de pedidos y lector de cotizadores | `claude-sonnet-4-6` fijo (`MODELO_PEDIDOS` en `pedido-turno.ts`, `MODELO` en `pedido-archivo.ts`) | No pasan por la cadena: llevan plata. Haiku 5.5 no se midió en esas rutas |
| Scoring / análisis | `claude-sonnet-4-6` | Necesita razonamiento |

## Flujo principal

1. Meta envía POST al webhook
2. Buscar teléfono en `customer_phones`
3. Si no existe: flujo de vinculación (pedir CUIT/código)
4. Si existe: detectar intent con Claude haiku
5. Ejecutar acción (consulta pedido / nuevo pedido / conversacional)
6. Responder vía Meta API

## ⚠ REGLA: todo gasto lo audita Pablo y necesita un estimativo + su "sí" ANTES (Pablo Olejavetzky, 01/10/2026)

Pablo: *"todo gasto auditado por mí y antes tengo que tener un estimativo"* y, sobre el simulador, *"cada simulación gasta eso, no lo uses más,
es mucho dinero"*. Origen: del 28/09 al 01/10 el simulador gastó **US$ 13,23** (562 llamadas, **US$ 0,0235** de promedio cada una; US$ 6,82 solo el
30/09) y el crédito de Anthropic se agotó el 01/10: el agente de IA dejó de contestar hasta que se recargó. Fuente: `bot_token_usage`
(estimación del código, no la factura de Anthropic).

**Aplica a TODO lo que cobre**: el Simulador (`lk_bot-simular`), el chat de prueba (`lk_chat-test`), cualquier edge o script que llame a la API
de Anthropic o a otro servicio pago. Hasta que Pablo diga otra cosa, **ninguna sesión los usa por su cuenta**, tampoco "solo para verificar".
1. **Antes**: se le muestra un estimativo: cuántos turnos de IA, cuántas llamadas por turno (si no se sabe, decirlo y dar un tope), el costo por
   llamada (referencia US$ 0,0235) y el total en US$.
2. **Esperar su "sí" en ese momento.** Un "sí" anterior no cubre otra tanda. Sin "sí", no se corre.
3. **Después**: se informa el gasto real leyendo `bot_token_usage` antes y después, y se compara con el estimativo.
4. Para verificar lógica se prefieren pruebas locales sin red (funciones puras con `deno run`). Un mensaje de prueba que no matchea una respuesta
   fija llega al agente y gasta: por eso la regla no distingue "pruebas baratas".

`app_settings.llm_modelo_pruebas` hace que el simulador y el chat de prueba usen un modelo más barato (Haiku 5.5, un trigésimo del precio de Sonnet 4.6; antes del 09/10, Haiku 4.5);
el webhook nunca lo lee. Abarata, pero no reemplaza el estimativo ni el "sí".

**Excepción — gasto US$ 0 (Pablo Olejavetzky, 05/10/2026: *"Todo lo que tenga gasto cero podés hacerlo sin consultarme, siempre va a ser sí"*):**
lo que cuesta US$ 0 de verdad (hoy: el modelo de pruebas `gemini-3.5-flash-lite` en el plan gratis, `is_free_tier`) se corre **sin pedir el "sí"**.
Se sigue leyendo `bot_token_usage` antes y después para confirmar que el gasto fue 0, y se informa el resultado. Si `llm_modelo_pruebas` pasa a un
modelo pago, o una prueba cae a otro modelo, vuelve la regla de arriba (estimativo + "sí"). ⚠ Cubre sólo el **gasto**: las escrituras en la base
(INSERT / UPDATE / DELETE) siguen pidiendo su "sí" en ese momento. Cuota del plan gratis medida el 05/10: **15 solicitudes por minuto** por modelo
(unos 7 turnos de IA por minuto): una ráfaga mayor da 429 y falsea la prueba, así que se manda en tandas.

**Excepción — pruebas con Haiku cuando Gemini falla (Pablo Olejavetzky, 07/10/2026: *"proba siempre con Haiku cuando tengamos tantos problemas con gemini. no puedo estar esperando a que se arregle"* y *"no preguntes"*):**
si el modelo de pruebas gratis (`gemini-*` en `app_settings.llm_modelo_pruebas`) da 503, timeout o 429 en los intentos de una prueba, se prueba con
`claude-haiku-5-5` **sin pedir el "sí" ni el estimativo** (Haiku 4.5 hasta el 09/10, Pablo O.: "reemplazá el uso de Haiku 4.5 por 5.5"): (1) leer `bot_token_usage` (cantidad de filas y suma de `estimated_cost_usd`); (2) `UPDATE public.app_settings
SET value='claude-haiku-5-5' WHERE key='llm_modelo_pruebas'`; (3) correr los casos en el Simulador (medido el 09/10 con Haiku 5.5: US$ 0,0013 por llamada y unos US$ 0,003 por caso; con Haiku 4.5 eran US$ 0,015 y 0,03 a 0,04);
(4) volver `llm_modelo_pruebas` al valor que tenía y verificarlo con un `SELECT`; (5) informar el gasto real (después − antes) y que el modelo quedó restaurado. Cubre **ese** `UPDATE`
y su restitución, ninguna otra escritura en la base. **No cubre Sonnet:** su tope es el de US$ 1 en total dicho el 05/10 (*"Podes usar si queres Sonnet siempre y cuando sea medido el gasto,
tope un dolar en total"*), **gastado y pasado**: US$ 0,88 antes y US$ 1,10 al 07/10 (US$ 0,218913 de m1 y m8 con Sonnet 4.6, con el «sí» de Pablo a ese estimativo, que pasaba el tope). Sonnet de nuevo sólo con estimativo y «sí» (regla de arriba). Pablo no fijó un tope para Haiku: si una tanda va a pasar de unos US$ 0,50, se avisa antes (criterio mío, no de Pablo).


**Excepción — corrida semanal con Haiku de los casos de varios pasos (Pablo Olejavetzky, 14/10/2026: *"Cambialo a Haiku, medición semanal"*,
sobre un estimativo de unos US$ 0,03 por corrida):** el cron `lk_eval-semanal-haiku` (lunes 10:15 de Argentina, `sql/153`) corre los 8 casos
`origen = 'multipaso'` con `claude-haiku-5-5` **sin pedir el "sí" cada semana**. Tope: 8 casos con 2 reintentos, unos US$ 0,09 en el peor caso. No
toca `llm_modelo_pruebas`: el modelo va en `body.modelo_eval` y el Simulador sólo lo acepta desde el cron y si está en `MODELOS_EVAL_PAGOS`
(`_shared/modelos-prueba.ts`). **Cubre sólo esa corrida**: sumar casos, otro modelo u otra frecuencia vuelve a la regla de arriba (estimativo + "sí").
Cubre también el **juez** de esa corrida (`lk_eval-juez`, sql/157, Pablo 15/10: *"Sí, armá el juez automático con Haiku"*): una llamada
a Haiku por caso, unos US$ 0,01 por corrida.
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


## 📚 ÍNDICE — reglas movidas a `docs/` (poda de tokens 2026-10-13)

> Las reglas son las mismas: se movieron a `docs/` para no cargarlas en cada sesión. **Antes de tocar un tema, abrir y leer ENTERO su archivo.** Si una regla de un archivo choca con este `CLAUDE.md`, manda `CLAUDE.md`.

- `docs/REGLAS-GESTOPCLIENTES.md` — artifacts del equipo se actualizan en el mismo cambio; categorizacion/clasificacion interna de preguntas; consultas para Thommy en el artifact; coordinacion multi-sesion; correcciones del artifact Respuestas del bot por causa, cómo llegan al bot; sincronizacion logica/front, pestaña Preguntas frecuentes; tablas nuevas en schema public de PaginaLK; testing
