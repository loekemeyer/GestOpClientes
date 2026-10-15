-- Rollback de sql/158: vuelve v_wa_resultado_charla a sql/141 y v_wa_charlas_para_revisar a sql/152.
-- create or replace view no puede sacar la columna motivos_derivacion: hay que tirar las vistas que dependen y recrearlas.
-- Son vistas (no borran datos), pero es un DROP: pedir el "sí" antes (regla de BD del CLAUDE.md).
drop view if exists public.v_wa_charlas_para_revisar;
drop view if exists public.v_wa_resultado_semana;
drop view if exists public.v_wa_resultado_charla;
drop function if exists public.wa_alerta_es_derivacion(text, jsonb);
-- Después correr, en este orden: sql/141_v_wa_resultado_charla.sql, sql/146_v_wa_resultado_semana.sql, sql/152_v_wa_charlas_para_revisar.sql
