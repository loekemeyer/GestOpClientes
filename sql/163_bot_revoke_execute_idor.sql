-- 163_bot_revoke_execute_idor.sql
-- Captura en migración el REVOKE EXECUTE de las funciones bot_* SECURITY DEFINER
-- de public, que se había aplicado a mano en la base el 14/10/2026.
--
-- Problema (IDOR, auditoría problema crítico 14/10, docs/ESTADO.md › Seguridad):
-- Supabase grantea EXECUTE por defecto a anon, authenticated y service_role en TODA
-- función nueva de public (no aparece en ninguna migración). Una función SECURITY
-- DEFINER bot_* que recibe un identificador del cliente (teléfono, order_id, cod_cliente,
-- cuit) y devuelve o toca datos de ESE cliente, sin atar al que llama, es un IDOR:
-- cualquier usuario logueado (authenticated, hay 1264 clientes con login) la llamaba
-- desde la consola con otro teléfono y operaba sobre datos ajenos. Ejemplo medido:
-- un cliente leía los pedidos de otro cambiando el teléfono en bot_mis_pedidos.
--
-- Fix: estas funciones sólo las debe llamar el webhook o un cron (service_role).
-- Se revoca EXECUTE a anon, authenticated y public; service_role lo conserva.
-- El webhook (lk_whatsapp-webhook) usa la service key, así que no se rompe.
--
-- Este archivo documenta el estado real: al 15/10/2026, de las 54 bot_* de public,
-- 52 son SECURITY DEFINER y las 52 tienen 0 EXECUTE para anon/authenticated/public
-- (verificado en sólo lectura). El REVOKE es idempotente: correrlo de nuevo no cambia
-- nada. Regla en CLAUDE.md: "funciones SECURITY DEFINER en public nacen ejecutables
-- por anon/authenticated" — toda bot_*/wa_* nueva debe traer su revoke en la MISMA
-- migración que la crea.
--
-- NO cubre las wa_* SECURITY DEFINER (prefijo distinto), que quedan por barrer aparte.

revoke execute on function public.bot_accion_tope(p_phone text, p_accion text, p_limite integer) from anon, authenticated, public;
revoke execute on function public.bot_aplicar_agregado(p_alerta_id bigint, p_aprobado_por text) from anon, authenticated, public;
revoke execute on function public.bot_ataque_entrada(p_phone text, p_patron text) from anon, authenticated, public;
revoke execute on function public.bot_auditar_tool(p_telefono text, p_tool text, p_params jsonb, p_resumen text) from anon, authenticated, public;
revoke execute on function public.bot_buscar_mi_historial(p_telefono text, p_query text, p_limite integer) from anon, authenticated, public;
revoke execute on function public.bot_buscar_productos(p_query text, p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_buscar_productos_chef(p_query text, p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_cadenas_lista_propia(p_cods integer[]) from anon, authenticated, public;
revoke execute on function public.bot_cliente_por_whatsapp(p_telefono text) from anon, authenticated, public;
revoke execute on function public.bot_conv_get_modo(p_telefono text) from anon, authenticated, public;
revoke execute on function public.bot_conv_set_modo(p_telefono text, p_modo text, p_agente_nombre text, p_motivo text, p_horas integer) from anon, authenticated, public;
revoke execute on function public.bot_detalle_pedido(p_telefono text, p_order_id bigint) from anon, authenticated, public;
revoke execute on function public.bot_detalle_por_indice(p_telefono text, p_indice integer) from anon, authenticated, public;
revoke execute on function public.bot_detectar_eventos_pedido(p_simular boolean, p_sembrar boolean) from anon, authenticated, public;
revoke execute on function public.bot_encolar_recordatorios_25() from anon, authenticated, public;
revoke execute on function public.bot_estado_pedidos_gv(p_ids bigint[]) from anon, authenticated, public;
revoke execute on function public.bot_flush_outbox(p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_guardar_mensaje(p_telefono text, p_rol text, p_contenido text) from anon, authenticated, public;
revoke execute on function public.bot_identificar_chef(p_phone text) from anon, authenticated, public;
revoke execute on function public.bot_inbox_enviar_mensaje(p_telefono text, p_contenido text, p_agente_nombre text, p_horas_pausa integer) from anon, authenticated, public;
revoke execute on function public.bot_inbox_historial(p_telefono text, p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_inbox_listar_chats(p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_inbox_log_acceso(p_agente_nombre text, p_ip text, p_exito boolean) from anon, authenticated, public;
revoke execute on function public.bot_inbox_set_alias(p_telefono text, p_alias text, p_agente text) from anon, authenticated, public;
revoke execute on function public.bot_kb_agregar(p_telefono text, p_pregunta text, p_respuesta text) from anon, authenticated, public;
revoke execute on function public.bot_kb_consultar(p_query text, p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_kb_eliminar(p_telefono text, p_id bigint) from anon, authenticated, public;
revoke execute on function public.bot_kb_listar(p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_leer_historial(p_telefono text, p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_mi_entrega(p_telefono text) from anon, authenticated, public;
revoke execute on function public.bot_mis_descuentos(p_telefono text) from anon, authenticated, public;
revoke execute on function public.bot_mis_pedidos(p_telefono text, p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_mis_top_productos(p_telefono text, p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_nombre_cliente(p_telefono text) from anon, authenticated, public;
revoke execute on function public.bot_obtener_catalogo_url() from anon, authenticated, public;
revoke execute on function public.bot_obtener_imagenes_producto(p_cod text) from anon, authenticated, public;
revoke execute on function public.bot_outbox_mark(p_id bigint, p_status text, p_error text) from anon, authenticated, public;
revoke execute on function public.bot_pago_por_cliente_fecha(p_cod_cliente text, p_fecha date) from anon, authenticated, public;
revoke execute on function public.bot_pedido_armar(p_telefono text, p_items jsonb, p_condicion_code integer, p_slot integer, p_retiro_fecha date, p_retiro_franja text, p_observaciones text, p_guardar boolean, p_origen text) from anon, authenticated, public;
revoke execute on function public.bot_pedido_confirmar(p_precarga_id bigint, p_por text, p_forzar boolean) from anon, authenticated, public;
revoke execute on function public.bot_pedido_descartar(p_precarga_id bigint, p_por text, p_nota text) from anon, authenticated, public;
revoke execute on function public.bot_permiso_pedidos(p_telefono text) from anon, authenticated, public;
revoke execute on function public.bot_productos_novedades(p_limit integer) from anon, authenticated, public;
revoke execute on function public.bot_reactivar_inactivos() from anon, authenticated, public;
revoke execute on function public.bot_register_decide(p_request_id bigint, p_decision text, p_agente text, p_motivo text) from anon, authenticated, public;
revoke execute on function public.bot_register_decide_by_primary(p_request_id bigint, p_decision text) from anon, authenticated, public;
revoke execute on function public.bot_register_pending() from anon, authenticated, public;
revoke execute on function public.bot_register_request_v2(p_telefono text, p_cuit text) from anon, authenticated, public;
revoke execute on function public.bot_stock_web_comprometido(p_cods text[]) from anon, authenticated, public;
revoke execute on function public.bot_submit_order(p_telefono text, p_items jsonb, p_payment_method text) from anon, authenticated, public;
revoke execute on function public.bot_sync_telefonos_empresa() from anon, authenticated, public;
revoke execute on function public.bot_tracking_produccion(p_telefono text, p_limit integer) from anon, authenticated, public;

-- Verificación (debe devolver 0 filas):
-- select p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname like 'bot\_%' and p.prosecdef
--    and (has_function_privilege('anon', p.oid, 'EXECUTE')
--      or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
