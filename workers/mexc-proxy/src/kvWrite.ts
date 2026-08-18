/**
 * Free-plan KV budget: 1000 writes/day.
 * Always prefer Cache for hot state; checkpoint KV on a throttle.
 */

const memStamp = new Map<string, number>()

function stampReq(key: string): Request {
  return new Request(
    `https://enterprise-system-runtime.invalid/kv-throttle/${encodeURIComponent(key)}`
  )
}

async function readStamp(key: string): Promise<number> {
  const mem = memStamp.get(key)
  if (mem != null) return mem
  try {
    const res = await caches.default.match(stampReq(key))
    if (!res) return 0
    const n = Number(await res.text())
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

async function writeStamp(key: string, at: number): Promise<void> {
  memStamp.set(key, at)
  try {
    await caches.default.put(
      stampReq(key),
      new Response(String(at), {
        headers: {
          'Cache-Control': 'public, max-age=86400',
        },
      })
    )
  } catch {
    /* memory only */
  }
}

export type KvPutResult = 'written' | 'skipped' | 'failed' | 'no_kv'

function dayKeyUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

function quotaReq(kind: 'exhausted' | 'handoff'): Request {
  return new Request(
    `https://enterprise-system-runtime.invalid/kv-quota/${kind}`
  )
}

let quotaExhaustedDay: string | null = null
let quotaHandoffDay: string | null = null

async function persistDayFlag(
  kind: 'exhausted' | 'handoff',
  day: string
): Promise<void> {
  try {
    await caches.default.put(
      quotaReq(kind),
      new Response(day, {
        headers: { 'Cache-Control': 'public, max-age=90000' },
      })
    )
  } catch {
    /* memory only */
  }
}

async function readDayFlag(kind: 'exhausted' | 'handoff'): Promise<string | null> {
  try {
    const res = await caches.default.match(quotaReq(kind))
    if (!res) return null
    const day = (await res.text()).trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
  } catch {
    return null
  }
}

/** Free-plan KV writes/day (1000) used up on this isolate / Cache. */
export function isKvWriteQuotaExhausted(): boolean {
  return quotaExhaustedDay === dayKeyUtc()
}

/** Primary already activated the peer for today's KV/daily limit. */
export function isKvQuotaHandoffDone(): boolean {
  return quotaHandoffDay === dayKeyUtc()
}

export async function refreshKvWriteQuotaFromCache(): Promise<void> {
  const today = dayKeyUtc()
  if (quotaExhaustedDay !== today) {
    const stored = await readDayFlag('exhausted')
    if (stored === today) quotaExhaustedDay = today
  }
  if (quotaHandoffDay !== today) {
    const stored = await readDayFlag('handoff')
    if (stored === today) quotaHandoffDay = today
  }
}

export async function markKvWriteQuotaExhausted(): Promise<void> {
  const day = dayKeyUtc()
  quotaExhaustedDay = day
  await persistDayFlag('exhausted', day)
}

export async function markKvQuotaHandoffDone(): Promise<void> {
  const day = dayKeyUtc()
  quotaHandoffDay = day
  await persistDayFlag('handoff', day)
}

/**
 * Put to KV at most once per `minIntervalMs` per key (unless force).
 * Callers must still write Cache/memory themselves for hot path.
 */
export async function kvPutThrottled(
  kv: KVNamespace | undefined,
  key: string,
  value: string,
  minIntervalMs: number,
  opts?: { force?: boolean; expirationTtl?: number }
): Promise<KvPutResult> {
  if (!kv) return 'no_kv'
  const now = Date.now()
  if (!opts?.force) {
    const prev = await readStamp(key)
    if (prev > 0 && now - prev < minIntervalMs) return 'skipped'
  }
  try {
    if (opts?.expirationTtl != null) {
      await kv.put(key, value, { expirationTtl: opts.expirationTtl })
    } else {
      await kv.put(key, value)
    }
    await writeStamp(key, now)
    return 'written'
  } catch {
    await markKvWriteQuotaExhausted()
    return 'failed'
  }
}
