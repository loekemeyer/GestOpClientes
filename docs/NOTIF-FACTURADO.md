# Aviso proactivo — "mañana sale tu pedido por $XXX (IVA incl.)"

Módulo **mensajes automáticos**. Cuando la operadora tilda **✓ facturó** en el módulo
de Facturación de Virgilio, el cliente recibe un WhatsApp avisando que al día siguiente
sale su pedido, por el **total con IVA**.

## Flujo

```
Operadora tilda ✓ facturar  →  INSERT en Facturacion_NP (proyecto Virgilio)
   └─ trigger fn_facturado_notif_wa (Virgilio):
        total = neto (vista_facturacion_neto, sobre lo armado) × 1,21
        pg_net POST (header x-sync-secret) →
   └─ Edge Function lk_notif-facturado (proyecto LK):
        cod_cliente → bot_customer_whatsapps.whatsapp   (fallback wa_clientes_telefono)
        dedup por NP (bot_facturado_avisos)
        INSERT en wa_outbox (template)
   └─ cron wa_outbox_flush (cada 2') → lk_whatsapp-webhook?action=flush
        bot_flush_outbox → sendTemplate → Meta → WhatsApp al cliente
```

- **Llave de cruce:** `cod_cliente` (mismo en `Facturacion_NP` de Virgilio y en
  `bot_customer_whatsapps` de LK).
- **Monto:** total con IVA = neto × 1,21. El neto sale de `vista_facturacion_neto`
  (Virgilio, en vivo).
- **Dedup:** un aviso por NP (`bot_facturado_avisos`). Reintento seguro.

## Piezas (ya deployadas / probadas)

| Pieza | Proyecto | Estado |
|-------|----------|--------|
| trigger `fn_facturado_notif_wa` en `Facturacion_NP` | Virgilio (`hrxfctzncixxqmpfhskv`) | ✅ aplicado |
| Edge Fn `lk_notif-facturado` (verify_jwt=off, x-sync-secret) | LK (`kwkclwhmoygunqmlegrg`) | ✅ deployada + probada e2e |
| tabla dedup `bot_facturado_avisos` (`sql/015`) | LK | ✅ aplicada |

## ⚠ Falta para que el mensaje SALGA de verdad

1. **Secrets de WhatsApp en `lk_whatsapp-webhook`** — hoy el flush muere en `loadConfig()`
   (responde `"OK"` en vez de `{sent,failed}`) porque faltan. Setear en la función:
   `LK_WA_PHONE_ID`, `LK_WA_TOKEN`, `LK_WA_VERIFY_TOKEN`, `ANTHROPIC_API_KEY`.
   Hasta que estén, `wa_outbox` queda en `pending` sin intentarse.

2. **Template de Meta aprobado.** Crear en Meta Business Manager:
   - **Nombre:** `pedido_facturado_sale`  (si se cambia, ajustar la const `TEMPLATE`
     en `supabase/functions/lk_notif-facturado/index.ts`)
   - **Idioma:** `es_AR`
   - **Categoría:** Utility (es notificación transaccional, no marketing)
   - **Body (3 variables posicionales):**
     ```
     ¡Hola! Te confirmamos que mañana {{1}} sale tu pedido N° {{2}}
     por un total de {{3}} (IVA incluido). ¡Gracias por tu compra! — Loekemeyer
     ```
   - **Parámetros** (en este orden, los manda `lk_notif-facturado`):
     `{{1}}` = fecha de salida `DD/MM/AAAA` · `{{2}}` = N° de pedido (NP) · `{{3}}` = monto `$XXX`

3. **Cliente con WhatsApp vinculado** en `bot_customer_whatsapps` (o `wa_clientes_telefono`).
   Hoy hay pocos vinculados.

## Nota de arquitectura

Coexisten dos webhooks en LK: `whatsapp-webhook` (v148, el maduro/vivo) y
`lk_whatsapp-webhook` (v2, la reescritura de este repo, que corre el flush del `wa_outbox`).
El aviso de facturado usa el `wa_outbox` que lee `lk_whatsapp-webhook`. Si el envío se
consolida en el webhook maduro, apuntar el enqueue a la cola que ese use.
