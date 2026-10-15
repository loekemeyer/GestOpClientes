-- Fase B (Pablo, 14/10/2026): atributos visuales por producto para buscar por descripción
-- ("quiero el pelapapas que tiene mango rojo"). Los atributos (color, material, forma) se
-- extraen una vez por producto con visión (edge lk_etiquetar-productos, Gemini free) y se
-- guardan acá. El tool buscar_productos del agente filtra por ellos en TS (bot-conversation.ts):
-- primero busca por tipo con bot_buscar_productos (sin tocar) y después deja sólo los productos
-- cuyo atributos_texto contiene TODOS los rasgos visuales que el cliente mencionó.
--
-- Se filtra en TS y no dentro de bot_buscar_productos a propósito: cambiarle la firma exigía
-- dropear la versión de 2 args (lock exclusivo que choca con el tráfico vivo del bot).
--
-- cod = products.cod. Idempotente.

create table if not exists public.wa_producto_atributos (
  cod             text primary key,
  atributos_texto text        not null default '',   -- blob buscable: "pelador verduras mango rojo plastico"
  datos           jsonb       not null default '{}'::jsonb, -- {colores:[...], material, forma, otros:[...]}
  modelo          text,                                -- modelo de visión que lo etiquetó
  actualizado_at  timestamptz not null default now()
);

-- toda copia/tabla nace con RLS (regla del repo): sin políticas = deny-all para anon/authenticated.
-- El bot la lee con service_role, que la saltea.
alter table public.wa_producto_atributos enable row level security;

comment on table public.wa_producto_atributos is
  'Atributos visuales por producto (color, material, forma) extraidos por vision (Fase B). cod = products.cod. El filtro por atributo lo hace el tool buscar_productos en TS.';
