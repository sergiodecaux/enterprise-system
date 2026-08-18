# Cloudflare ring failover (N free accounts)

Free plan: **1000 KV writes/day per account**. Invocations (~100k) are not the usual limiter.
Each extra account adds another 1000 writes. The active worker runs until its quota is gone,
then activates the next URL in `FAILOVER_RING`. If every peer is exhausted or unreachable,
the current node stays up on Cache (`kv_quota_last_alive`) so the bot does not go mute.

```
A (index 0, preferred) → B → C → A …
```

Lowest index with remaining quota is preferred. Index 0 reclaims at 00:00 UTC only if it still has quota.

## Live nodes

| | Worker | Account |
|---|---|---|
| **A primary** | `https://mexc-proxy.sergiodecaux.workers.dev` | `b64dba72…` |
| **B standby** | `https://mexc-proxy-b.mexc-standby.workers.dev` | `e3a84d77…` |
| **C** | template `wrangler.standby2.toml` | create new CF account |

Same `FAILOVER_SECRET` and Telegram tokens on every node.

## Vars (all workers, same RING)

```
FAILOVER_RING=https://mexc-proxy.sergiodecaux.workers.dev,https://mexc-proxy-b.mexc-standby.workers.dev
PUBLIC_BASE_URL=https://<this-worker>
FAILOVER_ROLE=primary|standby
FAILOVER_PEER_URL=https://<legacy next>   # fallback if RING is empty
FAILOVER_DAILY_BUDGET=80000
```

When C is live, append its URL to `FAILOVER_RING` on **every** worker and redeploy A+B+C.

## Add account C (or D, E, …)

1. New Cloudflare account, Workers enabled (free).
2. API token: Workers Scripts Edit + KV Edit + Account settings Read.
3. From `workers/mexc-proxy`:

```powershell
$env:CLOUDFLARE_API_TOKEN = "<token C>"
$env:CLOUDFLARE_ACCOUNT_ID = "<account C>"
npx wrangler kv namespace create SUBSCRIBERS
```

4. Paste `account_id` and KV `id` into `wrangler.standby2.toml`. Replace `REPLACE_SUBDOMAIN` after the first deploy (Workers.dev URL is printed by wrangler).
5. Deploy and put the **same** secrets as A/B:

```powershell
npx wrangler deploy -c wrangler.standby2.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN -c wrangler.standby2.toml
npx wrangler secret put TELEGRAM_SNIPER_BOT_TOKEN -c wrangler.standby2.toml
npx wrangler secret put ALERT_SECRET -c wrangler.standby2.toml
npx wrangler secret put FAILOVER_SECRET -c wrangler.standby2.toml
```

6. Set `FAILOVER_RING` on A, B, and C to the three URLs (same order). Redeploy all.

A third account ≈ 3000 KV writes/day (~3× runtime before Cache-only last-alive).

## Behaviour

- Any **active** node can hand off (not only primary). Next hop with remaining quota wins; wrap-around is allowed (B→C→A).
- Per-URL dead cooldown is **2 minutes** (one dead hop does not hide the rest).
- Activate idles **all other** ring members so only one owner holds Telegram webhooks.
- KV probe runs on **every** role (not only primary).
- Subrequest-limit (50/tick) stays on the current node — next cron is a fresh 50; that is not a reason to switch accounts.
- Handoff copies **subscribers + journal/paper/gates/watchlist** into the peer’s own KV.

## Status / manual switch

```bash
curl "https://mexc-proxy.sergiodecaux.workers.dev/telegram/failover/status"
curl "https://mexc-proxy-b.mexc-standby.workers.dev/telegram/failover/status"

# Activate a node now
curl -X POST "https://mexc-proxy-b.mexc-standby.workers.dev/telegram/failover/activate" \
  -H "X-Failover-Secret: YOUR_SECRET"

# Force this node → next hop
curl -X POST "https://mexc-proxy.sergiodecaux.workers.dev/telegram/failover/handoff" \
  -H "X-Failover-Secret: YOUR_SECRET"
```

Status JSON includes `ring`, `ringIndex`, `kvQuotaExhausted`, `kvQuotaHandoff`.
