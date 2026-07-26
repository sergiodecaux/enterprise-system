import { isBlueChip } from './universe'
import type { VaneTicker } from './mexc'
import type { VaneKv } from './types'

const CURSOR_KEY = 'vane:rr_cursor'

/** Cheap ticker heat: movers + near 24h extremes (no extra HTTP). */
export function hotScore(t: VaneTicker): number {
  const chg = Math.abs(Number(t.riseFallRate ?? 0) * 100)
  const last = Number(t.lastPrice)
  const hi = Number(t.high24Price ?? 0)
  const lo = Number(t.lower24Price ?? 0)
  let nearExt = 0
  if (hi > lo && last > 0) {
    const span = hi - lo
    if (span > 0) {
      // 1 at 24h high/low edge, ~0 at mid-range
      nearExt = Math.max(
        1 - (hi - last) / span,
        1 - (last - lo) / span
      )
    }
  }
  return chg * 1.2 + nearExt * 25 + (isBlueChip(t.symbol) ? 8 : 0)
}

/**
 * Autonomous search batch:
 * - always open paper pins
 * - top "hot" tickers (likely near zones / moving)
 * - round-robin fill so whole TOP-50 is visited continuously
 */
export async function pickVaneBatch(opts: {
  kv?: VaneKv
  universe: VaneTicker[]
  pinSymbols?: string[]
  batchSize?: number
  hotSlots?: number
}): Promise<{ batch: VaneTicker[]; cursor: number; nextCursor: number }> {
  const batchSize = Math.max(2, opts.batchSize ?? 5)
  const hotSlots = Math.min(
    Math.max(1, opts.hotSlots ?? 2),
    Math.max(1, batchSize - 1)
  )
  const pins = new Set(opts.pinSymbols ?? [])
  const bySym = new Map(opts.universe.map((t) => [t.symbol, t]))

  const batch: VaneTicker[] = []
  const used = new Set<string>()

  for (const sym of pins) {
    const t = bySym.get(sym)
    if (t && !used.has(t.symbol)) {
      batch.push(t)
      used.add(t.symbol)
    }
  }

  const pool = opts.universe.filter((t) => !used.has(t.symbol))
  const hot = [...pool].sort((a, b) => hotScore(b) - hotScore(a))
  for (const t of hot) {
    if (batch.length >= batchSize) break
    if (batch.filter((x) => !pins.has(x.symbol)).length >= hotSlots) break
    batch.push(t)
    used.add(t.symbol)
  }

  const rotating = opts.universe.filter((t) => !used.has(t.symbol))
  let cursor = 0
  if (opts.kv) {
    try {
      cursor = Math.max(0, Number((await opts.kv.get(CURSOR_KEY)) || 0) || 0)
    } catch {
      cursor = 0
    }
  }
  if (rotating.length) {
    cursor = cursor % rotating.length
    const need = Math.max(0, batchSize - batch.length)
    for (let i = 0; i < need; i++) {
      const t = rotating[(cursor + i) % rotating.length]!
      if (!used.has(t.symbol)) {
        batch.push(t)
        used.add(t.symbol)
      }
    }
    const nextCursor = (cursor + Math.max(1, need)) % rotating.length
    if (opts.kv) {
      try {
        await opts.kv.put(CURSOR_KEY, String(nextCursor))
      } catch {
        /* quota */
      }
    }
    return { batch, cursor, nextCursor }
  }

  return { batch, cursor: 0, nextCursor: 0 }
}
