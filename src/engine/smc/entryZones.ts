/**
 * Actionable FVG / order-block zones: where to take a long or short
 * on a pullback, and which zone to launch from.
 */

import type { Time } from 'lightweight-charts'
import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone } from '../indicators/types'
import { calculateFvgZones, calculateOrderBlockZones } from '../zones/liquidity'

export interface ActionZonePick {
  zones: LiquidityZone[]
  launchId: string | null
}

function distPct(price: number, zone: LiquidityZone): number {
  const mid = (zone.top + zone.bottom) / 2
  return Math.abs(mid - price) / Math.max(price, 1e-12)
}

function inside(price: number, zone: LiquidityZone): boolean {
  return price <= zone.top && price >= zone.bottom
}

function tag(
  zone: LiquidityZone,
  role: 'long' | 'short' | 'launch'
): LiquidityZone {
  const kind = zone.type === 'FVG' ? 'FVG' : 'OB'
  const hint =
    role === 'launch'
      ? `оторваться · ${kind}`
      : role === 'long'
        ? `${kind} · лонг с отката`
        : `${kind} · шорт с отката`
  return {
    ...zone,
    contextHint: hint,
    label: hint,
    strength: role === 'launch' ? 11 : Math.max(zone.strength ?? 6, 8),
    invalidation: zone.side === 'BULLISH' ? zone.bottom : zone.top,
  }
}

/** Unfilled FVG + valid OB nearest to price, labelled for pullback entries. */
export function pickActionZones(opts: {
  candles: OhlcvCandle[]
  price: number
  side: 'LONG' | 'SHORT' | null
}): ActionZonePick {
  const { candles, price, side } = opts
  if (candles.length < 10 || !(price > 0)) {
    return { zones: [], launchId: null }
  }

  const lastTs = Math.floor(candles[candles.length - 1][0] / 1000)
  const visibleEnd = (lastTs + 86400 * 3) as Time
  const raw = [
    ...calculateFvgZones(candles),
    ...calculateOrderBlockZones(candles),
  ]
    .filter((z) => z.top > z.bottom)
    .map((z) => ({ ...z, endTime: visibleEnd }))
    .filter((z) => distPct(price, z) < 0.14)

  const longs = raw
    .filter((z) => z.side === 'BULLISH' && z.top <= price * 1.004)
    .sort((a, b) => distPct(price, a) - distPct(price, b))
  const shorts = raw
    .filter((z) => z.side === 'BEARISH' && z.bottom >= price * 0.996)
    .sort((a, b) => distPct(price, a) - distPct(price, b))
  const sitting = raw.filter((z) => inside(price, z))

  let launch: LiquidityZone | null = null
  if (side === 'LONG') {
    launch =
      sitting.find((z) => z.side === 'BULLISH') ?? longs[0] ?? null
  } else if (side === 'SHORT') {
    launch =
      sitting.find((z) => z.side === 'BEARISH') ?? shorts[0] ?? null
  } else {
    const nearestLong = longs[0]
    const nearestShort = shorts[0]
    if (sitting[0]) launch = sitting[0]
    else if (nearestLong && nearestShort) {
      launch =
        distPct(price, nearestLong) <= distPct(price, nearestShort)
          ? nearestLong
          : nearestShort
    } else {
      launch = nearestLong ?? nearestShort ?? sitting[0] ?? null
    }
  }

  const out: LiquidityZone[] = []
  const seen = new Set<string>()
  const push = (z: LiquidityZone | undefined | null, role: 'long' | 'short') => {
    if (!z || seen.has(z.id)) return
    seen.add(z.id)
    out.push(tag(z, z.id === launch?.id ? 'launch' : role))
  }

  push(launch, launch?.side === 'BEARISH' ? 'short' : 'long')
  for (const z of longs.slice(0, 2)) push(z, 'long')
  for (const z of shorts.slice(0, 2)) push(z, 'short')

  return { zones: out.slice(0, 5), launchId: launch?.id ?? null }
}
