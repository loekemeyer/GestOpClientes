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

Disparador natural: el evento "última NP del grupo pasa a facturada". Hoy la lógica de
consolidación existe on-demand en `lk_factura-consolidar` (genera el plan del mensaje SIN
enviar). Falta: (a) el gatillo automático sobre grupo `listo`, (b) el sender real a Meta.

## Punteros de código
- `sql/gp_vista_np_factura.sql`, `sql/gp_wa_np_snapshot.sql`, `sql/gp_cron_wa_np_snapshot.sql`
- `sql/gp_wa_factura_grupo.sql` (RPC lectura de facturas por cliente/día)
- `supabase/functions/lk_factura-consolidar/index.ts` (combina PDFs + arma plan de mensaje, sin enviar)
- `supabase/functions/factura_combine/index.ts` (merge de PDFs)
- `supabase/functions/gp_file_b64/index.ts` (baja un objeto de storage en base64)
