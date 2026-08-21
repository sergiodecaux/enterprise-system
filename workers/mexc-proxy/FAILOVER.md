# Cloudflare ring failover (N free accounts)

Free plan: **1000 KV writes/day per account**. Invocations (~100k) are not the usual limiter.
Each extra account adds another 1000 writes. The active worker runs until its quota is gone,
then activates the next URL in `FAILOVER_RING`. If every peer is exhausted or unreachable,
the current node stays up on Cache (`kv_quota_last_alive`) so the bot does not go mute.

```
A (index 0, preferred) → B → C → A …
```

**F (`mexc-proxy-f`) is not in this ring.** It is the dedicated Elite / alts worker.

Lowest index with remaining quota is preferred. Index 0 reclaims at 00:00 UTC only if it still has quota.

## Live nodes

| | Worker | Account |
|---|---|---|
| **A primary** | `https://mexc-proxy.sergiodecaux.workers.dev` | `b64dba72…` |
| **B standby** | `https://mexc-proxy-b.mexc-standby.workers.dev` | `e3a84d77…` |
| **C standby** | `https://mexc-proxy-c.mexc-c.workers.dev` | `c256c823…` |
| D/E reserved | excluded until valid deploy credentials are verified | not in active ring |
| **F Elite** | `https://mexc-proxy-f.mexc-f.workers.dev` | `f25b2e34…` · **alts only, not in meme RING** |

Active meme ring A–C ≈ **3000 KV writes/day**. Elite F has its own 1000 writes for alts.

## Vars (all workers, same RING)

```
FAILOVER_RING=https://mexc-proxy.sergiodecaux.workers.dev,https://mexc-proxy-b.mexc-standby.workers.dev,https://mexc-proxy-c.mexc-c.workers.dev
ELITE_PUBLIC_URL=https://mexc-proxy-f.mexc-f.workers.dev
PUBLIC_BASE_URL=https://<this-worker>
FAILOVER_ROLE=primary|standby
FAILOVER_PEER_URL=https://<legacy next>   # fallback if RING is empty
FAILOVER_DAILY_BUDGET=80000
```

To add another meme node: verify its API token and deployment first, append its URL to `FAILOVER_RING` on every meme worker, then redeploy the complete ring.

## Add another meme account

1. New Cloudflare account, Workers enabled (free).
2. API token: template **Edit Cloudflare Workers**, No expiration.
3. Copy a meme standby config, fill `account_id` + KV id, append the new URL to `FAILOVER_RING` on **every meme worker**, redeploy all, and verify `/telegram/failover/status`.

## Behaviour

- Any **active** node can hand off (not only primary). Next hop with remaining quota wins; wrap-around is allowed (B→C→A).
- If the owner is quota-dead but still `active:true`, the next node **self-heals and takes over** instead of waiting for a handoff POST.
- A peer over its daily budget or with a predator scan stuck/stale for 12 minutes is not a healthy owner; the next node takes over.
- Peer status probes use `?shallow=1` so status checks do not recursively ping the whole ring.
- If handoff was marked done but the peer never ran, the current node stays up on Cache (`kv_quota_last_alive`).
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

Status JSON includes `ring`, `ringIndex`, quota/budget counters, and predator scan freshness.
