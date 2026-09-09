-- ============================================================
-- 064_wa_blacklist_avisado_at.sql
-- Blacklist: avisar UNA vez y después silencio (pedido del dueño, 2026-09-09).
-- ============================================================
-- El webhook (lk_whatsapp-webhook, paso 0b) responde "Estamos momentáneamente fuera de
-- servicio" al PRIMER mensaje que manda un número una vez está en la blacklist, y después
-- lo descarta en silencio. avisado_at marca ese "ya avisé" (null = todavía no).
-- Si el número se saca y se vuelve a agregar (fila nueva), avisado_at vuelve a null → avisa de nuevo.
alter table public.wa_blacklist add column if not exists avisado_at timestamptz;
