# Dual Cloudflare failover (2 accounts → 2 Workers)

## Idea
- **Account A / `mexc-proxy`** = primary (active)
- **Account B / `mexc-proxy-b`** = standby (idle cron)
- When A hits Free **KV 1000 writes/day** (or ~80k invocations), it calls B `/telegram/failover/activate`
- B becomes active, copies subscribers + journal/paper, switches Telegram webhooks, sends TG notice
- A goes idle until **00:00 UTC** (A's KV quota resets), then reclaim
- Subrequest-limit (50/tick) stays on A — next cron is a fresh 50; that is not a reason to switch accounts

## Setup Account B
1. New Cloudflare account + Workers enabled  
2. In `workers/mexc-proxy`:
   ```bash
   npx wrangler kv namespace create SUBSCRIBERS
   # paste id into wrangler.standby.toml
   npx wrangler deploy -c wrangler.standby.toml
   ```
3. Secrets on **both** workers (same TG tokens):
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_SNIPER_BOT_TOKEN
   npx wrangler secret put ALERT_SECRET
   npx wrangler secret put FAILOVER_SECRET   # same random string on A and B
   ```
4. Vars (already set in toml after first standby deploy):
   - **Primary** `https://mexc-proxy.sergiodecaux.workers.dev`
     - `FAILOVER_ROLE=primary`
     - `FAILOVER_PEER_URL=https://mexc-proxy-b.mexc-standby.workers.dev`
     - `PUBLIC_BASE_URL=https://mexc-proxy.sergiodecaux.workers.dev`
   - **Standby** `https://mexc-proxy-b.mexc-standby.workers.dev`
     - `FAILOVER_ROLE=standby`
     - `FAILOVER_PEER_URL=https://mexc-proxy.sergiodecaux.workers.dev`
     - `PUBLIC_BASE_URL=https://mexc-proxy-b.mexc-standby.workers.dev`

## Manual switch
```bash
# Activate standby now
curl -X POST "https://mexc-proxy-b.mexc-standby.workers.dev/telegram/failover/activate" \
  -H "X-Failover-Secret: YOUR_SECRET"

# Force primary → peer handoff
curl -X POST "https://mexc-proxy.sergiodecaux.workers.dev/telegram/failover/handoff" \
  -H "X-Failover-Secret: YOUR_SECRET"

# Status
curl "https://mexc-proxy.sergiodecaux.workers.dev/telegram/failover/status"
curl "https://mexc-proxy-b.mexc-standby.workers.dev/telegram/failover/status"
```

## Notes
- Journals/KV are **per account**. Handoff copies **subscribers + journal/paper/gates/watchlist** so B can keep trading.
- Standby must have the **same** bot tokens or webhook switch is useless.
- Free plan still has **50 subrequests/invocation** on each account.
- Handoff after KV/daily-limit is **deferred to the next cron** if this tick already burned subrequests.
- Standby must **not** yield to primary while `kvQuotaExhausted` / `kvQuotaHandoff` is set on A.
