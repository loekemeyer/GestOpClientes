# Propuesta: una sola fuente de teléfonos para el bot (auditoría 695)

> **APLICADA el 13/10/2026 (`sql/145_telefonos_gv_manda_por_cliente.sql`).** Pablo Olejavetzky: *«Sí, investigalo y traeme la propuesta»* y después *«Aplicalo»*. Resultado en la sección 7.
> El texto original de la propuesta queda como estaba, para que se vea qué se dijo antes de aplicar.

## 1. Qué es el problema, medido el 13/10

El bot reconoce al cliente por teléfono con `wa_identify_customer`, que lee `wa_clientes_telefono`. Esa tabla la rearma cada día (cron 19, 10:00 UTC, última corrida 13/10, `succeeded`)
`sincronizar_ppp()` copiando `virgilio.whatsapp_clientes` (la «vieja», sin empresa). El 24/09 los teléfonos pasaron a `GV_Clientes_Whatsapp` (la «nueva», con empresa,
copia local `bot_telefonos_empresa`), que el bot sólo usa para separar Loekemeyer de Chef. La consulta a Thommy `c-20261005-0913-1` (¿cuál es la fuente buena?) sigue **pendiente** desde el 05/10.

1. **[Seguro] La sincronización funciona; lo que está quieto es la fuente.** `whatsapp_clientes` no cambia desde el 24/09 16:03 UTC. **La nueva tampoco:** su última fila es del 24/09 16:26 UTC.
   O sea que en 19 días nadie cambió un teléfono en ninguna de las dos. El problema, tal como se anotó («no se actualiza»), **no está demostrado**: no hay un cambio más nuevo que el bot no vea.
2. **[Seguro] Las dos fuentes coinciden en todo lo que comparten.** Comparando por los últimos 8 dígitos y sólo clientes de Loekemeyer: 608 de 623 clientes de la nueva tienen el mismo teléfono en la vieja,
   **0 conflictos reales** (hay 14 que difieren en el formato, por ejemplo con y sin el 15, y tienen los mismos 8 últimos dígitos). `wa_identify_customer` normaliza con `wa_normalize_phone`, así que el formato no importa.
3. **[Seguro] Lo que difiere es el alcance:** **196 clientes de LK están sólo en la vieja** (16 con pedido en los últimos 90 días) y **15 sólo en la nueva** (1 con pedido en 90 días).
   Hoy el bot reconoce a los 196 por la tabla y **no** reconoce a los 15. Los números del 05/10 (179 y 20) no coinciden con éstos porque ese día se contó distinto (por 10 dígitos, que confunde el 15).
4. **[Seguro] Para el piloto no hay riesgo:** los 4 teléfonos (LK 1987, 3790, 3848 y 3969) están en las dos fuentes, con el mismo cliente, y `wa_identify_customer` los reconoce.
   Detalle: LK 1987 (Bertotto) tiene el **mismo teléfono que el cliente Chef 1891**, que es el mismo negocio: el bot lo trata como un cliente con dos marcas.

## 2. Regla propuesta

**La nueva (`GV_Clientes_Whatsapp`) manda por cliente; la vieja sólo completa a los clientes que la nueva no tiene.** Se mantiene lo de sql/086: nunca entra un teléfono que en la nueva figura como sólo de Chef.

## 3. SQL exacto (sólo cambia el bloque de teléfonos de `sincronizar_ppp`; el resto de la función queda igual)

Bloque actual: `DELETE FROM public.wa_clientes_telefono …; INSERT … SELECT … FROM virgilio.whatsapp_clientes w WHERE … NOT (EXISTS CH … AND NOT EXISTS LK …)`.
Bloque propuesto (reemplaza al actual entre el `BEGIN` y el `EXCEPTION` de los teléfonos):

```sql
    DELETE FROM public.wa_clientes_telefono WHERE cod_cliente IS NOT NULL OR cod_cliente IS NULL;
    INSERT INTO public.wa_clientes_telefono (cod_cliente, telefono, actualizado)
    -- Auditoría 695: GV_Clientes_Whatsapp (con empresa) manda por cliente. La vieja sólo completa a los clientes que GV no tiene,
    -- sin los teléfonos que son sólo de Chef (sql/086, auditoría 616).
    WITH g AS MATERIALIZED (
      SELECT empresa, cod_cliente, telefono, actualizado,
             right(regexp_replace(telefono, '\D', '', 'g'), 10) AS t
      FROM virgilio.gv_clientes_whatsapp
      WHERE telefono IS NOT NULL AND btrim(telefono) <> '')
    SELECT g.cod_cliente, g.telefono, g.actualizado FROM g WHERE g.empresa = 'LK'
    UNION ALL
    SELECT w.cod_cliente::text, w.telefono, w.actualizado
    FROM virgilio.whatsapp_clientes w
    WHERE w.telefono IS NOT NULL AND btrim(w.telefono) <> ''
      AND NOT EXISTS (SELECT 1 FROM g WHERE g.empresa = 'LK' AND g.cod_cliente = w.cod_cliente::text)
      AND NOT (EXISTS (SELECT 1 FROM g WHERE g.empresa = 'CH' AND g.cod_cliente = w.cod_cliente::text
                         AND g.t = right(regexp_replace(w.telefono, '\D', '', 'g'), 10))
               AND NOT EXISTS (SELECT 1 FROM g WHERE g.empresa = 'LK' AND g.cod_cliente = w.cod_cliente::text
                         AND g.t = right(regexp_replace(w.telefono, '\D', '', 'g'), 10)));
    GET DIAGNOSTICS n_tel = ROW_COUNT;
```

