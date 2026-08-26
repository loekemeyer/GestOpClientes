-- Tabla para leads / prospectos nuevos que se contactan por WhatsApp
-- y no están dados de alta como clientes en el sistema.
-- Aplicar en proyecto PaginaLK (kwkclwhmoygunqmlegrg)

CREATE TABLE IF NOT EXISTS wa_prospect_leads (
  id                  bigint generated always as identity primary key,
  phone               text not null,
  razon_social        text,
  nombre_contacto     text,
  telefono            text,
  cuit                text,
  mail                text,
  direccion           text,
  localidad           text,
  expreso_nombre      text,
  expreso_direccion   text,
  expreso_telefono    text,
  tipo_comercio       text,
  dimension_comercio  text,
  tiene_venta_web     text,
  ya_vende_lk         boolean,
  a_quien_compra      text,
  como_conoce_marca   text,
  status              text not null default 'pending',   -- pending / contacted / approved / rejected
  raw_messages        jsonb not null default '[]',       -- mensajes crudos del cliente para contexto
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_wa_prospect_leads_phone ON wa_prospect_leads(phone);
CREATE INDEX IF NOT EXISTS idx_wa_prospect_leads_cuit ON wa_prospect_leads(cuit);
CREATE INDEX IF NOT EXISTS idx_wa_prospect_leads_status ON wa_prospect_leads(status);

COMMENT ON TABLE wa_prospect_leads IS 'Leads de clientes nuevos que se contactan por WhatsApp y no están en el sistema';
