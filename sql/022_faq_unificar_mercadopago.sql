-- Unifica FAQ #38 (¿Aceptan Mercado Pago?) con FAQ #15 (Medios de pago)
-- Desactiva FAQ #38 como duplicada, mantiene respuesta completa en FAQ #15
-- Aplicar en PaginaLK (kwkclwhmoygunqmlegrg)

UPDATE wa_faq
SET is_active = false
WHERE id = 38;
