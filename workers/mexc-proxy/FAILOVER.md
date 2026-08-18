# Cloudflare ring failover (N free accounts)

Free plan: **1000 KV writes/day per account**. Invocations (~100k) are not the usual limiter.
Each extra account adds another 1000 writes. The active worker runs until its quota is gone,
then activates the next URL in `FAILOVER_RING`. If every peer is exhausted or unreachable,
the current node stays up on Cache (`kv_quota_last_alive`) so the bot does not go mute.

```
A (index 0, preferred) → B → C → D → E → A …
```

Lowest index with remaining quota is preferred. Index 0 reclaims at 00:00 UTC only if it still has quota.

## Live nodes

| | Worker | Account |
|---|---|---|
| **A primary** | `https://mexc-proxy.sergiodecaux.workers.dev` | `b64dba72…` |
| **B standby** | `https://mexc-proxy-b.mexc-standby.workers.dev` | `e3a84d77…` |
| **C standby** | `https://mexc-proxy-c.mexc-c.workers.dev` | `c256c823…` |
| **D standby** | `https://mexc-proxy-d.mexc-d.workers.dev` | `7a55891f…` |
| **E standby** | `https://mexc-proxy-e.mexc-e.workers.dev` | `d0557787…` |

Same `FAILOVER_SECRET` and Telegram tokens on every node. Five accounts ≈ **5000 KV writes/day**.

## Vars (all workers, same RING)

```
FAILOVER_RING=https://mexc-proxy.sergiodecaux.workers.dev,https://mexc-proxy-b.mexc-standby.workers.dev,https://mexc-proxy-c.mexc-c.workers.dev,https://mexc-proxy-d.mexc-d.workers.dev,https://mexc-proxy-e.mexc-e.workers.dev
PUBLIC_BASE_URL=https://<this-worker>
FAILOVER_ROLE=primary|standby
FAILOVER_PEER_URL=https://<legacy next>   # fallback if RING is empty
FAILOVER_DAILY_BUDGET=80000
```

To add **F**: new CF account, copy `wrangler.standby4.toml` → `wrangler.standby5.toml`, append URL to `FAILOVER_RING` on every worker, redeploy all.

## Add account F (or G, …)

1. New Cloudflare account, Workers enabled (free).
2. API token: template **Edit Cloudflare Workers**, No expiration.
3. Copy `wrangler.standby4.toml` → `wrangler.standby5.toml`, fill `account_id` + KV id, append the new URL to `FAILOVER_RING` on **every** worker, redeploy all.

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
