-- 137 — Ficha de memoria por cliente (Pablo Olejavetzky, 09/10/2026).
-- Pablo: "para que se nutra de la memoria tiene que registrarse el input inicial (los meses de charla con todos los clientes que
-- subí) y el incremental". El inicial está en "Wpp_Historial_Clientes" (27.348 mensajes, 06/2025 → 06/2026, 664 clientes) y hasta
-- hoy no lo leía nadie. La IA lo resume UNA vez por cliente en una ficha corta (lk_memoria-cliente) y el agente lee la ficha, no
-- los 700 mensajes. Lo incremental (charlas nuevas del bot) se suma a la ficha más adelante.
--
-- Clave (marca, cod_cli): el código de Chef y el de LK se pisan (CH 1926 y LK 1926 son clientes distintos), así que nunca por
-- código solo. estado: 'prueba' (la primera tanda, para que Pablo la revise), 'aprobada' (la puede leer el agente) o 'descartada'.
-- El agente todavía NO la lee: eso es otro cambio, después de aprobar las fichas.

create table if not exists public.wa_memoria_cliente (
  marca              text not null check (marca in ('LK', 'CH')),
  cod_cli            integer not null,
  ficha              text not null,
  mensajes           integer not null default 0,   -- mensajes del historial que se leyeron
  desde              timestamptz,
  hasta              timestamptz,
  charlas_excluidas  integer not null default 0,   -- charlas compartidas con otro cliente: no se leen (no mezclar empresas)
  modelo             text,
  input_tokens       integer,
  output_tokens      integer,
  costo_usd          numeric(10, 6),
  estado             text not null default 'prueba' check (estado in ('prueba', 'aprobada', 'descartada')),
  generada_en        timestamptz not null default now(),
  primary key (marca, cod_cli)
);
alter table public.wa_memoria_cliente enable row level security;  -- sin políticas: sólo service_role
revoke all on table public.wa_memoria_cliente from anon, authenticated;

-- Rollback:
--   drop table if exists public.wa_memoria_cliente;
