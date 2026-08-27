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

## 🔒 MODO PRUEBA (activo)

`lk_notif-facturado` tiene `TEST_REDIRECT_PHONE = "5491162521635"`: **TODO** aviso se
redirige SOLO a ese número (el teléfono de prueba), **nunca** a un WhatsApp de cliente
o de la empresa. Para salir a producción (mandar al cliente real), poner la constante
en `""`. La respuesta de la función incluye `test_mode: true` mientras está activo.
⚠ Aun así, no sale nada hasta que el template esté aprobado y estén los secrets del flush.

## Variante e-check (en el mismo aviso "mañana sale")

Si el pedido se pagó con **e-check (90 o 120 días)**, el aviso agrega una nota: recordar
que el e-check se hace **ahora** (anticipado / contra entrega), no a los 75 días.

- El método de pago se resuelve con `bot_pago_por_cliente_fecha(cod_cliente, fecha)` — cruce
  por `customer_code` + fecha contra `orders` de LK (el NP de Virgilio no comparte numeración).
- `lk_notif-facturado` elige el template: normal (`pedido_facturado_sale`) o e-check
  (`pedido_facturado_echeq`, con un 4º param = días 90/120).

## Recordatorio a 10 días — 25% (pago contado)

A los **10 días** de que sale el pedido (`fecha_salida`), se avisa que se está por vencer el
plazo del **25% contado** (vence a los 14 días). Para **todos** los clientes con aviso de
facturado. Función `bot_encolar_recordatorios_25()` (SQL) corrida por **pg_cron diario**
(`bot-recordatorio-25`, 09:00 ART); dedup por `recordatorio_25_at`. Encola template
`pedido_recordatorio_25`.

## Templates de Meta a crear (3) — es_AR, categoría Utility

| Template | Params (body, en orden) | Uso |
|----------|--------------------------|-----|
| `pedido_facturado_sale`  | {{1}} fecha DD/MM/AAAA · {{2}} N° pedido · {{3}} monto | aviso normal |
| `pedido_facturado_echeq` | {{1}} fecha · {{2}} N° pedido · {{3}} monto · {{4}} días (90/120) | aviso e-check |
| `pedido_recordatorio_25` | {{1}} N° pedido · {{2}} fecha límite DD/MM/AAAA | recordatorio 25% |

Textos sugeridos (ajustables en Meta):
- **sale:** `¡Hola! Mañana {{1}} sale tu pedido N° {{2}} por un total de {{3}} (IVA incluido). ¡Gracias! — Loekemeyer`
- **echeq:** `¡Hola! Mañana {{1}} sale tu pedido N° {{2}} por {{3}} (IVA incl.). Elegiste pago a {{4}} días con e-check: recordá que el e-check se hace ahora (anticipado/contra entrega), no a los 75 días. — Loekemeyer`
- **recordatorio_25:** `¡Hola! Te recordamos que tu pedido N° {{1}} sigue a tiempo para el 25% de descuento pagando de contado. El plazo vence el {{2}}. — Loekemeyer`

## Nota de arquitectura

Coexisten dos webhooks en LK: `whatsapp-webhook` (v148, el maduro/vivo) y
`lk_whatsapp-webhook` (v2, la reescritura de este repo, que corre el flush del `wa_outbox`).
El aviso de facturado usa el `wa_outbox` que lee `lk_whatsapp-webhook`. Si el envío se
consolida en el webhook maduro, apuntar el enqueue a la cola que ese use.
