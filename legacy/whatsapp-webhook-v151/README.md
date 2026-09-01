# Legacy: Edge Function `whatsapp-webhook` v151

**Estado**: STUBEADA a partir del deploy que sigue a este commit.
**Proyecto Supabase**: PaginaLK (`kwkclwhmoygunqmlegrg`).
**Fuente original**: `index.ts` en este directorio (169 122 chars, 3846 líneas).
**Última versión funcional**: v151 (deployeada el 2025‑10‑something; ver historial de Supabase).

---

## Qué era

Bot de WhatsApp original de la web pública de Loekemeyer (PaginaLK). Manejaba:

- **Verificación GET** del webhook de Meta.
- **POST del webhook de Meta** (mensajes entrantes, botones interactivos, statuses).
- **POST con `x-internal-resume`** — un endpoint interno que la Edge Function `inbox-register` invoca al aprobar/rechazar una solicitud pendiente, para "reinyectar" un mensaje como si el cliente lo hubiese escrito y así el bot retome la conversación.

**Whitelist gate**: el primer check dentro de `handleMessage` era una lista blanca (`BOT_TEST_WHITELIST`) — si el número entrante no estaba, respondía:

> *Bot en desarrollo. Disculpe las molestias, no podemos atenderlo por este canal en este momento. Para consultas comuníquese con el Departamento de Ventas: ventas@loekemeyer.com o WhatsApp 11 3118 1021.*

---

> **Nota**: el repo hermano `loekemeyer/PaginaLK` está **archivado** (read‑only) en GitHub, así que toda la doc sobre este stub vive únicamente acá. Si algún día se des‑archiva PaginaLK, considerar duplicar esta nota como puntero.

## Por qué se stubeó (2026‑09‑01)

Se levantó el nuevo bot en el mismo número de WhatsApp — **Edge Function `lk_whatsapp-webhook`** de este repo, con app de Meta `Gestion Operativa Clientes`. Meta empezó a mandar el mismo evento a **ambas apps** suscriptas a la misma WABA:

- App vieja de PaginaLK → `whatsapp-webhook` v151 → respondía "Bot en desarrollo…"
- App nueva `Gestion Operativa Clientes` → `lk_whatsapp-webhook` → respondía flujo normal

Todos los clientes veían **dos respuestas por mensaje**. Se decidió stubear la vieja para dejar corriendo solo la nueva.

---

## Qué hace el stub

Ver `stub.ts` (deployeado como v152).

- **GET** — sigue respondiendo la verificación de Meta con el `hub.challenge`. Mantiene la suscripción viva por si algún día se quiere reactivar.
- **POST (Meta webhook)** — responde `200 OK` inmediatamente y descarta el payload. Meta no reintenta.
- **POST (`x-internal-resume`)** — responde `503` con `{ error: "webhook legacy stubeado, ver legacy/whatsapp-webhook-v151/README.md" }` para que `inbox-register` deje una traza clara si intenta reinyectar.

---

## Análisis de plantillas (para no romper nada)

Antes de stubear se analizó el uso de plantillas de Meta. Este webhook usa **tres** plantillas del pool compartido:

| Plantilla | Cuándo se envía |
|-----------|-----------------|
| `confirmar_asociacion_v1` | Cuando un teléfono nuevo manda su CUIT → pide aprobación al primary de la cuenta |
| `asociacion_aprobada_v1` | Cuando el primary aprueba y el requester está fuera de la ventana 24h de Meta |
| `asociacion_rechazada_v1` | Ídem para rechazo |

Todas son **reactivas** — se disparan a partir de un evento inbound del mismo webhook. Al stubear, nadie va a enviarlas más desde este código.

Una cuarta plantilla, `confirmacion_pedido_v1`, aparece en comentarios pero **no la envía este webhook** — la envía la Edge Function hermana `notify-order-created` (que sigue viva y no fue tocada). El webhook viejo solo reaccionaba a los taps de sus botones (`descargar_pedido_<id>` / `rechazar_pedido_<id>`).

**Riesgo residual identificado**: los botones de `confirmacion_pedido_v1` que envíe `notify-order-created` en un pedido nuevo van a llegar sin nadie que los procese hasta que se implemente ese handler en `lk_whatsapp-webhook` o se reactive este bot.

---

## Cómo restaurar

Si en algún momento se quiere volver a tener este bot corriendo:

1. **Redeploy del código original**: usar `mcp__Supabase__deploy_edge_function` con `project_id="kwkclwhmoygunqmlegrg"`, `name="whatsapp-webhook"`, `verify_jwt=false`, y el contenido de `legacy/whatsapp-webhook-v151/index.ts` de este directorio como archivo `index.ts`.

2. **Verificar secrets** que la función espera (todas via `Deno.env.get`):
   - `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`
   - `BOT_OPEN_TO_ALL` (bool, default false), `BOT_TEST_WHITELIST` (CSV de teléfonos canónicos)
   - Los mismos que ya estaban seteados cuando se stubeó — verificar en el proyecto Supabase.

3. **Suscripción Meta**: la URL del webhook (`.../functions/v1/whatsapp-webhook`) sigue existiendo. Si Meta no la tiene suscripta, resubscribir la app vieja de PaginaLK en Meta Business Manager → App → WhatsApp → Configuración.

4. **Cuidado con el doble envío**: si se reactiva junto con `lk_whatsapp-webhook`, los clientes van a recibir **dos respuestas por mensaje**. Antes de reactivar hay que decidir cuál desactivar.

---

## Historia del deploy

- **v151** — última funcional (bot activo con whitelist).
- **v152** — stub (este commit).
