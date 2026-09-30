-- 109 — (APLICADA 30/09 a PaginaLK) Se apaga el aviso de despacho de las NP de ISIS (Pablo, 30/09, auditoría de plantillas).
-- Desde el 21/09 no se factura ninguna NP de ISIS (Facturacion_NP de Gestión: 0 en 7 días; la última salió el 24/09), y
-- trg_notify_despacho nunca encoló nada (0 filas context 'despacho'). Quedaban 13 NP de ISIS programadas sin facturar
-- (recibidas del 23/06 al 04/09): si alguna se facturaba, el cliente recibía "sale hoy en el reparto" el día de la
-- factura, que puede ser días antes de la salida. Los pedidos web no se tocan (cron lk_aviso-en-viaje-web y
-- lk_aviso-retiro-web). La función queda (sin disparador).
-- Rollback:
--   create trigger ppp_facturacion_wa_notify after insert on public.ppp_facturacion
--     for each row execute function public.trg_notify_despacho();
drop trigger if exists ppp_facturacion_wa_notify on public.ppp_facturacion;
