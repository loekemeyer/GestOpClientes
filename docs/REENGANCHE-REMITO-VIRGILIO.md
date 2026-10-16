# Reenganche de los avisos de entrega al remito marcado en Virgilio

**Pedido de Pablo Olejavetzky, 15/10/2026.** Los pedidos que salen de acá salen con remito. El
aviso al cliente de que su pedido se entregó/retiró/llegó al expreso tiene que gatillarse por el
**remito marcado en Virgilio** por la persona que despacha o entrega, no por el CRN de Gestión
como hoy.

> ✅ **Lado de PaginaLK: HECHO (16/10/2026, Pablo: "en todos los casos").** Los tres eventos ya
> disparan su plantilla al marcarse `entregado`, y el expreso suma su "recibido" además del "en
> viaje" (`sql/168`). Las 3 plantillas están aprobadas en Meta y se probaron el 16/10 (NP 1692 de
> 4210: marcar entregado → `pedido_retirado` salió a …6849).
>
> ⚠ **Lo que sigue del lado de Luis.** El disparador lee el `entregado` de **Gestión**
> (`gv_pedido_web_estado_pagina.entregado`, que se marca al día siguiente ~08:00), NO una marca
> propia del remito. Cuando Virgilio exponga la marca del remito, esa marca es la que tiene que
> prender ese `entregado` (opción A, más abajo): es un cambio del lado de Virgilio, el de PaginaLK
> ya quedó listo. "La unión de los dos mundos" (Pablo, 15/10).

## Los tres eventos

| Modo | Quién marca en Virgilio | Plantilla que sale | Estado hoy |
|---|---|---|---|
| Retira en depósito | Quien entrega, al hacer firmar el remito | `pedido_retirado` | aprobada en Meta · disparada por el trigger al marcarse `entregado` (`sql/168`, antes vivía sólo en la base) |
| Reparto (transportista) | El transportista, al entregar | `pedido_entregado` | aprobada · disparada por el trigger al marcarse `entregado` |
| Expreso | Quien despacha, cuando el expreso recibe | `pedido_en_expreso` | aprobada · disparada por el trigger al marcarse `entregado` (`sql/168`; antes mandaba la vieja `pedido_en_viaje_expreso`). El "en viaje" sigue saliendo aparte (cron, context `en_viaje_web`) |

`pedido_en_expreso` confirma que el expreso **ya recibió** la mercadería. Es distinto de
`pedido_en_viaje_expreso`, que avisa la **salida hacia** el expreso (carga camión). El texto de
`pedido_en_expreso` es neutro a propósito: la entrega final (retiro en sucursal del expreso o
reparto a domicilio) la maneja el expreso y LK no tiene ese dato, así que no promete modalidad.

## Cómo funciona hoy (lo que hay que reenganchar)

1. `sync_order_tracking_from_gestion` (`sql/069`, cron cada 15 min) lee
   `virgilio.gv_pedido_web_estado_pagina` (FDW a Gestión) y pone `order_tracking.status`:
   `g.entregado` → `'entregado'`; `sin_programar` → `'recibido'`; resto → `'programado'`.
2. El trigger `trg_order_tracking_notify` (`sql/084`, params corregidos en `sql/094`) reacciona al
   cambio de estado y elige plantilla por modo (`v_modo` sale de `v_pedidos_web.zona_expreso` /
   `nombre_expreso`). En la rama `entregado` hoy:
   - `v_modo = 'reparto'` → `pedido_entregado`, params `{1: fecha_pedido}`.
   - `v_modo = 'expreso'` → `pedido_en_viaje_expreso`, params `{1: fecha_pedido, 2: expreso}`.
   - `v_modo = 'retira'` → **no avisa** (el trigger excluye `retira`: `v_modo IN ('expreso','reparto')`).

El origen del `'entregado'` es el CRN de Gestión. Eso es lo que cambia.

## Lo que necesito de Virgilio (contrato para Luis)

Por cada pedido, una señal de que **se marcó el remito**, con:

1. **Qué pedido** — el `order_id` / NP, para cruzar con `order_tracking.np_number` y `orders.id`.
2. **Qué evento** — retira firmado · reparto entregado · expreso recibido. Puede venir como un
   `remito_tipo` (`retira|reparto|expreso`), o deducirse del modo del pedido (ya lo tengo en
   `v_pedidos_web`) si la marca es una sola.
3. **Cuándo** — un timestamp de la marca (para la fecha del aviso y para no reavisar).

Lo ideal: exponerlo en la **misma vista FDW** `virgilio.gv_pedido_web_estado_pagina` (o una
hermana) como columnas, para no tocar la cañería de sincronización. Por ejemplo
`remito_marcado_at timestamptz` y, si hace falta, `remito_tipo text`.

