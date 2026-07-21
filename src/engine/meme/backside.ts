import type { OhlcvCandle } from '../../api/mexc'
import { calculateRsi } from '../smc'

export interface BacksideResult {
  detected: boolean
  rsi5m: number | null
  lowerHigh: boolean
  trendlineBroken: boolean
  scoreBoost: number
  label: string
  emoji: string
  alert: string | null
}

function detectLowerHigh(candles: OhlcvCandle[]): boolean {
  if (candles.length < 15) return false
  const w = candles.slice(-15)
  const swings: number[] = []
  for (let i = 2; i < w.length - 2; i++) {
    if (
      w[i][2] >= w[i - 1][2] &&
      w[i][2] >= w[i - 2][2] &&
      w[i][2] >= w[i + 1][2] &&
      w[i][2] >= w[i + 2][2]
    ) {
      swings.push(w[i][2])
    }
  }
  if (swings.length < 2) return false
  return swings[swings.length - 1] < swings[swings.length - 2]
}

/**
 * Пробой параболической линии ускорения (упрощённо: линейная регрессия lows
 * последних N растущих свечей, затем close ниже линии).
 */
function detectParabolicBreak(candles: OhlcvCandle[]): boolean {
  if (candles.length < 20) return false
  const w = candles.slice(-25, -1)
  // Найти сегмент роста: consecutive higher lows
  let start = w.length - 1
  while (start > 5 && w[start][3] >= w[start - 1][3] * 0.998) {
    start--
  }
  const seg = w.slice(start)
  if (seg.length < 6) return false

  // Linear fit on lows
  const n = seg.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += seg[i][3]
    sumXY += i * seg[i][3]
    sumXX += i * i
  }
  const denom = n * sumXX - sumX * sumX
  if (denom === 0) return false
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  if (slope <= 0) return false // не ускорение вверх

  const last = candles[candles.length - 1]
  const projected = intercept + slope * n
  return last[4] < projected * 0.997
}

function hasLowerLow(candles: OhlcvCandle[]): boolean {
  if (candles.length < 10) return false
  const w = candles.slice(-10)
  const lastLow = w[w.length - 1][3]
  const priorLows = w.slice(0, -1).map((c) => c[3])
  const priorMin = Math.min(...priorLows)
  return lastLow < priorMin
}

/**
 * Backside of the Move — элитный SCALP SHORT после слома параболы.
 * SHORT только после: RSI>90 был, Lower High, trendline break, Lower Low.
 */
export function detectBacksideShort(
  ohlcv1m: OhlcvCandle[],
  ohlcv5m: OhlcvCandle[] | null,
  fundingNormalized: boolean
): BacksideResult {
  const empty: BacksideResult = {
    detected: false,
    rsi5m: null,
    lowerHigh: false,
    trendlineBroken: false,
    scoreBoost: 0,
    label: '',
    emoji: '',
    alert: null,
  }

  const src5 = ohlcv5m && ohlcv5m.length >= 20 ? ohlcv5m : ohlcv1m
  const rsi = calculateRsi(
    src5.map((c) => c[4]),
    14
  )

  // RSI был экстремальным недавно
  let rsiWasExtreme = rsi != null && rsi > 85
  if (src5.length >= 30) {
    for (let i = src5.length - 15; i < src5.length; i++) {
      const slice = src5.slice(0, i + 1).map((c) => c[4])
      if (slice.length < 15) continue
      const r = calculateRsi(slice, 14)
      if (r != null && r > 90) {
        rsiWasExtreme = true
        break
      }
    }
  }

  const lowerHigh = detectLowerHigh(ohlcv1m)
  const trendlineBroken = detectParabolicBreak(ohlcv1m)
  const lowerLow = hasLowerLow(ohlcv1m)

  // HH/HL structure still intact → no short
  if (!trendlineBroken || !lowerLow) {
    return {
      ...empty,
      rsi5m: rsi,
      lowerHigh,
      trendlineBroken,
    }
  }

  if (rsiWasExtreme && lowerHigh && trendlineBroken && lowerLow) {
    // Prefer when funding normalized (fuel burned)
    const boost = fundingNormalized ? 40 : 28
    return {
      detected: true,
      rsi5m: rsi,
      lowerHigh: true,
      trendlineBroken: true,
      scoreBoost: boost,
      emoji: '🎯',
      label: 'SCALP SHORT (The Backside) — хребет тренда сломан',
      alert:
        '🎯 BACKSIDE SHORT: ММ ушёл, bids сняты. Падение под гравитацией. Элитный шорт.',
    }
  }

  return {
    ...empty,
    rsi5m: rsi,
    lowerHigh,
    trendlineBroken,
  }
}
