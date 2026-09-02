/**
 * Balance / auction read: the range price actually lived in,
 * whether it broke, and whether that break failed (BTC: range → short break → back).
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { LiqHeatmapModel } from '../derivatives/liqHeatmap'

export type AuctionKind =
  | 'INSIDE'
  | 'FAILED_BREAK_DOWN'
  | 'FAILED_BREAK_UP'
  | 'BREAK_DOWN'
  | 'BREAK_UP'
  | 'NONE'

export interface AuctionRange {
  top: number
  bottom: number
  mid: number
  kind: AuctionKind
  /** Stops of range shorts — equal highs / range high */
  stopsHigh: number
  /** Stops of range longs — equal lows / range low */
  stopsLow: number
  strongHigh: boolean
  strongLow: boolean
  highLabel: string
  lowLabel: string
}

function pct(a: number, b: number): number {
  if (!(b > 0)) return 99
  return (Math.abs(a - b) / b) * 100
}

/** Dense overlapping range from recent candles (проторговка). */
export function readBalanceRange(candles: OhlcvCandle[]): { top: number; bottom: number } | null {
  if (candles.length < 16) return null
  const window = candles.slice(-Math.min(72, candles.length))
  const highs = window.map((c) => c[2])
  const lows = window.map((c) => c[3])
  const minP = Math.min(...lows)
  const maxP = Math.max(...highs)
  if (!(maxP > minP)) return null
  const bins = 24
  const step = (maxP - minP) / bins
  if (!(step > 0)) return null
  const counts = new Array<number>(bins).fill(0)
  for (const c of window) {
    const a = Math.max(0, Math.floor((c[3] - minP) / step))
    const b = Math.min(bins - 1, Math.floor((c[2] - minP) / step))
    for (let i = a; i <= b; i++) counts[i]++
  }
  const avg = counts.reduce((s, n) => s + n, 0) / bins
  const thresh = Math.max(avg * 1.18, 3)
  let bestA = 0
  let bestB = 0
  let bestSum = 0
  let start = -1
  for (let i = 0; i <= bins; i++) {
    if (i < bins && counts[i] >= thresh) {
      if (start < 0) start = i
    } else if (start >= 0) {
      let sum = 0
      for (let k = start; k < i; k++) sum += counts[k]
      if (sum > bestSum) {
        bestSum = sum
        bestA = start
        bestB = i - 1
      }
      start = -1
    }
  }
  if (bestSum <= 0) {
    const sortedH = [...highs].sort((a, b) => a - b)
    const sortedL = [...lows].sort((a, b) => a - b)
    const top = sortedH[Math.floor(sortedH.length * 0.82)]
    const bottom = sortedL[Math.floor(sortedL.length * 0.18)]
    if (!(top > bottom)) return null
    return { top, bottom }
  }
  return {
    bottom: minP + bestA * step,
    top: minP + (bestB + 1) * step,
  }
}

function lookbackExtremes(candles: OhlcvCandle[], n: number): { minL: number; maxH: number } {
  const w = candles.slice(-n)
  let minL = Infinity
  let maxH = -Infinity
  for (const c of w) {
    if (c[3] < minL) minL = c[3]
    if (c[2] > maxH) maxH = c[2]
  }
  return { minL, maxH }
}

export function readAuction(
  candles: OhlcvCandle[],
  price: number,
  liq: LiqHeatmapModel | null | undefined,
  eqHighs?: Array<{ price: number; strength: string; isActive: boolean }>,
  eqLows?: Array<{ price: number; strength: string; isActive: boolean }>
): AuctionRange | null {
  const bal = readBalanceRange(candles)
  if (!bal || !(bal.top > bal.bottom)) return null
  const { top, bottom } = bal
  const mid = (top + bottom) / 2
  const pad = (top - bottom) * 0.08
  const last = candles[candles.length - 1]
  const close = last?.[4] ?? price
  const recent = lookbackExtremes(candles, 10)
  const wickDown = recent.minL < bottom - pad * 0.35
  const wickUp = recent.maxH > top + pad * 0.35
  const bodyDown = close < bottom - pad * 0.15
  const bodyUp = close > top + pad * 0.15
  const backInside = close >= bottom - pad * 0.05 && close <= top + pad * 0.05

  let kind: AuctionKind = 'INSIDE'
  if (wickDown && backInside && !bodyDown) kind = 'FAILED_BREAK_DOWN'
  else if (wickUp && backInside && !bodyUp) kind = 'FAILED_BREAK_UP'
  else if (bodyDown) kind = 'BREAK_DOWN'
  else if (bodyUp) kind = 'BREAK_UP'
  else if (close >= bottom && close <= top) kind = 'INSIDE'
  else kind = close < mid ? 'BREAK_DOWN' : 'BREAK_UP'

  const strongEqH = (eqHighs ?? [])
    .filter((e) => e.isActive && pct(e.price, top) <= 1.2)
    .sort((a, b) => (a.strength === 'STRONG' ? -1 : 1) - (b.strength === 'STRONG' ? -1 : 1))[0]
  const strongEqL = (eqLows ?? [])
    .filter((e) => e.isActive && pct(e.price, bottom) <= 1.2)
    .sort((a, b) => (a.strength === 'STRONG' ? -1 : 1) - (b.strength === 'STRONG' ? -1 : 1))[0]

  const liqShort =
    liq?.nearestShortLiq != null && pct(liq.nearestShortLiq, top) <= 2.5
      ? liq.nearestShortLiq
      : liq?.shortClusters.find((c) => c.score >= 0.55 && c.price > price)?.price
  const liqLong =
    liq?.nearestLongLiq != null && pct(liq.nearestLongLiq, bottom) <= 2.5
      ? liq.nearestLongLiq
      : liq?.longClusters.find((c) => c.score >= 0.55 && c.price < price)?.price

  const stopsHigh = strongEqH?.price ?? liqShort ?? top
  const stopsLow = strongEqL?.price ?? liqLong ?? bottom
  const strongHigh = Boolean(
    strongEqH?.strength === 'STRONG' ||
      (liq?.shortClusters[0] && liq.shortClusters[0].score >= 0.7)
  )
  const strongLow = Boolean(
    strongEqL?.strength === 'STRONG' ||
      (liq?.longClusters[0] && liq.longClusters[0].score >= 0.7)
  )

  return {
    top,
    bottom,
    mid,
    kind,
    stopsHigh,
    stopsLow,
    strongHigh,
    strongLow,
    highLabel: strongEqH ? 'стопы шортов · EQH' : liqShort ? 'ликвидации шортов' : 'хай диапазона',
    lowLabel: strongEqL ? 'стопы лонгов · EQL' : liqLong ? 'ликвидации лонгов' : 'лой диапазона',
  }
}
