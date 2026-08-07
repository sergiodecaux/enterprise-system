/**
 * PEAK entry TG queue — survives CF «Too many subrequests» on predator ticks.
 * Predator enqueues on send failure; paper cron flushes with a fresh subrequest budget.
 */

export interface PendingMemeAlert {
  title: string
  text: string
  dedupeKey: string
  enqueuedAt: number
}

interface EnvLike {
  SUBSCRIBERS?: KVNamespace
}

const KV_KEY = 'telegram:pending_meme_alerts'
const MAX_PENDING = 24
const TTL_MS = 45 * 60_000

function cacheReq(): Request {
  return new Request('https://enterprise-system-runtime.invalid/pending-meme-tg')
}

async function readList(env: EnvLike): Promise<PendingMemeAlert[]> {
  // Always merge KV + Cache — Cache-only read left pending alerts stuck
  // when predator wrote KV on another isolate and paper saw empty cache.
  let fromKv: PendingMemeAlert[] = []
  let fromCache: PendingMemeAlert[] = []
  try {
    const raw = await env.SUBSCRIBERS?.get(KV_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as PendingMemeAlert[]
      if (Array.isArray(parsed)) fromKv = parsed
    }
  } catch {
    /* ignore */
  }
  try {
    const hit = await caches.default.match(cacheReq())
    if (hit) {
      const parsed = (await hit.json()) as PendingMemeAlert[]
      if (Array.isArray(parsed)) fromCache = parsed
    }
  } catch {
    /* ignore */
  }
  const byKey = new Map<string, PendingMemeAlert>()
  for (const x of [...fromCache, ...fromKv]) {
    if (!x?.dedupeKey) continue
    const prev = byKey.get(x.dedupeKey)
    if (!prev || (x.enqueuedAt ?? 0) >= (prev.enqueuedAt ?? 0)) {
      byKey.set(x.dedupeKey, x)
    }
  }
  return [...byKey.values()].sort(
    (a, b) => (b.enqueuedAt ?? 0) - (a.enqueuedAt ?? 0)
  )
}

async function writeList(env: EnvLike, list: PendingMemeAlert[]): Promise<void> {
  const trimmed = list.slice(0, MAX_PENDING)
  const body = JSON.stringify(trimmed)
  try {
    await caches.default.put(
      cacheReq(),
      new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      })
    )
  } catch {
    // ignore
  }
  try {
    await env.SUBSCRIBERS?.put(KV_KEY, body)
  } catch {
    // ignore
  }
}

function prune(list: PendingMemeAlert[], now = Date.now()): PendingMemeAlert[] {
  return list.filter((x) => now - x.enqueuedAt < TTL_MS)
}

/** Queue an entry that failed (or was deferred) so paper cron can deliver it. */
export async function enqueuePendingMeme(
  env: EnvLike,
  alert: Omit<PendingMemeAlert, 'enqueuedAt'>
): Promise<void> {
  const list = prune(await readList(env))
  if (list.some((x) => x.dedupeKey === alert.dedupeKey)) {
    await writeList(env, list)
    return
  }
  list.unshift({ ...alert, enqueuedAt: Date.now() })
  await writeList(env, list)
}

export async function flushPendingMemeAlerts(
  env: EnvLike,
  send: (a: PendingMemeAlert) => Promise<{ sent: number; failed: number; skipped?: string }>,
  limit = 5
): Promise<{ flushed: number; left: number }> {
  let list = prune(await readList(env))
  if (!list.length) return { flushed: 0, left: 0 }

  let flushed = 0
  const keep: PendingMemeAlert[] = []
  for (const item of list) {
    if (flushed >= limit) {
      keep.push(item)
      continue
    }
    try {
      const r = await send(item)
      if (r.sent > 0 || r.skipped === 'dedup') {
        flushed++
        continue
      }
      // Keep for retry unless permanent skip
      if (r.skipped === 'no_subscribers') continue
      keep.push(item)
    } catch {
      keep.push(item)
    }
  }
  await writeList(env, keep)
  return { flushed, left: keep.length }
}

export async function pendingMemeCount(env: EnvLike): Promise<number> {
  return prune(await readList(env)).length
}
