-- 061_app_settings_hardening.sql
-- Endurece app_settings (PaginaLK). Proyecto kwkclwhmoygunqmlegrg · 2026-09-08 · aplicado
--
-- Contexto: la fuga "en curso" del punto 1 de la auditoría YA estaba cerrada — la policy
-- app_settings_select_all excluía isis_supabase_service_key y LK_WA_TOKEN, y RLS está prendida.
-- Quedaban dos riesgos residuales que esto cierra:
--
--   (a) anon/authenticated tenían GRANT de INSERT/UPDATE/DELETE/TRUNCATE sobre app_settings.
--       Hoy RLS los tapa (no hay policy de escritura), pero es un footgun: si alguien apaga RLS
--       o agrega una policy permisiva, cualquiera con la anon key (pública, va en docs/index.html)
--       podría TRUNCATE la tabla de config del bot. El front NO escribe app_settings directo
--       (lo hace vía edge functions con service_role), así que revocar no rompe nada.
--   (b) El blacklist de la policy era de 2 keys fijas. Un secret nuevo agregado mañana quedaría
--       legible por anon hasta que alguien se acuerde de sumarlo. Se pasa a un deny por PATRÓN de
--       nombres tipo credencial → cubre los 2 actuales y cualquier futuro.
--
-- NO cubre (owner-only, sigue pendiente): ROTAR los 2 secrets. Estuvieron legibles por anon en
-- algún momento antes del parche de la policy → hay que regenerarlos igual (token de Meta y
-- service_key de ISIS) y, idealmente, moverlos a secrets de Edge Function.
--
-- Idempotente.

-- (a) Sacar escrituras de los roles públicos. SELECT se mantiene (la policy lo necesita).
revoke insert, update, delete, truncate, references, trigger
  on public.app_settings from anon, authenticated;

-- (b) Deny por patrón de credenciales (reemplaza el blacklist de 2 keys).
drop policy if exists app_settings_select_all on public.app_settings;
create policy app_settings_select_all on public.app_settings
  for select to anon, authenticated
  using ( key !~* '(token|secret|service_key|service_role|api_key|apikey|password|passwd|clave)' );
