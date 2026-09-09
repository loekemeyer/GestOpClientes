-- 065_gestop_users_login_fix.sql
-- Corrige un efecto no deseado de sql/063. Proyecto kwkclwhmoygunqmlegrg · 2026-09-09 · aplicado.
--
-- sql/063 endureció gestop_users (dropear password_hash + cerrar grants), PERO revocó el SELECT de
-- `authenticated` asumiendo que el front lee la whitelist de rol como `anon`. En realidad el front
-- lee la tabla CON la sesión de Google (rol `authenticated`), así que eso rompió el LOGIN del
-- dashboard: sin grant ni policy para authenticated, la lectura de `role` devolvía 0 filas y todo
-- email quedaba "no autorizado". Se restauró en vivo; esta migración lo deja versionado para que un
-- re-apply limpio del repo no vuelva a romper el login.
--
-- Lo de sql/063 que SÍ se mantiene (y es el objetivo real de seguridad): password_hash sigue
-- dropeada, y ni anon ni authenticated tienen escrituras ni pueden leer más que (email, role).
--
-- Idempotente.

-- Grant de columnas para authenticated: solo lo que la whitelist necesita.
grant select (email, role) on public.gestop_users to authenticated;

-- Policy de lectura para authenticated (columnas gobernadas por el grant de arriba).
drop policy if exists authenticated_read on public.gestop_users;
create policy authenticated_read on public.gestop_users
  for select to authenticated using (true);
