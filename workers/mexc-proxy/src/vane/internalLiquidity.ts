import { findFvg, findOrderBlocks } from '../confluence'
import type { Candle, Side, VaneZoneGeom } from './types'

/**
 * Tier-2 internal liquidity: 15m FVG / OB along 4H trend — not external 4H SSL wait.
 */
export function findInternalZone(opts: {
  side: Side
  price: number
  candles15m: Candle[]
  bias4h: 'BULL' | 'BEAR' | 'FLAT'
}): VaneZoneGeom | null {
  if (opts.bias4h === 'FLAT') return null
  if (opts.side === 'LONG' && opts.bias4h !== 'BULL') return null
  if (opts.side === 'SHORT' && opts.bias4h !== 'BEAR') return null

  const want = opts.side === 'LONG' ? 'BULLISH' : 'BEARISH'
  const fvgs = findFvg(opts.candles15m, 6).filter((f) => f.type === want)
  const obs = findOrderBlocks(opts.candles15m, 6).filter((o) => o.type === want)

  type Band = {
    low: number
    high: number
    source: 'FVG15' | 'OB15'
    mid: number
  }
  const bands: Band[] = []

  for (const f of fvgs) {
    const low = Math.min(f.top, f.bottom)
    const high = Math.max(f.top, f.bottom)
    if (opts.side === 'LONG' && low > opts.price * 1.002) continue
    if (opts.side === 'SHORT' && high < opts.price * 0.998) continue
    bands.push({
      low,
      high,
      source: 'FVG15',
      mid: (low + high) / 2,
    })
  }

  for (const ob of obs) {
    const low = Math.min(ob.top, ob.bottom)
    const high = Math.max(ob.top, ob.bottom)
    if (opts.side === 'LONG' && low > opts.price * 1.002) continue
    if (opts.side === 'SHORT' && high < opts.price * 0.998) continue
    bands.push({
      low,
      high,
      source: 'OB15',
      mid: (low + high) / 2,
    })
  }

  if (!bands.length) return null

  bands.sort(
    (a, b) => Math.abs(a.mid - opts.price) - Math.abs(b.mid - opts.price)
  )
  const best = bands[0]!
  const distPct = (Math.abs(best.mid - opts.price) / opts.price) * 100
  if (distPct > 2.8) return null

  return {
    zoneLow: best.low,
    zoneHigh: best.high,
    mid: best.mid,
    limitEntry: (best.low + best.mid) / 2,
    source: best.source,
    tf: '15m',
    strength: 5,
    touches: 1,
  }
}
