-- 162 — (APLICADA 16/10) HARNESS DE PRUEBA: leer la señal CRN de un remito de prueba y mandar el aviso al cliente,
-- SIN tocar Gestión. Pedido de Pablo Olejavetzky (16/10): "si confirmo ese remito no sale una señal? Bueno que esa
-- señal llegue a 4210".
--
-- Contexto: el remito de prueba "PRUEBA 4210-505" está suelto (sin pedido, sin cliente, cargado con legajo de
-- prueba 1). NO puede entrar al feed real gv_remitos_controlados: ese se arma sobre gv_ppp_entregados, que exige
-- que el NP esté en programación/facturación (Facturacion_NP rechaza por trigger de integridad: "no tiene ítems
-- armados en Entregas_Virgilio") y excluye legajos de prueba. Forzarlo = corromper Gestión (NO se hizo).
--
-- Solución limpia: la señal que SÍ existe cuando se tilda el remito es el evento opcion='CRN' en
-- Registros_Produccion_Virgilio. Se lee esa señal desde el bot por FDW y se mapea el remito al cliente del lado de
-- PaginaLK (tabla wa_remito_test_map). Cero escrituras en Gestión. Sólo procesa los NP listados en el mapa, así que
-- NO puede dispararse por remitos reales. Gateado por la vasectomía (wa_envio_automatico): hoy sólo sale a la whitelist.
--
-- Rollback (al terminar las pruebas): cron.unschedule('lk_aviso-remito-test'); drop function wa_avisos_remito_test();
-- drop table wa_remito_test_map; drop foreign table virgilio.registros_produccion;  (y borrar las filas context
-- 'remito_test' de wa_outbox si se quiere re-probar el mismo NP).

-- Foreign table a los registros de producción de Virgilio (lk_ppp_reader ya tiene SELECT).
create foreign table if not exists virgilio.registros_produccion (
  opcion text, legajo text, texto text, ts_cliente timestamptz, descripcion text
) server virgilio_db options (schema_name 'public', table_name 'Registros_Produccion_Virgilio');

-- Mapa remito->cliente SÓLO para pruebas (del lado del bot, no de Gestión).
create table if not exists public.wa_remito_test_map (
  np text primary key,
  cod_cliente int not null,
  activo boolean not null default true,
  nota text,
  created_at timestamptz not null default now()
);
alter table public.wa_remito_test_map enable row level security;

insert into public.wa_remito_test_map(np, cod_cliente, nota)
values ('PRUEBA 4210-505', 4210, 'SENTINELA test sql/162 - remito de prueba mapeado a Garbarino 4210. Pedido Pablo 16/10.')
on conflict (np) do update set cod_cliente = excluded.cod_cliente, activo = true;

-- Lee la señal CRN de los NP del mapa y encola el aviso al cliente mapeado.
create or replace function public.wa_avisos_remito_test()
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare v_n int := 0; r record; v_tpl text;
begin
  for r in
    select m.np, m.cod_cliente,
           max(reg.ts_cliente) as controlado_at,
           bool_or(reg.descripcion ilike '%retira%') as es_retira,
           (select whatsapp from bot_customer_whatsapps b
            where b.cod_cliente = m.cod_cliente order by b.is_primary desc, b.created_at desc limit 1) as phone
    from public.wa_remito_test_map m
    join virgilio.registros_produccion reg
      on reg.opcion = 'CRN' and split_part(reg.texto,'|',1) = m.np
    where m.activo
      and not exists (select 1 from wa_outbox w where w.context = 'remito_test' and w.ref_id = m.np)
    group by m.np, m.cod_cliente
  loop
    if r.phone is null then continue; end if;
    v_tpl := case when r.es_retira then 'pedido_retirado' else 'pedido_entregado' end;
    insert into wa_outbox (phone, template_name, template_params, context, ref_id)
    values (r.phone, v_tpl,
            jsonb_build_object('1', to_char((r.controlado_at at time zone 'America/Argentina/Buenos_Aires')::date,'DD/MM')),
            'remito_test', r.np);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform net.http_post(url := 'https://kwkclwhmoygunqmlegrg.supabase.co/functions/v1/lk_outbox-flush',
      headers := jsonb_build_object('Content-Type','application/json'), body := '{}'::jsonb, timeout_milliseconds := 15000);
  end if;
  return v_n;
exception when others then
  raise warning 'wa_avisos_remito_test falló: %', sqlerrm;
  return -1;
end $function$;

select cron.schedule('lk_aviso-remito-test', '*/2 * * * *', 'select public.wa_avisos_remito_test();');
