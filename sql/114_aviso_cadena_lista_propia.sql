-- 114 — Aviso de cadena con lista propia al vincular o agendar un teléfono (Pablo, 01/10).
-- Las cadenas de precios_super.cadena con lista propia (activo y not usa_lista_general) tienen su precio en
-- precios_super.precio, pero el bot cotiza a todos con lista general × (1 − dto_vol). El dashboard (Tareas ›
-- Verificar teléfono, Configuración › Vinculaciones y Agendar en la ficha) avisa antes de vincular una.
-- Sólo LK: el código de Chef es otro cliente en LK (el 2444 es Relca en LK y Cencosud en Chef).
-- Sólo lectura. Lo llaman lk_vinculaciones y lk_conversaciones con service_role. Aplicada 01/10 a PaginaLK.

create or replace function public.bot_cadenas_lista_propia(p_cods int[])
returns table (cod_cliente int, cadena text, n_precios int, lista_fecha date)
language sql stable security definer set search_path to 'public' as $$
  select c.cod_cliente_lk::int, c.label,
         (select count(*)::int from precios_super.precio p where p.super_key = c.super_key),
         (select l.lista_fecha from precios_super.lista l where l.super_key = c.super_key)
    from precios_super.cadena c
   where c.activo and not c.usa_lista_general
     and c.cod_cliente_lk = any (p_cods::text[]);
$$;

revoke all on function public.bot_cadenas_lista_propia(int[]) from public, anon, authenticated;
