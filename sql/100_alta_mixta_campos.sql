-- 100: alta de cliente mixta (Pablo, 29/09). La solicitud por WhatsApp pide los 10 datos acordados:
-- razón social, CUIT (con dígito verificador), condición de IVA, contacto, mail, teléfono, dirección de entrega
-- completa (calle y número, localidad, provincia, código postal), expreso si es del interior, tipo de comercio
-- (opcional). El vendedor, el código y el descuento los completa quien aprueba (lk_alertas alta_crear).
alter table public.wa_prospect_leads add column if not exists condicion_iva text;
alter table public.wa_prospect_leads add column if not exists provincia text;
alter table public.wa_prospect_leads add column if not exists codigo_postal text;
alter table public.wa_prospect_leads add column if not exists customer_id uuid;
