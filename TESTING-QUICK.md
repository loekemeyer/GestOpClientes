# Testing Rápido — 5 minutos

## 1. Setup
```bash
cp .env.local.example .env.local
# Editar .env.local → agregar ANTHROPIC_API_KEY
```

## 2. Iniciar servidor
```bash
npm run dev:test
# Escucha en: http://localhost:54321/functions/v1/lk_chat-test
```

## 3. Test FAQ (sin IA)
```bash
npm run test:faq:local
```

**Output:**
```
🤖 FAQ Testing — BotWA-LK
URL: http://localhost:54321/functions/v1/lk_chat-test
Phone: 1166574113
---
FAQ #10: "¿Donde está mi factura?" ... ✅ PASS
FAQ #10: "no llegó factura" ... ✅ PASS
FAQ #15: "¿Como pago?" ... ✅ PASS
...
📊 Results: 6 passed, 0 failed
🎉 All tests passed!
```

## 4. Test manual con curl (opcional)
```bash
curl -X POST http://localhost:54321/functions/v1/lk_chat-test \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "1166574113",
    "text": "¿Como pago?",
    "noAI": true
  }'
```

**Response esperada:**
```json
{
  "reply": "Nuestros medios de pago:\n\n💵 Efectivo\n🏦 Transferencia bancaria...",
  "customer": "Mi Cliente SRL",
  "faqHit": true
}
```

---

## Casos de test principales

| FAQ | Pregunta | Keyword esperado |
|-----|----------|------------------|
| 10  | "¿factura?" | "factura se envía" |
| 15  | "¿pago?" | "medios de pago" |
| 21  | "¿mínimo?" | "$500" |
| 11  | "¿precio?" | "cotizar" |

---

## Troubleshooting

**Error: `ANTHROPIC_API_KEY not configured`**
```bash
grep ANTHROPIC_API_KEY .env.local
# Si no está → agregarlo
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env.local
```

**Error: `Cannot find phone: 1166574113`**
- Este número es válido en testing (no requiere cliente real)
- Si sale "Customer not found" → es normal sin IA (`noAI: true`)

**Port 54321 en uso**
```bash
lsof -i :54321
kill -9 <PID>
npm run dev:test
```

---

## Próximos pasos

- [ ] Todos los tests pasan localmente
- [ ] Crear .env.local con tus credenciales
- [ ] Testear con cliente real (si tienes números Meta test)
- [ ] Ver TESTING.md para testing con Meta webhook

**Tiempo**: ~5 min ⏱️
