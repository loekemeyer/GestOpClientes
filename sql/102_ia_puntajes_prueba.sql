-- 102: respuestas del Simulador para puntuar (Pablo, 29/09). Con "Crear tareas de prueba", la respuesta de la IA en el
-- Simulador también se guarda para que Haiku la puntúe, marcada prueba=true: aparece 🧪 en la lista de revisión pero
-- NO cuenta en los promedios ni en "a revisar" de los clientes reales.
alter table public.wa_ia_puntajes add column if not exists prueba boolean not null default false;
