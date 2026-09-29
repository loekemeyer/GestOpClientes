-- (APLICADA 29/09 a PaginaLK)
-- 091 — (APLICADA 29/09 a PaginaLK) Se quita el aviso pedido_preparando (Pablo, 29/09: "no tiene sentido").
-- El cron lk_aviso-retiro-web deja de llamar a wa_avisos_preparando_web(); sigue el aviso de retiro listo.
-- La función y la plantilla en Meta quedan (sin uso): para volver, restaurar el comando del cron.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'lk_aviso-retiro-web'),
  command := 'select public.wa_avisos_retiro_web();');