Cómo se aplicaría (patrón de sql/086): (1) respaldo de la definición actual en `zz_backups.bkp_sincronizar_ppp_20261013` **con RLS prendida en el mismo paso**; (2) `CREATE OR REPLACE FUNCTION public.sincronizar_ppp()`
con la definición actual y sólo ese bloque cambiado; (3) una corrida a mano; (4) los `SELECT` de abajo. Rollback: la función guardada en el respaldo.

## 4. Efectos en cadena, calculados con las fuentes de hoy (sin aplicar)

1. `wa_clientes_telefono`: **792 filas hoy → 807 después**. 15 filas nuevas (los 15 clientes sólo de la nueva) y **0 clientes pierden un teléfono** (las 14 diferencias de formato quedan con el formato de la nueva, mismo número).
   Nota: una medición previa con 10 dígitos daba 29 y 14 por el formato; con 8 dígitos son 15 y 0.
2. `wa_identify_customer`: pasa a reconocer a esos 15 clientes. Los demás, igual.
3. `bot_reactivar_inactivos` y `bot_encolar_recordatorios_25` también leen esa tabla: esos 15 clientes pasan a poder recibir esos avisos. Con `wa_envio_automatico = 'prueba'` no sale nada a nadie fuera de la whitelist;
   al pasar la llave a `1` (Fase 4) les llegarían.
4. No cambia el piloto, ni la pausa, ni la whitelist.

## 5. Verificación posterior (sólo lectura)

```sql
select count(*) as filas from wa_clientes_telefono;                                   -- esperado 807
select count(*) as clientes_sin_telefono_nuevo_en_gv from (select g.cod_cliente from virgilio.gv_clientes_whatsapp g where g.empresa = 'LK'
  except select cod_cliente::text from wa_clientes_telefono) x;                       -- esperado 0
select cod_cliente, source from wa_identify_customer('<teléfono de uno de los 4 del piloto>');  -- el mismo cliente de siempre
```

## 6. Lo que sigue sin respuesta (y no depende de esta propuesta)

1. **¿Por qué 196 clientes de LK no pasaron a la nueva el 24/09?** (consulta `c-20261005-0913-1` a Thommy). Si se dejaron afuera a propósito, la regla «la vieja completa» los mantiene reconocibles
   cuando quizás no debería. Alternativa más estricta: no copiar la vieja, y los 196 dejan de ser reconocidos hasta que alguien los cargue en la nueva. 16 de ellos tienen pedido en los últimos 90 días.
2. **Quién carga teléfonos hoy.** Nadie los tocó en 19 días en ninguna de las dos fuentes; si se cargan en otro lugar (`customers.whatsapp`, vinculaciones) eso sí lo lee `wa_identify_customer`.

## 7. Resultado de la aplicación (13/10, 19:46 UTC)

Se aplicó con `apply_migration` (`sql/145`): respaldo de la función en `zz_backups.bkp_sincronizar_ppp_20261013` con RLS prendida, cambio **sólo** del `INSERT` de teléfonos sobre la definición viva
(la función conserva sus otros bloques: `rep_snapshot_despacho`, `gv_lk_np_feed`, `entregas_np`), y una corrida a mano de `sincronizar_ppp()`: `ok: true`, `errores: {}`, `telefonos: 807`.

1. **Medido: `wa_clientes_telefono` pasó de 792 a 807 filas**, como se calculó. Los 623 clientes de LK de GV tienen su fila (0 sin fila). Ningún cliente de Chef-sólo quedó colgado de un código de LK (0).
2. **Los 43 teléfonos de clientes de LK que no están en la tabla** son exactamente los 43 que `sql/086` saca por figurar sólo de Chef en GV: **ya faltaban antes**, no es una pérdida nueva (43 de 43 explicados).
3. **Piloto: los 5 teléfonos (LK 1987, 3790, 3848, 3969 y 4028) siguen identificando al cliente correcto.**
4. **Efecto que la propuesta no previó:** de los 15 clientes nuevos en la tabla, **8 se identifican bien y 7 no**. Los 7 no se identifican «de forma segura» (ninguno identifica a otro cliente): en 6 el teléfono es **también el de otro
   cliente de Loekemeyer con distinto CUIT**, y `wa_identify_customer` no identifica a nadie cuando un teléfono es de dos empresas. O sea que esos 6 clientes «otros», que antes se reconocían, **ahora pasan a vinculación con revisión humana**.
   Ninguno es del piloto y ninguno le escribió nunca al bot; uno (LK 3862 Jauregui) tiene 2 pedidos en 90 días, y su par nuevo es LK 2502 «Filippi Navier (Ex Jauregui)», casi seguro el mismo negocio con otro código.
   Pares (nuevo / otro): 1941 / 747, 2340 / 1180, 2502 / 3862, 2516 / 1450, 820 / 2001, 984 / 2099. Es un dato a limpiar en GV; el séptimo (LK 2383) no se identifica por otra razón que no se investigó.
5. **Pendiente sin cambio:** la consulta a Thommy `c-20261005-0913-1`. Los 196 clientes sólo de la vieja siguen reconocibles, porque la vieja los completa.
