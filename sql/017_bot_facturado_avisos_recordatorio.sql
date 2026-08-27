-- Campos para el recordatorio a 10 días del 25% (contado) sobre bot_facturado_avisos.
-- fecha_salida = base del conteo (día que sale el pedido). recordatorio_25_at = dedup del recordatorio.
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg).

ALTER TABLE public.bot_facturado_avisos ADD COLUMN IF NOT EXISTS fecha_salida date;
ALTER TABLE public.bot_facturado_avisos ADD COLUMN IF NOT EXISTS recordatorio_25_at timestamptz;
