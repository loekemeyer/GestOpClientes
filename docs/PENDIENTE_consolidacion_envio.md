# PENDIENTE — Consolidación y envío de facturas (señalizado para más adelante)

Estado: **base lista, dormant. NO implementado el paso final de combinar+enviar.**

## Lo que YA está (forward-facing, solo lectura)

- **`vista_np_factura`** (GP): matchea cada NP facturada con su factura por cajas (llave
  inmune) + neto graduado, ventana ±3 días, empresa por prefijo. Grado de confianza
  exacto/bueno/revisar/ambiguo/sin_factura. ~91% confiable cuando la factura ya se parseó.
- **`vista_grupo_pedido`** (GP): agrupa por **cliente + destino de entrega + día**.
  `estado_grupo` = listo / parcial / pendiente. `listo` = todas las NPs del grupo
  facturadas y matcheadas con confianza → el conjunto está completo.
- **`wa_np_snapshot` + `wa_np_snapshot_run()` + cron horario** (GP): congela la dirección
  de entrega el día que la NP está viva en la PPP (que rota a diario).
- **Acceso a PDFs** (bucket privado, vía edge function `gp_file_b64` por pg_net):
  - Facturas: `isis-lk` / `isis-ch`, columna `storage_path`.
  - **NP (nota de pedido)**: `isis-lk/pedido/Pedido de Clte._Div_0000000<NP>_00.pdf`,
    keyed por número de NP. (Descubierto tarde — cada NP tiene su propio PDF.)

## Lo que FALTA (el "otro" que se implementa después)

Cuando se facture la **última NP** de un grupo `listo`:

1. Juntar los PDFs de todas las facturas del grupo (`doc_ids` → `storage_path`) en uno
   solo. Opcional: sumar también los PDFs de las NP originales (keyed por número).
2. Consolidar el total con IVA (`total_facturas`), aplicar la escala de descuento según
   el método de pago del cliente.
3. Elegir la plantilla WA correspondiente (ver `supabase/functions/lk_factura-consolidar`)
   y **enviar un solo mensaje** al cliente con el PDF combinado.

Disparador natural: el evento "última NP del grupo pasa a facturada".

**(a) Gatillo — YA ARMADO pero DESACTIVADO** (`sql/gp_trigger_grupo_listo.sql`): el trigger
`wa_np_facturado_trg` sobre `Facturacion_NP` detecta cuando se factura la última NP de un
grupo (cliente+destino+día) y lo encola en `wa_grupo_listo`. Encender con
`alter table "Facturacion_NP" enable trigger wa_np_facturado_trg;`. No envía, solo encola.

**(b) Sender real a Meta — FALTA.** Un worker que lea `wa_grupo_listo` (enviado=false),
llame a `lk_factura-consolidar` para armar el PDF combinado + plan de mensaje, y despache
la plantilla vía Meta Cloud API al teléfono del cliente. Este es el único paso que
realmente envía; se conecta recién cuando se decida prender el bot.

Nota: `lk_factura-consolidar` hoy agrupa por cuit+fecha (no por destino). Para el caso raro
de dos pedidos del mismo cliente/día a destinos distintos, el sender deberá pasarle el
subconjunto de NPs/facturas del grupo, o agregar filtro por destino a la función.

## Punteros de código
- `sql/gp_vista_np_factura.sql`, `sql/gp_wa_np_snapshot.sql`, `sql/gp_cron_wa_np_snapshot.sql`
- `sql/gp_wa_factura_grupo.sql` (RPC lectura de facturas por cliente/día)
- `supabase/functions/lk_factura-consolidar/index.ts` (combina PDFs + arma plan de mensaje, sin enviar)
- `supabase/functions/factura_combine/index.ts` (merge de PDFs)
- `supabase/functions/gp_file_b64/index.ts` (baja un objeto de storage en base64)
