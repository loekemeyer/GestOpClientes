-- 161_vistas_security_invoker.sql
-- Cierra el advisor security_definer_view (ERROR) de Supabase en 6 de las 7 vistas.
--
-- Problema: estas vistas corren con SECURITY DEFINER (dueño = postgres), por lo que
-- saltean la RLS de sus tablas madre. Como 1264 clientes reales tienen login (rol
-- `authenticated`), cualquier cliente logueado podía leer datos de TODOS los demás:
--   - v_clientes_arca   -> CUIT, estado AFIP, deuda BCRA de todos los clientes
--   - leads_overview    -> PII completa (whatsapp, email, IP, notas) de todos los leads
--   - v_orders_origen   -> metadata/origen de todos los pedidos
--   - expo_dashboard_stats -> conteos agregados por expo
--   - v_wa_faq_summary  -> FAQ del bot (anon)
--   - v_customer_item_month -> ya auto-filtra por auth.uid(), sin cambio de resultado
--
-- Fix: security_invoker = on. La vista pasa a correr como quien consulta, así aplica
-- la RLS de las tablas madre. Los paneles admin NO se rompen: las tablas madre ya
-- tienen policies que cubren admin/staff/service_role (admins, is_staff(), fila propia),
-- y wa_faq tiene policy anon_read para las FAQ activas.
--
-- NO se toca estadistica_madre: su cache (estadistica_madre_cache) tiene RLS con 0
-- policies (deny-all), así que invoker dejaría sin datos a cualquier consumidor que no
-- use service_role. Requiere identificar antes qué app la lee.

alter view public.v_clientes_arca       set (security_invoker = on);
alter view public.leads_overview        set (security_invoker = on);
alter view public.v_orders_origen       set (security_invoker = on);
alter view public.expo_dashboard_stats  set (security_invoker = on);
alter view public.v_wa_faq_summary      set (security_invoker = on);
alter view public.v_customer_item_month set (security_invoker = on);
