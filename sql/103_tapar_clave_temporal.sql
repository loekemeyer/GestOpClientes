-- 103: la clave temporal no queda legible (Pablo, 29/09). Las claves que manda el bot (reseteo de clave y bienvenida
-- del alta, lk_alertas) van en wa_outbox.body como "Clave: xxxx1234". Apenas el mensaje termina su recorrido en la cola
-- (enviado, fallido o retenido por la llave) se tapa: "Clave: ••••••••". Antes no se puede: el flush lee el body para
-- mandarlo. lk_outbox-flush además la tapa en el historial de la conversación.
-- Mientras la llave esté en '0' el mensaje queda 'pending' y la clave sigue legible en la cola hasta que se despache.
create or replace function public.wa_outbox_tapar_clave()
returns trigger language plpgsql as $$
begin
  if new.status in ('sent', 'failed', 'held_no_whitelist') and new.body ~ 'Clave: \S' then
    new.body := regexp_replace(new.body, 'Clave: \S+', 'Clave: ••••••••', 'g');
  end if;
  return new;
end $$;

drop trigger if exists trg_wa_outbox_tapar_clave on public.wa_outbox;
create trigger trg_wa_outbox_tapar_clave before update of status on public.wa_outbox
  for each row execute function public.wa_outbox_tapar_clave();
