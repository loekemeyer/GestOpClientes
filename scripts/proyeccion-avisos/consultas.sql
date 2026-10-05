-- Consultas que alimentan datos-base.json (informe "Proyección de avisos y gasto"). SÓLO LECTURA.
-- Se corrieron el 05/10/2026 contra PaginaLK (kwkclwhmoygunqmlegrg) y Gestión (hrxfctzncixxqmpfhskv).
-- Para rehacer el informe: correr cada una, pegar el resultado en datos-base.json y `node generar.mjs`.

-- ═══ 1) PEDIDOS WEB DE LK por mes, modo de entrega y etapa — PaginaLK ═════════════════════════════════════════
-- Un pedido = una fila de orders con sheets_sent (lo que dispara trg_notify_order_created). Se sacan los cancelados
-- (GV_Web_Cancelados: sólo se registran desde septiembre). Modo = el de v_pedidos_web (zona 'Retira' → retira; con
-- expreso → expreso; si no → reparto), igual que trg_order_tracking_notify. Etapa = estado REAL en
-- gv_pedido_web_estado_pagina (Gestión guarda ~4 semanas); lo que no está en la vista y es anterior al 07/09 se
-- da por entregado (salió de la vista porque terminó); lo posterior que no está queda en 'recibido'.
-- con_tel = el cliente tiene teléfono en bot_telefonos_empresa, wa_clientes_telefono o bot_customer_whatsapps.
with cx as (select distinct order_id from virgilio."GV_Web_Cancelados" where empresa = 'lk'),
est as materialized (select order_id, estado, coalesce(entregado,false) entregado, coalesce(facturado,false) facturado
                     from virgilio.gv_pedido_web_estado_pagina where empresa = 'lk'),
ord as (select o.id order_id, (o.created_at at time zone 'America/Argentina/Buenos_Aires')::date fecha
        from orders o left join cx on cx.order_id = o.id
        where o.sheets_sent and o.created_at >= '2026-06-01' and cx.order_id is null),
modo as (select order_id,
           max(case when zona_expreso ilike 'retira%' then 'retira' when coalesce(btrim(nombre_expreso),'') <> '' then 'expreso' else 'reparto' end) modo,
           max(cod_cliente::text) cod
         from v_pedidos_web where linea_rn = 1 and empresa = 'lk' group by order_id),
tel as (select cod_cliente::text cod from bot_telefonos_empresa where empresa = 'lk' and coalesce(telefono,'') <> ''
        union select cod_cliente from wa_clientes_telefono where coalesce(telefono,'') <> ''
        union select cod_cliente::text from bot_customer_whatsapps)
select to_char(date_trunc('month', ord.fecha),'YYYY-MM') mes, coalesce(m.modo,'reparto') modo,
  case when e.order_id is not null then (case when e.entregado then 'entregado' when e.estado = 'sin_programar' then 'recibido'
                                              when e.facturado then 'facturado' else 'programado' end)
       when ord.fecha < date '2026-09-07' then 'entregado' else 'recibido' end etapa,
  count(*) pedidos, count(*) filter (where t.cod is not null) con_tel
from ord left join modo m on m.order_id = ord.order_id left join est e on e.order_id = ord.order_id
         left join (select distinct cod from tel) t on t.cod = m.cod
group by 1,2,3 order by 1,2,3;

-- ═══ 2) MENSAJES DE FACTURA (lk_factura-check) por mes — Gestión ═══════════════════════════════════════════════
-- Un mensaje por (empresa, cliente, día, método de pago). Método según la condición de la factura; 'Prefiero no
-- decidir', 'Sin Cotizador', 'NN FF', etc. son "no decidido" y se suman a contado si hay contado ese día, o al método
-- real de menor descuento (planMetodos de lk_factura-check). Plantilla = grupo (contado/crédito/e-cheq) y _s (1
-- factura) o _p (varias). Contrastado: Ago + Sep da 434 mensajes de LK; la simulación del 29/09 contó 431 (31/07-28/09).
with tel as (select empresa, cod_cliente::text cod from "GV_Clientes_Whatsapp" where coalesce(telefono,'') <> ''
             union select 'lk', cod_cliente::text from whatsapp_clientes where coalesce(telefono,'') <> ''),
f as (select empresa, cod_cliente::text cod_cliente, fecha::date fecha,
        case when condicion ~* 'e-?cheq.*120' then 'e120' when condicion ~* 'e-?cheq' then 'e90'
             when condicion ~* '15 a 30' then 'c15' when condicion ~* '31 a 45' then 'c31' when condicion ~* '46 a 60' then 'c46'
             when condicion ~* 'contado' then 'contado' else 'nd' end m
      from gv_cobranza_facturas_pago where factura like 'FC%' and fecha >= '2026-06-01' and fecha < '2026-10-06'),
rk as (select 'e120' m, 0 r union all select 'e90',1 union all select 'c46',2 union all select 'c31',3 union all select 'c15',4 union all select 'contado',5),
dia as (select f.empresa, f.cod_cliente, f.fecha, bool_or(f.m = 'contado') hay_contado,
          (array_agg(f.m order by rk.r) filter (where f.m <> 'nd'))[1] menor_dto
        from f left join rk on rk.m = f.m group by 1,2,3),
