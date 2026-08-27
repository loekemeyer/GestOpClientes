-- Agrega nuevo tipo de mensaje AUTO: Greeting/Fallback
-- Se envía cuando el cliente no especifica consulta (saludo genérico)
-- Bot ya identificó cliente en Supabase, envía bienvenida + opciones
-- Aplicar en PaginaLK (kwkclwhmoygunqmlegrg)

INSERT INTO wa_faq (
  category, category_label, subcategory, automation_level,
  sample_question, keywords, bot_response,
  requires_db_lookup, db_lookup_type, priority, is_active
) VALUES (
  'greeting_fallback',
  'Saludo / bienvenida (fallback)',
  null,
  'full_auto',
  'Hola / Hola qué tal / Necesito ayuda',
  ARRAY['hola', 'hi', 'ayuda', 'puedo', 'necesito', 'consulta', '?'],
  E'Hola! Te contactaste con Loekemeyer 👋\n¿En qué te puedo ayudar hoy?\n\n📦 Realizar un pedido\n📋 Consultar estado de pedido\n\nDecime qué necesitás y te asisto. 😊',
  false,
  null,
  10,
  true
);