> ⚠ **Estado 16/10 — lo entregado vs. lo que falta (el bloqueo para unificar TODO).** Virgilio ya
> expone `virgilio.gv_remitos_controlados_bot` (`np`, `tipo` = `retirado`|`entregado`, `cod_cliente`,
> `controlado_at`, `empresa`, `es_web`) y el cron `wa_avisos_remito_entregado` ya la consume para los
> **no web** (`es_web = false`). **Falta el MODO:** el feed NO distingue **expreso** de **reparto**
> (sólo `tipo`), y desde PaginaLK **no hay puente `np`→`order_id`** para deducirlo (`v_pedidos_web`
> se cruza por `order_id`, el feed trae el `np` string tipo «LK 0309»; `cod_isis` no matchea). Como el
> **expreso es el modo más grande** (571 de 1.260 pedidos web; reparto 473, retira 216), sin el modo
> no se puede sacar el filtro `es_web` para unificar: a los de expreso se les mandaría «pedido
> entregado» cuando en realidad lo entrega el expreso, no LK. **Pedido a Luis:** sumar al feed el
> **modo** (`expreso`|`reparto`|`retira`) o un flag `es_expreso` + nombre del expreso, igual que ya
> manda `tipo`. Con eso el cron mapea los tres (retirado→`pedido_retirado`, entregado+reparto→
> `pedido_entregado`, entregado+expreso→`pedido_en_expreso`) y se saca la rama «entregado» del trigger
> web → un solo camino.

## Dos formas de integrarlo (a decidir con Luis + Pablo al implementar)

**Opción A — reusar el estado `entregado` (cambio mínimo).** La marca del remito en Virgilio pone
`g.entregado = true` (como hoy) para los tres modos. `sync_order_tracking_from_gestion` no cambia.
Sólo cambia el **mapeo del trigger**: dejar de excluir `retira` y mandar `pedido_en_expreso` en vez
de `pedido_en_viaje_expreso` en la rama `entregado`:

```sql
-- dentro de trg_order_tracking_notify, rama NEW.status = 'entregado'
-- quitar la exclusión de 'retira' (hoy: v_modo IN ('expreso','reparto'))
IF v_modo = 'expreso' THEN
  v_tpl := 'pedido_en_expreso';                 -- antes: pedido_en_viaje_expreso
  v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'),
                                 '2', regexp_replace(v_expreso, '^\s*expreso\s+', '', 'i'));
ELSIF v_modo = 'retira' THEN
  v_tpl := 'pedido_retirado';
  v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'));
ELSE
  v_tpl := 'pedido_entregado';
  v_params := jsonb_build_object('1', coalesce(v_fecha_pedido, 'reciente'));
END IF;
```

- ⚠ Cuidado: hoy `expreso + entregado` manda `pedido_en_viaje_expreso`. Si Virgilio marca
  "expreso recibió" como `entregado`, el aviso de **salida** hacia el expreso tiene que venir de
  otro momento (carga camión, `trg_notify_despacho`), no de esta rama, para no pisar los dos.

**Opción B — estados nuevos en `order_tracking`.** Agregar `'retirado'` y `'recibido_expreso'`;
`sync_order_tracking_from_gestion` mapea la marca del remito a esos estados; el trigger ramifica
por estado. Semántica más limpia (cada aviso tiene su estado), pero más código y una migración de
`order_tracking`.

Recomiendo **A** si la marca de Virgilio es un booleano por pedido: es el delta más chico. **B** si
Virgilio va a distinguir más momentos (ej. expreso recibió vs. expreso entregó al cliente final).

## Pasos cuando el lado de Luis esté listo

1. Confirmar el contrato real de Virgilio (campos y valores) y elegir A o B con Pablo.
2. ~~Subir a Meta `pedido_retirado` y `pedido_en_expreso`~~ **HECHO el 15/10** (`templates_sync aplicar`,
   las dos quedaron `PENDING`: `pedido_retirado` id 2529181834243049, `pedido_en_expreso` id
   2318701338906372). **Aprobadas por Meta el 16/10** (ambas APPROVED, UTILITY). No manda mensajes crearlas.
3. Aplicar el cambio del trigger (con backup en `zz_backups`, como `sql/084`/`sql/094`).
4. Verificar con la llave `wa_envio_automatico` en `prueba` contra la lista blanca antes de `'1'`.
5. Pasar las dos plantillas a `estado: "conectada"` en `scripts/plantillas-artifact/disparadores.json`.

## Principio vasectomía

Nada de esto contacta a nadie hasta que `wa_envio_automatico` pase a `'1'`. Encola en `wa_outbox` y
sale por `bot_flush_outbox`/`wa_puede_enviar`, igual que el resto de los avisos.
