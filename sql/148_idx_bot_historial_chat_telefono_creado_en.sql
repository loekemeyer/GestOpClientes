-- 148 · índice de bot_historial_chat al repo (Pablo Olejavetzky, 14/10/2026, P3.3 del plan de los 8 puntos)
--
-- El índice ya existe en la base (PaginaLK) pero no estaba en ninguna migración del repo: lo lee la memoria del
-- agente (ventana de mensajes y charla anterior por teléfono, orden descendente por fecha). Se versiona para que un
-- proyecto recreado desde cero lo tenga. Idempotente.
--
-- Se corre a mano en el SQL editor de PaginaLK (kwkclwhmoygunqmlegrg); ya aplicado (es la definición viva de la base).

create index if not exists bot_historial_chat_telefono_creado_en_idx
  on public.bot_historial_chat using btree (telefono, creado_en desc);
