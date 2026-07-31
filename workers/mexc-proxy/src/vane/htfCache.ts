import { fetchKlines } from './mexc'
import type { Candle, VaneKv } from './types'

const CACHE_PREFIX = 'vane:klines:'

/** HTF / mid TF TTL — LTF lightly cached to stay under CF subrequest caps */
const TTL_MS: Record<string, number> = {
  Day1: 20 * 60_000,
  Hour4: 15 * 60_000,
  Min60: 12 * 60_000,
  Min15: 6 * 60_000,
  /** Was live every tick — 12 symbols × Min5 blew the subrequest budget */
  Min5: 90_000,
  Min1: 25_000,
}

interface CacheRow {
  at: number
  candles: Candle[]
}

/**
 * Cached klines for expensive HTF. Min1/Min5 always hit MEXC.
 */
export async function fetchKlinesCached(
  kv: VaneKv | undefined,
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const ttl = TTL_MS[interval] ?? 0
  if (!kv || ttl <= 0) {
    return fetchKlines(symbol, interval, limit)
  }

  const key = `${CACHE_PREFIX}${symbol}:${interval}:${limit}`
  try {
    const raw = await kv.get(key)
    if (raw) {
      const row = JSON.parse(raw) as CacheRow
      if (row?.candles?.length && Date.now() - row.at < ttl) {
        return row.candles
      }
    }
  } catch {
    /* fall through */
  }

  const candles = await fetchKlines(symbol, interval, limit)
  if (candles.length && kv) {
    try {
      await kv.put(
        key,
        JSON.stringify({ at: Date.now(), candles } satisfies CacheRow)
      )
    } catch {
      /* quota */
    }
  }
  return candles
}
