-- 063_gestop_users_hash.sql
-- Endurece gestop_users (PaginaLK, whitelist de rol del dashboard). Proyecto kwkclwhmoygunqmlegrg
-- 2026-09-09 · aplicado. Cierra el punto 6 de la auditoría.
--
-- Contexto: la tabla se migró a login por Google OAuth (sql/011); hoy se usa SOLO como whitelist
-- de rol (el front lee `role` filtrando por `email` con la anon key; admin-gate.ts y lk_faq-admin
-- la leen con service_role). NADIE lee `password_hash` en el código (verificado: 0 referencias).
--
-- Riesgos que esto cierra:
--   (a) password_hash legible por anon. La policy anon_read (SELECT, USING true) + el GRANT de
--       columnas dejaban a cualquiera con la anon key (pública, va en docs/index.html) leer
--       `password_hash`: SHA-256 SIN salt, y el de `vendedor` es el hash conocido de "1234".
--       Además `username`, legacy del login viejo, quedaba igual de expuesto.
--   (b) anon/authenticated tenían GRANT de INSERT/UPDATE/DELETE/TRUNCATE. Hoy RLS los tapa (no hay
--       policy de escritura), pero es un footgun: apagar RLS o agregar una policy permisiva dejaría
--       a cualquiera con la anon key reescribir roles (self-admin) o vaciar la whitelist.
--
-- Fix: sacar las escrituras de los roles públicos, acotar el SELECT de anon a (email, role) —lo
-- único que el front necesita— y dropear password_hash, que es peso muerto y débil.
--
-- Impacto funcional: NINGUNO. El front sigue leyendo (email, role) como anon; las edge functions
-- usan service_role (bypass). No hay lector de password_hash.
--
-- Idempotente.

-- (b) Sacar escrituras de los roles públicos.
revoke insert, update, delete, truncate, references, trigger
  on public.gestop_users from anon, authenticated;

-- (a) Acotar la lectura de anon a las dos columnas que usa la whitelist del front.
--     Se revoca todo el SELECT y se re-otorga solo (email, role). authenticated no lo usa
--     (el front lee como anon), así que queda sin acceso.
revoke select on public.gestop_users from anon, authenticated;
grant  select (email, role) on public.gestop_users to anon;

-- Dropear el hash muerto y débil. La policy anon_read (SELECT, USING true) se mantiene: da
-- visibilidad de fila; las columnas las gobierna el GRANT de arriba.
alter table public.gestop_users drop column if exists password_hash;
