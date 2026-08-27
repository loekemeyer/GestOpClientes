-- Recategorización de FAQs según framework de automatización
-- AUTO / SEMIAUTO / INTELIGENCIA / HUMANO
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

-- ========== CAMBIO 1: "Hacer/modificar pedido (nuevo_pedido)" ==========
-- de semi_auto → inteligencia
-- Razón: Requiere Haiku intent detection + parseado de SKUs, no es un lookup simple
UPDATE wa_faq
SET automation_level = 'inteligencia',
    notes = 'Requiere Claude Haiku para parsear productos, cantidades y matching contra products table. No es un lookup simple.'
WHERE category = 'hacer_modificar_pedido'
  AND subcategory = 'nuevo_pedido'
  AND automation_level = 'semi_auto';

-- ========== CAMBIO 2: "Alta cliente" ==========
-- de semi_auto → needs_human
-- Razón: Los datos se recolectan paso a paso (bot), pero la aprobación es manual (vendedor/gerencia)
-- La toma de datos es automatizada (paso a paso en handleAltaStep), pero requiere humano para aprobar.
UPDATE wa_faq
SET automation_level = 'needs_human',
    notes = 'Bot recolecta datos paso a paso (handleAltaStep), pero vendedor/gerencia aprueba antes de crear cliente en sistema.'
WHERE category = 'web_registro_contrasena'
  AND subcategory = 'alta_cliente'
  AND automation_level = 'semi_auto';

-- ========== COMENTARIO: Niveles de automatización ==========
-- AUTO (full_auto): Respuesta estática sin cambios
-- SEMIAUTO (semi_auto): Plantilla + lookup Supabase (0 tokens)
-- INTELIGENCIA (inteligencia): Requiere Claude (parsing, clasificación, matching)
-- HUMANO (needs_human): Requiere intervención humana (aprobación, revisión)
