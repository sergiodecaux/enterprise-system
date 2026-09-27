# AI advisor worker

Личный AI-советник приложения. Один код — деплоится на несколько бесплатных аккаунтов Cloudflare
(у каждого свои 10 000 neurons Workers AI в сутки). Клиент перебирает узлы по списку
`VITE_ADVISOR_URLS` и пропускает узел до 00:00 UTC, если тот ответил «лимит исчерпан».

- Модель: `@cf/google/gemma-4-26b-a4b-it`, запасная — `@cf/zai-org/glm-4.7-flash` (Workers AI, без внешних ключей).
- Один ответ ≈ 30–45 neurons → примерно 250 ответов в сутки на аккаунт (`DAILY_CAP = 250`).
- Доступ: личный токен `ADVISOR_TOKEN` (секрет воркера; в приложении вводится в настройках советника
  и хранится только в localStorage). Опционально — вход из Telegram Mini App по `initData`.

## API

| Метод | Путь | Описание |
|---|---|---|
| GET | `/health` | состояние узла без авторизации: `configured`, `models`, `used/cap`, `exhausted` |
| POST | `/chat` | `{ messages, snapshot, mode }` → SSE: `event: meta` → `data: {"d": "..."}` → `event: done` |

Ошибки до начала стрима — JSON: `401` (токен), `429 {exhausted:true, resetAt}` (дневной лимит узла),
`429 {exhausted:false}` (слишком часто), `502` (обе модели недоступны).

## Деплой

Аккаунты заданы в `wrangler.toml` как окружения `a`, `b`, `c`, `f` (сейчас это аккаунты кольца
mexc-proxy; ai-advisor там отдельный воркер и mexc-proxy не трогает). Если под советника
отдельные аккаунты — замените `account_id` в соответствующих `[env.X]`.

1. Один раз в этой папке: `npm install` (кэш npm уже перенесён на `D:\npm-cache`).
2. Авторизация — один из вариантов:
   - `npx wrangler login` (браузер) — подходит, если все аккаунты доступны из одного логина;
   - либо API-токен на каждый аккаунт (шаблон **Edit Cloudflare Workers**) в переменных
     `CF_TOKEN_A`, `CF_TOKEN_B`, `CF_TOKEN_C`, `CF_TOKEN_F`.
3. Придумайте длинный токен доступа (например, `[guid]::NewGuid()` в PowerShell) и задеплойте все узлы:

   ```powershell
   $env:ADVISOR_TOKEN = "<ваш-токен>"      # запишется секретом на каждый узел
   $env:CF_TOKEN_A = "<api-token-A>"        # если без wrangler login
   npm run deploy:all                        # или: ... -File scripts/deploy-all.ps1 -Envs a,b
   ```

   Вручную для одного узла:

   ```powershell
   npx wrangler deploy --env a
   npx wrangler secret put ADVISOR_TOKEN --env a
   ```

4. Проверьте каждый узел: `https://ai-advisor.<subdomain>.workers.dev/health` →
   `"configured": true`. Поддомены аккаунтов кольца: `sergiodecaux`, `mexc-standby`, `mexc-c`, `mexc-f`.

## Подключение в приложении

1. В корневом `.env` (и в секретах GitHub Actions для Pages) задайте список узлов:

   ```
   VITE_ADVISOR_URLS=https://ai-advisor.sergiodecaux.workers.dev,https://ai-advisor.mexc-standby.workers.dev,https://ai-advisor.mexc-c.workers.dev,https://ai-advisor.mexc-f.workers.dev
   ```

   Список не секретный. Его можно не пересобирать: те же URL вводятся в настройках советника.
2. В приложении: кнопка с роботом → шестерёнка → вставить `ADVISOR_TOKEN` → «Проверить» → «Сохранить».

## Опционально: вход из Telegram без токена

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN --env a   # токен бота, через которого открывается Mini App
```

и в `wrangler.toml` для окружения укажите `ALLOWED_TG_IDS = "<ваш Telegram user id>"`.

## Разработка

```powershell
npm run typecheck      # tsc по воркеру
npm run dev            # wrangler dev --remote --env a (Workers AI локально не работает)
```

Добавить другого провайдера (например, GigaChat): новый адаптер в `src/providers/`, реализующий
`ChatProvider`, и включить его в `providerChain()` в `src/providers/index.ts`.
