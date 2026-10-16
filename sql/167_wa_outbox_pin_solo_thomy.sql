-- 167: el código PIN del admin (plantilla notif_thomy_admin, contexto admin_pin) sólo puede salir al WhatsApp de Thomy.
--
-- Pablo Olejavetzky, 16/10/2026: «tenés que tener ultra seguridad que sólo va para Thommy» y «sí, aplicalo».
--
-- Antes de esto el destino dependía de UNA fila: admin_pin_pedir_codigo (PaginaLK, no está en este repo) lee el teléfono de
-- app_settings.pin_aprobador_whatsapp y encola el código en wa_outbox. Nada frenaba el envío si esa fila cambiaba (una
-- sesión con service_role, una edge, el repo de PaginaLK). Con la llave en 'prueba' lo atajaba la whitelist; con la llave
-- en '1' el código saldría a cualquier número.
--
-- El candado vive en la cola, que es el único camino a Meta (lk_outbox-flush), y el número va escrito fijo a propósito: si
-- alguien cambia pin_aprobador_whatsapp, pedir el código da error y no sale nada (falla cerrado). Cambiar de aprobador
-- exige cambiar esta función, con commit y revisión.
--
-- No toca el tapado del código (trg_wa_outbox_tapar_codigo_pin, que sólo cambia template_params y status) ni los demás avisos.

create or replace function public.wa_outbox_pin_solo_thomy() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.template_name = 'notif_thomy_admin' or new.context = 'admin_pin')
     and new.phone is distinct from '5491162521635' then
    raise exception 'PIN admin: solo puede ir al telefono de Thomy' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_wa_outbox_pin_solo_thomy on public.wa_outbox;
create trigger trg_wa_outbox_pin_solo_thomy
  before insert or update of phone, template_name, context on public.wa_outbox
  for each row execute function public.wa_outbox_pin_solo_thomy();
