-- 033_drop_wa_sim_facturas.sql
-- Reemplaza al simulador aislado 032 (tabla propia en PaginaLK) por el simulador
-- END-TO-END que ejercita el pipeline REAL en ISIS (isis_lk.documentos + bucket isis-lk
-- + trigger wa_sim_documentos_trg). El estado de simulación ahora vive en ISIS
-- (wa_sim_control / wa_sim_avisos), así que la tabla de PaginaLK ya no se usa.
-- Aplicar en PaginaLK (kwkclwhmoygunqmlegrg). Idempotente.

drop table if exists public.wa_sim_facturas;
