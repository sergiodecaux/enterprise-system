import type { OhlcvCandle } from '../../api/mexc'
import { getOiGrowthPct } from './fuelCache'

export interface SqueezeResult {
  detected: boolean
  inProgress: boolean
  setup: boolean
  fundingRate: number | null
  fundingPct: number | null
  oiGrowthPct: number
  localHighBroken: boolean
  scoreBoost: number
  shortBlocked: boolean
  label: string
  emoji: string
  alert: string | null
}

const empty: SqueezeResult = {
  detected: false,
  inProgress: false,
  setup: false,
  fundingRate: null,
  fundingPct: null,
  oiGrowthPct: 0,
  localHighBroken: false,
  scoreBoost: 0,
  shortBlocked: false,
  label: '',
  emoji: '',
  alert: null,
}

function brokeLocalHigh(candles: OhlcvCandle[], lookback = 20): boolean {
  if (candles.length < lookback + 2) return false
  const recent = candles.slice(-(lookback + 1), -1)
  const last = candles[candles.length - 1]
  const priorHigh = Math.max(...recent.map((c) => c[2]))
  return last[4] > priorHigh || last[2] > priorHigh
}

/**
 * Squeeze Radar / Fuel Engine:
 * аномально отрицательный funding + рост OI + пробой локального хая.
 */
export function detectShortSqueeze(
  symbol: string,
  fundingRate: number | null | undefined,
  openInterest: number | null | undefined,
  ohlcv1m: OhlcvCandle[],
  priceChange24h: number
): SqueezeResult {
  if (fundingRate == null && openInterest == null) return empty

  const funding = fundingRate ?? 0
  const fundingPct = funding * 100 // MEXC отдаёт долю за период
  // Суточный эквивалент грубо: funding * (24 / cycle), cycle часто 8ч → *3
  const fundingDailyApprox = fundingPct * 3

  const oiGrowth = getOiGrowthPct(symbol)
  const highBroken = brokeLocalHigh(ohlcv1m)

  const deeplyNegative = fundingDailyApprox <= -0.15 || fundingPct <= -0.05
  const mildlyNegative = fundingPct < -0.01
  const oiRising = oiGrowth >= 5
  const pumping = priceChange24h >= 15 || highBroken

  const shortBlocked = deeplyNegative || (mildlyNegative && oiRising && pumping)

  // CRITICAL: squeeze in progress
  if (deeplyNegative && oiRising && highBroken) {
    return {
      detected: true,
      inProgress: true,
      setup: true,
      fundingRate: funding,
      fundingPct,
      oiGrowthPct: oiGrowth,
      localHighBroken: true,
      scoreBoost: 35,
      shortBlocked: true,
      emoji: '🚀',
      label: `SHORT SQUEEZE IN PROGRESS | FR ${fundingPct.toFixed(3)}% | OI +${oiGrowth.toFixed(0)}%`,
      alert:
        '🚀 CRITICAL ALERT: SHORT SQUEEZE IN PROGRESS. Толпа в шортах, ММ тащит вверх. Лонг с ММ.',
    }
  }

  // Setup: +30% move + OI up + funding negative
  if (priceChange24h >= 30 && oiRising && mildlyNegative) {
    return {
      detected: true,
      inProgress: false,
      setup: true,
      fundingRate: funding,
      fundingPct,
      oiGrowthPct: oiGrowth,
      localHighBroken: highBroken,
      scoreBoost: 25,
      shortBlocked: true,
      emoji: '🚀',
      label: `SQUEEZE SETUP (LONG) | FR ${fundingPct.toFixed(3)}% | OI +${oiGrowth.toFixed(0)}%`,
      alert:
        '🚀 SQUEEZE SETUP: толпа шортит, ММ готовит ликвидации вверх. TP за локальный хай.',
    }
  }

  if (shortBlocked) {
    return {
      detected: true,
      inProgress: false,
      setup: mildlyNegative && oiRising,
      fundingRate: funding,
      fundingPct,
      oiGrowthPct: oiGrowth,
      localHighBroken: highBroken,
      scoreBoost: mildlyNegative && oiRising ? 12 : 5,
      shortBlocked: true,
      emoji: '🔒',
      label: `Fuel negative FR ${fundingPct.toFixed(3)}% — SHORT blocked`,
      alert: null,
    }
  }

  return {
    ...empty,
    fundingRate: funding,
    fundingPct,
    oiGrowthPct: oiGrowth,
    localHighBroken: highBroken,
  }
}
