# Registro de decisiones — BotWA-LK

## D001 — Repo separado (2026-08-25)

**Decisión**: Crear repo independiente `BotWA-LK` en vez de meter el bot dentro de PaginaLK o Virgilio.

**Razón**: El bot es un conector entre PaginaLK (pedidos, productos, clientes), Virgilio (tracking, stock) y Planify (patrón webhook). No pertenece a ninguno. Repo propio permite deploy independiente y claridad de ownership.

**Consecuencia**: Edge Functions se deployean desde este repo al proyecto Supabase de PaginaLK. Las SQL migrations se aplican al mismo proyecto.

---

## D002 — Reusar proyecto Supabase PaginaLK (2026-08-25)

**Decisión**: Las tablas y edge functions del bot viven en el proyecto Supabase de PaginaLK (`kwkclwhmoygunqmlegrg`), no en un proyecto nuevo.

**Razón**: El bot necesita acceso directo a `orders`, `order_items`, `products`, `customers` — todas en PaginaLK. Un proyecto separado requeriría cross-project queries o replicación. Innecesario.

**Consecuencia**: Compartir RLS policies. Prefijo `wa_` en tablas nuevas para distinguir.

---

## D003 — Patrón Planify para webhook (2026-08-25)

**Decisión**: Copiar y adaptar el webhook de Planify (`planify_whatsapp-webhook/index.ts`) como base.

**Razón**: Ya resuelve Meta Cloud API v21.0, verificación, media, Claude API directo. Probado en producción. Adaptar > reinventar.

---

## D004 — Claude API directo (sin SDK) (2026-08-25)

**Decisión**: Usar HTTP directo a `api.anthropic.com/v1/messages`, sin SDK.

**Razón**: Planify ya lo hace así. Deno en Edge Functions no siempre se lleva bien con el SDK npm. HTTP directo = 0 dependencias, control total.

---

## D005 — Número WhatsApp (2026-08-26)

**Decisión**: Usar un número WhatsApp preexistente, separado del de Planify.

**Razón**: Aislamiento total entre bot de clientes y bot interno (Planify). Sin necesidad de router/proxy. Cada bot tiene su webhook independiente.

**Consecuencia**: Configurar webhook de Meta apuntando a `lk_whatsapp-webhook`. Secrets necesarios: `WA_TOKEN`, `WA_VERIFY_TOKEN`, `WA_PHONE_NUMBER_ID`.

---

## D006 — Envíos automáticos: sólo a números de prueba, y con llave general (2026-09-25)

**Registro (Luis, 25/09):** los mensajes automáticos que salieron entre el 27/08 y el 04/09
(26 de `notify-tracking-status` y 13 de `wa_outbox`) fueron **a números de testeo**. No se contactó
a ningún cliente. No es un incidente.

**Decisión (Luis):** todavía no se contacta clientes. El bot **no debe tener acceso a ningún
teléfono más que los cargados de prueba**, y sin número cargado no puede mandar. Además tiene que
haber una **llave general de "no mandar nada"** como segunda barrera.

**Medido el 25/09:** los que despachan solos (`lk_outbox-flush`, `notify-tracking-status`) no miran
la whitelist; la barrera real hoy es que `bot_customer_whatsapps` está vacía. Pero
`wa_clientes_telefono` tiene **963 teléfonos reales**, que leen `bot_encolar_recordatorios_25`
(frenado sólo por `v_test_phone` hardcodeado) y `bot_reactivar_inactivos` (frenado por
`bot_reactivacion_config.enabled = false`). `customers.whatsapp` tiene 8.

**Consecuencia:** llave `app_settings.wa_envio_automatico` (`0` nada · `prueba` sólo
`wa_envio_contactos` · `1` producción), fail-closed, en el paso que despacha. `sql/068`.
**No se cargan teléfonos de clientes** en tablas del bot hasta que Luis lo decida.

**Aplicado el 25/09 (con el sí de Luis):** `sql/068` (llave en `0`, probado en transacción
abortada: con `0` no despacha, con `prueba` sólo Thomy y el resto queda `held_no_whitelist`);
`notify-tracking-status` respeta la misma llave (fuente versionada acá desde ahora); cron
`bot-recordatorio-25` **apagado** hasta que alguien defina para qué es (la plantilla
`pedido_recordatorio_25` además no existe en Meta). Whitelist de prueba = **sólo Thomy**.
Rollback del cron: `select cron.alter_job(jobid, active := true) from cron.job where jobname='bot-recordatorio-25';`

