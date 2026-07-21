# MEXC Proxy + Telegram Alerts Worker

Transparent proxy for public MEXC futures market data + Telegram bot that delivers Sniper / Meme signals.

## Deploy proxy (existing)

```bash
cd workers/mexc-proxy
npx wrangler deploy
```

## Telegram bot setup

1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → copy token.

2. Create KV namespace:

```bash
npx wrangler kv:namespace create SUBSCRIBERS
npx wrangler kv:namespace create SUBSCRIBERS --preview
```

Paste the returned IDs into `wrangler.toml` (`id` / `preview_id`).

3. Set secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ALERT_SECRET
```

`ALERT_SECRET` — любой длинный пароль; тот же значение в `.env` фронта как `VITE_ALERT_SECRET`.

4. Deploy and set webhook:

```bash
npx wrangler deploy

# Replace TOKEN and WORKER_URL
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<WORKER_URL>/telegram/webhook"
```

5. Frontend `.env`:

```
VITE_MEXC_PROXY_URL=https://<WORKER_URL>
VITE_ALERT_SECRET=<same as ALERT_SECRET>
VITE_TELEGRAM_BOT_USERNAME=YourBotUsername
```

6. Open the bot in Telegram → `/start`.  
   Or open the Mini App — it auto-subscribes your Telegram user id.

## Bot commands

| Command | Action |
|---------|--------|
| `/start` | Subscribe |
| `/stop` | Unsubscribe |
| `/status` | Preferences |
| `/sniper_on` `/sniper_off` | Toggle sniper alerts |
| `/meme_on` `/meme_off` | Toggle meme alerts |

## API

- `POST /telegram/subscribe` `{ chatId, sniper?, meme? }`
- `POST /telegram/alert` + header `X-Alert-Secret` — broadcast signal
- `GET /telegram/health`
