-- ============================================================
-- 011_gestop_users_email.sql
-- Migrar gestop_users de user/pass a login por Google OAuth
-- ============================================================

-- Agregar columna email
ALTER TABLE gestop_users ADD COLUMN IF NOT EXISTS email text;

-- Índice único para email
CREATE UNIQUE INDEX IF NOT EXISTS idx_gestop_users_email
  ON gestop_users (email) WHERE email IS NOT NULL;

-- Asignar email al admin actual
UPDATE gestop_users
SET email = 'loekemeyer.n8n@gmail.com'
WHERE username = 'admin';
