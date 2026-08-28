-- gp_trigger_factura_consolidacion.sql
-- APLICAR EN EL PROYECTO GP (hrxfctzncixxqmpfhskv), NO en PaginaLK.
--
-- ⚠️ ARMADO PERO NO INSTALADO A PROPÓSITO.
-- No ejecutar este archivo hasta que:
--   1) Exista el endpoint de completitud en PaginaLK (lk_factura-check, etapa 5), y
--   2) Se ponga en 'true' el flag app_settings.wa_factura_consolidacion_enabled (PaginaLK).
-- Mientras tanto, dispara NADA: las inserciones del parser siguen intactas.
--
-- Cubre las DOS fuentes: isis_lk.documentos (LK) e isis_ch.documentos (Chef).
-- Es a nivel STATEMENT con tabla de transición (debounce): una llamada por tanda,
-- agrupando por CUIT, en vez de una por fila.

-- Función de trigger: por cada CUIT nuevo en la tanda, avisa a PaginaLK.
create or replace function public.wa_factura_notificar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text;
  r record;
begin
  -- schema de la tabla que disparó → source
  v_source := case tg_table_schema
                when 'isis_lk' then 'lk'
                when 'isis_ch' then 'ch'
                else tg_table_schema
              end;

  for r in
    select distinct contraparte_cuit as cuit, fecha
    from new_rows
    where familia = 'factura_venta' and contraparte_cuit is not null
  loop
    -- Avisa a PaginaLK que llegaron facturas nuevas de este cliente/fuente.
    -- PaginaLK evalúa completitud (PPP) y, si corresponde, consolida.
    perform net.http_post(
      url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_factura-check',
      headers := jsonb_build_object('Content-Type','application/json'),
      body := jsonb_build_object('source', v_source, 'cuit', r.cuit, 'fecha', r.fecha)
    );
  end loop;
  return null;
end;
$$;

-- Triggers (statement-level, con tabla de transición). NO instalar todavía:
-- descomentar recién cuando el sistema esté listo para funcionar.
--
-- create trigger trg_factura_notificar_lk
--   after insert on isis_lk.documentos
--   referencing new table as new_rows
--   for each statement execute function public.wa_factura_notificar();
--
-- create trigger trg_factura_notificar_ch
--   after insert on isis_ch.documentos
--   referencing new table as new_rows
--   for each statement execute function public.wa_factura_notificar();
