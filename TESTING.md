# Testing Workflow — BotWA-LK

## Setup Local

### 1. Requisitos
- Node.js 18+
- Deno (para Edge Functions)
- ngrok (webhook testing)
- Cuenta Supabase con acceso a PaginaLK

### 2. Clonar repo + deps
```bash
git clone https://github.com/loekemeyer/GestOpClientes.git
cd GestOpClientes
npm install
```

### 3. Supabase local (opcional pero recomendado)
```bash
npm install -g supabase
supabase start
```

O conectar directamente al proyecto remoto (`kwkclwhmoygunqmlegrg`).

---

## Testear Localmente (sin Meta)

### Opción A: Via `lk_chat-test` function

Edge Function dedicada para testing. Devuelve JSON sin enviar por WhatsApp.

#### Setup
```bash
# Copiar env.local si no existe
cp .env.local.example .env.local

# Agregar ANTHROPIC_API_KEY (required para IA)
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env.local
```

#### Iniciar servidor local
```bash
supabase functions serve lk_chat-test --env-file .env.local
# Escucha en http://localhost:54321/functions/v1/lk_chat-test
```

#### Test FAQ (sin IA, 0 tokens)
```bash
curl -X POST http://localhost:54321/functions/v1/lk_chat-test \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "1166574113",
    "text": "¿Cuando llega mi factura?",
    "noAI": true
  }'
```

**Response esperada:**
```json
{
  "reply": "La factura se envía por mail el día que sale tu pedido (revisá la carpeta de spam)...",
  "customer": "Mi Cliente SRL",
  "faqHit": true
}
```

#### Test con IA
```bash
curl -X POST http://localhost:54321/functions/v1/lk_chat-test \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "1166574113",
    "text": "3 cajas de cuchillo asado rojo",
    "skipRateLimit": true
  }'
```

**Response esperada:**
```json
{
  "reply": "[Respuesta conversacional sobre el pedido]",
  "customer": "Mi Cliente SRL"
}
```

---

## Testing con Meta Webhook (staging)

### 1. Exponer servidor local
```bash
# Terminal 1: Supabase functions
supabase functions serve lk_whatsapp-webhook --env-file .env.local

# Terminal 2: ngrok
ngrok http 54321
# Copia URL: https://abc123.ngrok.io
```

### 2. Configurar webhook en Meta
- Ve a [Meta App Dashboard](https://developers.facebook.com/apps)
- WhatsApp → Configuration
- Webhook URL: `https://abc123.ngrok.io/functions/v1/lk_whatsapp-webhook`
- Verify Token: `test-token-12345` (agregar a `.env.local` como `WEBHOOK_VERIFY_TOKEN`)

### 3. Testear con número de prueba Meta
Meta proporciona números de test. Envía SMS desde un número real a tu número de test de Meta.

```
Cliente: ¿Cuando llega mi pedido?
Bot: [Respuesta FAQ #1]

Cliente: Quiero factura
Bot: La factura se envía por mail...
```

---

## Casos de Test — FAQs Principales

| ID | Pregunta (keywords) | Respuesta esperada | Type |
|----|--------------------|--------------------|------|
| 10 | `factura`, `no llegó factura` | "La factura se envía por mail..." | AUTO |
| 15 | `pago`, `transferencia`, `cbu`, `banco` | "Nuestros medios de pago..." | AUTO |
| 21 | `minimo`, `mínimo compra`, `monto` | "$500k delivery, $300k retiro" | AUTO |
| 11 | `precio`, `precios`, `lista` | "Podés cotizar en la web..." | AUTO |
| 1 | `cuando llega`, `entrega`, `seguimiento` | "[Fecha programada del pedido]" | SEMI |

### Script automatizado de tests
```bash
#!/bin/bash
# tests/faq-tests.sh

BASE_URL="http://localhost:54321/functions/v1/lk_chat-test"
PHONE="1166574113"

test_faq() {
  local id=$1
  local query=$2
  echo "Testing FAQ #$id: $query"
  curl -s -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -d "{\"phone\":\"$PHONE\",\"text\":\"$query\",\"noAI\":true}" | jq '.reply'
  echo ""
}

# Run tests
test_faq 10 "¿Donde está mi factura?"
test_faq 15 "¿Como pago?"
test_faq 21 "¿Cual es el mínimo de compra?"
test_faq 11 "¿Cuales son los precios?"
test_faq 1 "¿Cuando llega mi pedido?"
```

Ejecutar:
```bash
chmod +x tests/faq-tests.sh
./tests/faq-tests.sh
```

---

## Checklist Pre-deployment

- [ ] Todos los FAQs en dashboard actualizados
- [ ] `matchFAQ()` testa OK localmente (sin IA)
- [ ] Intent detection (Haiku) clasificar correctamente
- [ ] Conversational replies (Sonnet) coherentes
- [ ] Rate limit enabled/disabled como se espera
- [ ] Tokens usage logged correctamente en `bot_token_usage`
- [ ] Webhooks llegan sin errores 200
- [ ] No hay hardcoded secrets en logs

---

## Debugging

### Logs en Edge Function
```bash
# Ver logs en vivo
supabase functions list
supabase functions get-logs lk_whatsapp-webhook
```

### Logs en Supabase remote
```sql
-- Ver últimos mensajes procesados
SELECT phone, direction, body, intent, created_at
FROM wa_conversations
ORDER BY created_at DESC
LIMIT 20;

-- Ver token usage
SELECT model, input_tokens, output_tokens, estimated_cost_usd, created_at
FROM bot_token_usage
ORDER BY created_at DESC
LIMIT 10;

-- Ver FAQs que matchearon
SELECT phone, direction, body, intent
FROM wa_conversations
WHERE intent LIKE 'faq_%'
ORDER BY created_at DESC
LIMIT 20;
```

### Errores comunes
| Error | Causa | Fix |
|-------|-------|-----|
| `ANTHROPIC_API_KEY not configured` | Falta en env | `echo "ANTHROPIC_API_KEY=..." >> .env.local` |
| `Phone format invalid` | Formato no canónico | Debe ser: `1166574113` (sin +, sin 54 9) |
| `Customer not found` | Vinculación faltante | Crear lead o vincular manualmente en BD |
| `webhook 403` | ngrok URL expirada | Regenerar con `ngrok http 54321` |

---

## Flujo Final: Testing → Deployment

1. **Local**: Testear FAQs sin IA (`noAI: true`)
2. **Staging**: Con Meta + ngrok (20-30 tests)
3. **Production**: Aplicar cambios a webhook en vivo
4. **Monitor**: Ver logs en `wa_conversations` y `bot_token_usage`

**Tiempo estimado**: 30 minutos (sin IA) → 1 hora (con IA)