f2 as (select f.empresa, f.cod_cliente, f.fecha,
         case when f.m <> 'nd' then f.m when d.hay_contado or d.menor_dto is null then 'contado' else d.menor_dto end mf
       from f join dia d using (empresa, cod_cliente, fecha)),
g as (select empresa, cod_cliente, fecha, mf, count(*) n from f2 group by 1,2,3,4)
select g.empresa, to_char(date_trunc('month', g.fecha),'YYYY-MM') mes,
  case when mf = 'contado' then 'contado' when mf like 'c%' then 'credito' else 'echeq' end grupo,
  (t.cod is not null) con_tel, count(*) filter (where n = 1) s, count(*) filter (where n > 1) p
from g left join (select distinct empresa, cod from tel) t on t.empresa = case when g.empresa = 'chef' then 'chef' else 'lk' end and t.cod = g.cod_cliente
group by 1,2,3,4 order by 1,2,3,4;
-- (Chef: no se pudo cruzar el teléfono —la tabla de teléfonos no lo trae por código—, por eso en datos-base.json va con_tel = null.)

-- ═══ 3) RECORDATORIO DE DESCUENTO (lk_recordatorio-descuento) por mes de aviso — Gestión ══════════════════════
-- Misma regla que la edge: facturas de LK con saldo, sin e-cheq / FF / Sin Cotizador, un aviso por (cliente, fecha, condición,
-- escalón 14/30/45/60) dos días hábiles antes de que venza el escalón, sólo si la factura seguía sin pagar ese día
-- (estado 'impaga' o fecha_pago posterior). Días hábiles con planify.feriados.
with fer as (select fecha::date d from planify.feriados),
cal as (select d, row_number() over (order by d) bd from generate_series(date '2026-02-01', date '2027-03-31', interval '1 day') g(d)
        where extract(isodow from d) < 6 and d::date not in (select d from fer)),
tel as (select cod_cliente::text cod from "GV_Clientes_Whatsapp" where empresa = 'lk' and coalesce(telefono,'') <> ''
        union select cod_cliente::text from whatsapp_clientes where coalesce(telefono,'') <> ''),
f as (select cod_cliente::text cod_cliente, fecha::date fecha, condicion, estado, fecha_pago::date fp
      from gv_cobranza_facturas_pago
      where empresa = 'lk' and factura like 'FC%' and fecha >= '2026-03-01' and fecha < '2026-10-06'
        and condicion !~* '(e-?cheq|\mFF\M|sin cotizador)'),
g as (select cod_cliente, fecha, condicion, bool_or(estado = 'impaga') impaga, max(fp) ult_pago,
             bool_and(estado = 'pagada sin rastro en bancos') sin_rastro from f group by 1,2,3),
r as (select g.*, k from g cross join unnest(array[14,30,45,60]) k),
h as (select r.*, (select bd from cal where d >= (r.fecha + r.k) order by d limit 1) bd_h from r),
a as (select h.*, (select d from cal where bd = h.bd_h - 2) aviso from h)
select to_char(date_trunc('month', aviso),'YYYY-MM') mes, k escalon, (t.cod is not null) con_tel, count(*) avisos
from a left join (select distinct cod from tel) t on t.cod = a.cod_cliente
where aviso >= '2026-06-01' and aviso < '2026-10-06' and not sin_rastro and (impaga or ult_pago > aviso)
group by 1,2,3 order by 1,2,3;

-- ═══ 4) BASE DE CONSULTAS DEL WHATSAPP DE VENTAS (estudio de cobertura) — PaginaLK ═════════════════════════════
-- Hay dos cargas, ambas YA AGRUPADAS por causa (no hay fecha por mensaje): 'm' = 71 casos / 1.013 consultas de clientes con
-- código, 01/01-09/06/2026; 'r' = 11 ejemplos (uno por causa) que pesan las 712 consultas del 28/07-28/09 (236 contactos,
-- más 108 saludos que el estudio cuenta aparte). metodo = cómo conviene resolverla (Plantilla = respuesta fija del bot, sin
-- IA; Agente = IA); respuesta_via = cómo la resolvió el bot en la última simulación ('IA' o respuesta fija/regla).
select left(clave,1) base, coalesce(metodo,'-') metodo, count(*) casos, sum(consultas) consultas,
       sum(consultas) filter (where respuesta_via = 'IA') hoy_con_ia, sum(consultas) filter (where respuesta_via is distinct from 'IA') hoy_sin_ia
from wa_agente_evals where clave is not null group by 1,2 order by 1,4 desc;

-- Costo por llamada a la IA (bot_token_usage, llamadas reales del webhook del 02/10, Sonnet 4.6, ~10.400 tokens de entrada):
-- US$ 0,0315 a 0,0328. Haiku 4.5 (simulador 01/10): US$ 0,0105 a 0,0111. Llamadas por consulta que usa IA: 46 (Sonnet) y 53
-- (Gemini) llamadas sobre las mismas 27 frases con IA = 1,7 a 2,0.
