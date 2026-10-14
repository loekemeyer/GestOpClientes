-- 150 · importador del WhatsApp humano (gap 2026-06-09 → día del lanzamiento) — Pablo Olejavetzky, 14/10/2026
--
-- ⚠ ESTE ARCHIVO NO SE APLICA TODAVÍA. Se corre el DÍA DEL LANZAMIENTO, cuando Pablo tenga el export del WhatsApp
-- Business humano (cliente↔vendedor por fuera del bot) y se sepa el formato. Decisión de Pablo (14/10): cargar la
-- memoria recién ese día, porque si se importa antes queda desactualizada entre hoy y el lanzamiento. Lo vivo del
-- bot (bot_historial_chat) la herramienta buscar_en_mi_historial ya lo lee en vivo: lo único que falta cargar es
-- este tramo humano. Modelo verificado el 14/10: los id de las tres tablas son IDENTITY (autogeneran).
--
-- Flujo del día (ver docs/RUNBOOK-IMPORT-HISTORIAL.md):
--   1) Claude, desde Claude in Chrome, exporta/parsea el WhatsApp humano a filas (cod_cli, marca, rol, contenido, creado_en).
--   2) Esas filas se cargan en wa_import_historial_staging (abajo).
--   3) select * from public.wa_importar_historial_staging('humano_gap');  → crea conversación por cliente, inserta con dedup.
--   4) Verificación (abajo) + opcional: rearmar fichas (gasta Haiku, con estimativo y "sí").
--
-- Dedup: NO inserta un mensaje si ese cliente ya tiene en Wpp_Historial_Clientes uno con la MISMA fecha y el MISMO texto.
-- Así es idempotente (se puede correr dos veces) y no pisa el corpus viejo si hubiera solape.

-- ── Staging (service_role only: RLS activa, sin políticas) ──
create table if not exists public.wa_import_historial_staging (
  id        bigint generated always as identity primary key,
  cod_cli   integer not null,
  marca     text    not null check (upper(marca) in ('LK','CH')),
  telefono  text,
  rol       text    not null check (rol in ('user','assistant')),  -- cliente = user, empresa/vendedor = assistant
  contenido text    not null,
  creado_en timestamp without time zone not null,
  lote      text    not null default 'humano_gap'
);
alter table public.wa_import_historial_staging enable row level security;  -- deny-all para anon (regla de staging/respaldos)

-- ── Importador con dedup ──
create or replace function public.wa_importar_historial_staging(p_lote text default 'humano_gap')
returns table(cod_cli integer, marca text, insertados integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r      record;
  v_conv bigint;
  v_ins  integer;
begin
  for r in
    select distinct s.cod_cli, upper(s.marca) as marca
    from public.wa_import_historial_staging s
    where s.lote = p_lote
  loop
    -- ¿este cliente tiene al menos un mensaje nuevo (no duplicado)?
    if exists (
      select 1
      from public.wa_import_historial_staging s
      where s.lote = p_lote and s.cod_cli = r.cod_cli and upper(s.marca) = r.marca
        and not exists (
          select 1
          from public."Wpp_Historial_Clientes" h
          join public."Wpp_Conversaciones_Clientes" cc on cc.conversacion_id = h.conversacion_id
          where cc.cod_cli = r.cod_cli and upper(coalesce(cc.marca,'LK')) = r.marca
            and h.creado_en = s.creado_en and h.contenido = s.contenido
        )
    ) then
      -- una conversación nueva por cliente para este lote
      insert into public."Wpp_Conversaciones" (etiqueta, created_at)
      values (format('Import humano %s · %s %s', p_lote, r.cod_cli, r.marca), now())
      returning id into v_conv;

      insert into public."Wpp_Conversaciones_Clientes" (conversacion_id, cod_cli, marca)
      values (v_conv, r.cod_cli, r.marca);

      insert into public."Wpp_Historial_Clientes" (conversacion_id, rol, fuente, contenido, creado_en)
      select v_conv, s.rol, 'whatsapp_humano', s.contenido, s.creado_en
      from public.wa_import_historial_staging s
      where s.lote = p_lote and s.cod_cli = r.cod_cli and upper(s.marca) = r.marca
        and not exists (
          select 1
          from public."Wpp_Historial_Clientes" h
          join public."Wpp_Conversaciones_Clientes" cc on cc.conversacion_id = h.conversacion_id
          where cc.cod_cli = r.cod_cli and upper(coalesce(cc.marca,'LK')) = r.marca
            and h.creado_en = s.creado_en and h.contenido = s.contenido
        );
      get diagnostics v_ins = row_count;

      cod_cli := r.cod_cli; marca := r.marca; insertados := v_ins;
      return next;
    end if;
  end loop;
end
$function$;

revoke all on function public.wa_importar_historial_staging(text) from anon, authenticated;

-- ── Verificación (correr después del import) ──
-- select cc.marca, min(h.creado_en)::date, max(h.creado_en)::date, count(*)
--   from public."Wpp_Historial_Clientes" h
--   join public."Wpp_Conversaciones_Clientes" cc on cc.conversacion_id = h.conversacion_id
--  where h.fuente = 'whatsapp_humano' group by 1;
-- Probar la herramienta con un cliente del tramo nuevo: select * from public.bot_buscar_mi_historial('<telefono>', '<palabra>', 6);
-- Cuando esté OK, vaciar el staging: truncate public.wa_import_historial_staging;  (pide el "sí": es un borrado)
