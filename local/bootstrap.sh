#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Sandbox local del bot — para "tocar sin miedo a romper". NUNCA toca producción.
# Carga, sobre una base de prueba, tres capas self-contained:
#   01  camino FAQ (0 IA):  wa_faq + matcher wa_faq_match       (fiel a sql/007 + sql/054)
#   02  capa agente MOCK:   identidad + historial + tools        (firmas reales, datos sembrados)
#   03  capa de trace:      bot_trace + bot_trace_log            (observabilidad, base del proyecto)
# El seed real de FAQs se EXTRAE de sql/007 en runtime (no se duplica).
#
# Uso:
#   ./local/bootstrap.sh                 # postgres:16 descartable en Docker (puerto 55432)
#   ./local/bootstrap.sh "<DB_URL>"      # aplica sobre esa base (ej. Supabase local:
#                                        #   postgresql://postgres:postgres@127.0.0.1:54322/postgres)
# Requisitos: Docker (modo descartable) o psql (modo DB_URL).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEED_SRC="$ROOT/sql/007_wa_faq.sql"
SEED_TMP="$(mktemp)"
trap 'rm -f "$SEED_TMP"' EXIT
sed -n '73,482p' "$SEED_SRC" > "$SEED_TMP"   # el INSERT real; sql/007 sigue siendo la fuente

SCHEMAS=("$ROOT/local/01-faq-schema.sql" "$ROOT/local/02-agent-mocks.sql" "$ROOT/local/03-trace.sql")

SMOKE_SQL="
\\echo '── FAQ (0 IA) ──'
select t.q as pregunta, m.category, m.automation_level as nivel, round(m.match_score,3) as score,
       case when m.match_score >= 1 then 'MATCH' else 'sin match (->IA)' end as resultado
from (values ('¿Como pago?'),('cuál es el mínimo de compra'),('no me llegó la factura'),
             ('quiero hacer un pedido'),('asdfqwer zzz')) t(q)
left join lateral (select * from wa_faq_match(t.q) order by match_score desc limit 1) m on true
order by score desc nulls last;
\\echo '── Agente: identidad + tools (datos sembrados) ──'
select cod_cliente, customer_name, source from wa_identify_customer('1166574113');
select order_id, total, payment_method from bot_mis_pedidos('1166574113', 5);
select np_number, status, fecha_entrega from bot_mi_entrega('1166574113');
\\echo '── Historial (guardar + leer) ──'
select bot_guardar_mensaje('1166574113','user','hola, cuando llega mi pedido');
select bot_guardar_mensaje('1166574113','assistant','tu pedido LK 1001 está programado');
select rol, contenido from bot_leer_historial('1166574113', 10);
\\echo '── Trace: un registro por mensaje ──'
select bot_trace_log('{\"phone\":\"1166574113\",\"source\":\"lk_chat-test\",\"message_in\":\"cuando llega mi pedido\",\"gate\":\"agente\",\"model\":\"gemini-3.5-flash-lite\",\"iterations\":2,\"tool_calls\":[{\"name\":\"consultar_mi_entrega\",\"ok\":true,\"ms\":40}],\"tokens_in\":512,\"tokens_out\":88,\"cost_usd\":0,\"latency_ms\":1800,\"outcome\":\"ok\"}'::jsonb) as trace_id;
select id, gate, model, iterations, outcome from bot_trace order by id desc limit 1;
"

apply() { # $1 = runner prefix reading stdin
  for f in "${SCHEMAS[@]}"; do $1 < "$f"; done
  $1 < "$SEED_TMP"
}

if [ "${1:-}" != "" ]; then
  DB_URL="$1"
  echo "→ aplicando sobre: $DB_URL"
  apply "psql $DB_URL -q -v ON_ERROR_STOP=1 -f -"
  echo "→ smoke test:"; psql "$DB_URL" -P pager=off -f - <<< "$SMOKE_SQL"
else
  echo "→ Postgres descartable en Docker (contenedor: bot-sandbox, puerto 55432)"
  docker rm -f bot-sandbox >/dev/null 2>&1 || true
  docker run -d --name bot-sandbox -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16 >/dev/null
  echo -n "   esperando postgres"
  for i in $(seq 1 40); do
    [ "$(docker logs bot-sandbox 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
    echo -n "."; sleep 1
  done; echo " listo"
  apply "docker exec -i bot-sandbox psql -U postgres -q -v ON_ERROR_STOP=1"
  echo "→ smoke test:"; docker exec -i bot-sandbox psql -U postgres -P pager=off <<< "$SMOKE_SQL"
  echo "   (conexión: postgresql://postgres:pw@127.0.0.1:55432/postgres · borrar: docker rm -f bot-sandbox)"
fi
echo "✅ Sandbox lista (FAQ + agente mock + trace)."
