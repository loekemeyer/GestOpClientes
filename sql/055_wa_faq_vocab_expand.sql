-- 055_wa_faq_vocab_expand.sql
-- Expansión exhaustiva del vocabulario de wa_faq a partir de chats reales
-- (bot_historial_chat + wa_conversations, ~860 mensajes de cliente).
-- El matcher (sql/054) ya normaliza acentos y matchea por inicio de palabra;
-- acá agregamos las FRASES reales que la gente escribe para que caigan en la
-- FAQ correcta. Idempotente: cada UPDATE hace dedup (array_agg distinct) →
-- re-correr no duplica keywords.
--
-- Regla: agregamos frases específicas, NO palabras sueltas ambiguas, para no
-- pisar intents vecinos (ej. "mi pedido" va a estado, pero no "un pedido").

-- Helper conceptual: keywords = dedup(keywords || nuevas)

-- ── id=1  estado / entrega de pedido (order_status) ─────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'estado de mi pedido','estado del pedido','estado de pedido','estado pedido',
    'mi pedido','cuando entregan','cuando se entrega','cuando se entregara',
    'cuando me entregan','cuando lo entregan','cuando me lo entregan','cuando lo recibo',
    'cuando recibo mi pedido','entrega de mi pedido','entrega pedido','fecha de envio',
    'fecha estimada de envio','para cuando esta listo mi pedido','cuando esta listo mi pedido',
    'consultar estado','consultar estado de pedido','ver estado del pedido',
    'seguimiento del pedido','ya salio mi pedido','esta despachado','esta programado mi pedido',
    'cuando llega el pedido','cuando sale el pedido','a que hora llega mi pedido',
    'cuanto tarda la entrega','cuanto se tarda la entrega','cuanto demoran en entregar'
  ]::text[]) k
), updated_at = now() where id = 1;

-- ── id=9  estado / demora (order_status, secundaria) ────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'estado de mi pedido','consultar estado de pedido','tarda mi pedido','se demora mi pedido',
    'cuanto falta para que llegue'
  ]::text[]) k
), updated_at = now() where id = 9;

-- ── id=10 factura / comprobante ─────────────────────────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'no la recibi','reenviar factura','reenvien factura','me reenvias la factura',
    'me reenvian la factura','mandame la factura','mandame factura','necesito la factura',
    'pasame factura','pasame la factura','quiero la factura','falta la factura',
    'facturacion del ano','facturacion anual','facturacion de mi cuenta','necesito factura'
  ]::text[]) k
), updated_at = now() where id = 10;

-- ── id=11 lista de precios (full_auto) ──────────────────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'los precios','los precios de los productos','pasame precios','me pasas precios',
    'me pasas la lista','me pasas la lista de precios','me pasas lista de precios',
    'me mandan la lista de precios','me mandas la lista','me manda la lista',
    'lista actualizada','me pasas la lista actualizada','quiero la lista de precios',
    'me podes pasar la lista','lista de chef','lista chef','me pasas la lista de chef',
    'me podrias pasar la lista','me pasarias la lista'
  ]::text[]) k
), updated_at = now() where id = 11;

-- ── id=13 vigencia / aumento de lista ───────────────────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'sigue vigente','esta vigente la lista','lista vigente','la lista sigue vigente',
    'la lista esta vigente','actualizaron la lista','cambiaron los precios','cambiaron la lista',
    'hay aumento','aumentaron','me pasas la lista nueva','lista nueva'
  ]::text[]) k
), updated_at = now() where id = 13;

-- ── id=19 catálogo / novedades ──────────────────────────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'mandame el catalogo','mandame catalogo','pasame el catalogo','pasame catalogo',
    'me pasas el catalogo','me pasas catalogo','podes mandar catalogo','me mandas catalogo',
    'me mandas el catalogo','catalogo de','mandame info','info de productos','ver catalogo'
  ]::text[]) k
), updated_at = now() where id = 19;

-- ── id=21 mínimo de compra ──────────────────────────────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'monto minimo','monto minimo de compra','cual es el minimo','cuanto es el minimo',
    'comprar por unidad','venden por unidad','se puede comprar por unidad','pedido minimo',
    'compra minima','minimo de compra'
  ]::text[]) k
), updated_at = now() where id = 21;

-- ── id=15 formas / medios de pago (full_auto) ───────────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'medios de pago','medio de pago','formas de pago','como puedo pagar','aceptan tarjeta',
    'aceptan mercado pago','mercado pago','con que puedo pagar','que medios de pago tienen'
  ]::text[]) k
), updated_at = now() where id = 15;

-- ── id=42 datos de transferencia (alias/CBU) ────────────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'cuenta para transferir','numero de cuenta','datos para depositar','me pasas la cuenta',
    'me pasarias la cuenta','a que cuenta transfiero','cuenta bancaria','datos de la cuenta',
    'pasame el cbu','pasame cbu','me pasas el cbu','me pasarias el cbu'
  ]::text[]) k
), updated_at = now() where id = 42;

-- ── id=31 zona de envío ─────────────────────────────────────────────────────
update public.wa_faq set keywords = (
  select array_agg(distinct k) from unnest(keywords || array[
    'hacen envios','envian a','llegan a','mandan a','hacen envio a','realizan envios'
  ]::text[]) k
), updated_at = now() where id = 31;

-- ── id=33 contacto con vendedor / derivar a humano ──────────────────────────
-- Estaba en semi_auto con lookup seller_contact NO implementado → servía el
-- bot_response con {{nombre_vendedor}} vacío ("Tu vendedor es ."). Pasa a
-- needs_human (escalación) con copy limpio, y suma el vocabulario real.
update public.wa_faq set
  keywords = (
    select array_agg(distinct k) from unnest(keywords || array[
      'derivame','derivar','derivame con alguien','derivame a un humano','humano',
      'con un humano','pasame con un humano','una persona','persona real','asesor',
      'hablar con alguien','pasame con alguien','atencion humana','hablar con una persona',
      'quiero hablar con una persona','me pasas con un vendedor','necesito un humano'
    ]::text[]) k
  ),
  automation_level = 'needs_human',
  requires_db_lookup = false,
  db_lookup_type = null,
  bot_response = 'Te derivo con un asesor para que se comunique con vos a la brevedad. También podés escribir a ventas@loekemeyer.com o llamar al 1131181021.',
  updated_at = now()
where id = 33;

-- ── id=7 acceso web: usuario / clave / contraseña ───────────────────────────
-- Intent frecuente en los chats y SIN handler (estaba inactiva y con copy de
-- medios de pago por error). Reactivar como needs_human (recuperar credenciales
-- lo resuelve una persona), con keywords correctos y copy limpio.
update public.wa_faq set
  is_active = true,
  automation_level = 'needs_human',
  requires_db_lookup = false,
  db_lookup_type = null,
  keywords = array[
    'usuario','clave','contrasena','mi usuario','mi clave','usuario y clave',
    'usuario y contrasena','usuario y contrasena para hacer un pedido','olvide mi contrasena',
    'olvide mi clave','olvide la clave','olvide la contrasena','recuperar clave',
    'recuperar contrasena','acceso a la pagina','acceso web','ingresar a la web',
    'no puedo entrar a la web','datos de acceso','clave de la pagina','usuario de la pagina',
    'me olvide la clave','no me acuerdo la clave','password'
  ]::text[],
  bot_response = 'Para recuperar tu *usuario o clave* de la web te va a contactar un asesor a la brevedad. También podés escribir a ventas@loekemeyer.com.',
  institutional_response = null,
  updated_at = now()
where id = 7;
