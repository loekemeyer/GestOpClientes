-- 043_wa_agente_modelos_label_optional.sql
-- label pasa a opcional: los modelos agregados masivamente desde una key usan
-- el model_id como nombre y no necesitan label explícito. Idempotente.

ALTER TABLE public.wa_agente_modelos ALTER COLUMN label DROP NOT NULL;
