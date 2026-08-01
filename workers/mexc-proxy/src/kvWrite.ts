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
    return 'failed'
  }
}
