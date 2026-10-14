# Runbook — ensayar la pausa del bot (P7 del plan de los 8 puntos)

Pablo Olejavetzky, 14/10/2026. P7 pide **ensayar una vez, antes del go-live, apagar y prender las
respuestas a los clientes del piloto SIN TOCAR CÓDIGO**. Ya existe el control; esto es la checklist
para hacerlo en 2 minutos y confirmar que anduvo. Lo hace un **admin** (Pablo); no necesita a Claude.

## Qué es la pausa

El bot le habla a un cliente sólo si la **llave de envíos** (`app_settings.wa_envio_automatico`) lo
deja. Tres valores:

| Valor | Qué hace |
|---|---|
| `0` | **Apagado: el bot no le contesta a nadie** (ni automáticos ni respuestas del webhook). Es la PAUSA. |
| `prueba` | Sólo le contesta y le manda automáticos a la whitelist (hoy: Thomy + Damián de Chef). Es el estado del piloto. |
| `1` | Producción: le habla a todos los clientes. Exige escribir «PRODUCCIÓN» (es de Luis). |

Toda respuesta a Meta pasa por `wa-guard` → `wa_puede_enviar`, que lee esa llave: por eso con `0`
no sale nada, sin apagar crons ni tocar código. Cada cambio queda auditado en `wa_llave_cambios`.

## Ensayo (hacerlo una vez antes del 16/10)

1. **Mirar el estado actual.** En el dashboard, arriba, la franja **«Envíos a clientes»** dice el modo
   (debería estar en **Prueba**). El valor real: `select value from app_settings where key = 'wa_envio_automatico';` → `prueba`.
2. **Pausar.** En esa franja, botón para cambiar la llave → elegir **Apagado (`0`)**. (Es admin y queda auditado.)
   - Alternativa por SQL (misma cosa, sin pasar por el dashboard): `update app_settings set value = '0' where key = 'wa_envio_automatico';`
3. **Verificar que está pausado.** Que **Thomy** le escriba algo al bot por WhatsApp → **no tiene que recibir respuesta**.
   En la charla, el panel muestra «A este número no le sale nada: la llave de envío lo corta».
   (Si no querés molestar a Thomy: alcanza con ver la franja en «Apagado» y el log — paso 6.)
4. **Retomar.** Misma franja → volver a **Prueba (`prueba`)**. Por SQL: `update app_settings set value = 'prueba' where key = 'wa_envio_automatico';`
5. **Verificar que retomó.** Que Thomy vuelva a escribir → ahora **sí** le contesta.
6. **Confirmar que quedó auditado.** `select modo_anterior, modo_nuevo, usuario, creado_en from wa_llave_cambios order by creado_en desc limit 4;`
   → tienen que estar los dos cambios (prueba→0 y 0→prueba) con tu nombre.

## Pausar a UN solo cliente (sin cortarle a toda la whitelist)

Si durante el piloto hace falta que el bot **deje de contestarle a un cliente puntual** (y siga con el
resto), no se toca la llave: en la charla de ese cliente, el botón **«Pasar a una persona»**
(`toggle_human`) corta al bot sólo para ese número; «Que vuelva el bot» lo reactiva.

## Qué NO hace la pausa

- **No apaga crons, triggers ni feeds** (principio de la vasectomía): todo lo demás sigue corriendo y
  encolando; sólo se corta la salida a Meta.
- **No pasa a producción.** El `1` (hablarle a todos los clientes) es decisión de Luis y exige escribir «PRODUCCIÓN».

## Criterio de P7 cumplido

La pausa se ensayó una vez (pasos 1-6, con su fila en `wa_llave_cambios`) **y** el tope de gasto diario se
revisa el 23/10 con el gasto real del piloto (`bot_token_usage`). Con las dos cosas, P7 pasa a «ok».
