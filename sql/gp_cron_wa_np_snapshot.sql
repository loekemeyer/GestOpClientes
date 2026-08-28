-- gp_cron_wa_np_snapshot.sql
-- APLICAR EN EL PROYECTO GP / Virgilio (hrxfctzncixxqmpfhskv), NO en PaginaLK.
--
-- Cron de captura del snapshot de dirección de entrega por NP.
-- Requiere: pg_cron + la función public.wa_np_snapshot_run() (ver gp_wa_np_snapshot.sql).
--
-- Corre CADA HORA (no una vez al día) a propósito: PPP_Programacion_Diaria rota a diario
-- y las NPs se cargan a lo largo del día. La función es idempotente y preserva first_seen,
-- así que releer cada hora solo agrega las NPs nuevas sin pisar la dirección ya congelada.
-- Es solo captura de datos: NO envía nada.

create extension if not exists pg_cron;

select cron.unschedule('wa_np_snapshot')
where exists (select 1 from cron.job where jobname = 'wa_np_snapshot');

select cron.schedule('wa_np_snapshot', '0 * * * *', 'select public.wa_np_snapshot_run();');

-- Verificar:      select * from cron.job where jobname='wa_np_snapshot';
-- Ver corridas:   select * from cron.job_run_details where jobid=(select jobid from cron.job where jobname='wa_np_snapshot') order by start_time desc limit 10;
-- Apagar:         select cron.unschedule('wa_np_snapshot');
