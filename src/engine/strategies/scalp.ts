import type { StyleProfile } from './types'

export const SCALP_PROFILE: StyleProfile = {
  style: 'SCALP',
  label: 'Скальп',
  badge: '⚡️ SCALP',
  timeframeHint: 'M5',
  risk: {
    maxStopPct: 0.8,
    minStopPct: 0.08,
    tp1RMultiple: 1.5,
    tp2RMultiple: 2.5,
    horizonMinMinutes: 5,
    horizonMaxMinutes: 120,
  },
  weights: {
    structure: 0.2,
    orderFlow: 0.35,
    session: 0.1,
    htfBias: 0.1,
    liquidation: 0.25,
  },
  minScore: 5,
  minStrengthFilters: 2,
  minRiskReward: 2,
}

/**
 * Confidence Score для SCALP.
 * Приоритет: Liquidity Sweep + Tape/Absorption + CVD/Raid + микро-структура.
 */
export function calculateScalpConfidence(input: {
  freshSweep: boolean
  absorption: boolean
  tapeBurst: boolean
  cvdDivergence: boolean
  chochOrMss: boolean
  wallSupport: boolean
  liquidationSwept: boolean
}): { score: number; factors: string[]; quality: 'ELITE' | 'STRONG' | 'WEAK' } {
  const factors: string[] = []
  let raw = 0

  if (input.freshSweep) {
    raw += 22
    factors.push('Liquidity Sweep')
  }
  if (input.absorption) {
    raw += 18
    factors.push('Absorption')
  }
  if (input.tapeBurst) {
    raw += 16
    factors.push('Tape Momentum')
  }
  if (input.cvdDivergence) {
    raw += 14
    factors.push('CVD Divergence')
  }
  if (input.chochOrMss) {
    raw += 12
    factors.push('LTF Structure')
  }
  if (input.wallSupport) {
    raw += 10
    factors.push('Orderbook Wall')
  }
  if (input.liquidationSwept) {
    raw += 18
    factors.push('Liq Cluster Sweep')
  }

  const score = Math.min(Math.round(raw), 98)
  const quality =
    score >= 88 ? 'ELITE' : score >= 70 ? 'STRONG' : 'WEAK'

  return { score, factors, quality }
}

/**
 * Риск-модель скальпа: микро-стоп за свип, короткий TP до ближайшего имбаланса.
 */
export function buildScalpLevels(
  side: 'LONG' | 'SHORT',
  entry: number,
  sweepLevel: number | null,
  nearestImbalance: number | null,
  atr: number
): { sl: number; tp1: number; tp2: number } {
  const microAtr = atr * 0.35
  const { maxStopPct, minStopPct, tp1RMultiple, tp2RMultiple } = SCALP_PROFILE.risk

  let sl: number
  if (side === 'LONG') {
    const sweepSl = sweepLevel != null ? sweepLevel * 0.9985 : entry - microAtr
    sl = Math.min(sweepSl, entry * (1 - minStopPct / 100))
    const maxSl = entry * (1 - maxStopPct / 100)
    if (sl < maxSl) sl = maxSl
  } else {
    const sweepSl = sweepLevel != null ? sweepLevel * 1.0015 : entry + microAtr
    sl = Math.max(sweepSl, entry * (1 + minStopPct / 100))
    const maxSl = entry * (1 + maxStopPct / 100)
    if (sl > maxSl) sl = maxSl
  }

  const risk = Math.abs(entry - sl)
  let tp1 =
    side === 'LONG' ? entry + risk * tp1RMultiple : entry - risk * tp1RMultiple
  let tp2 =
    side === 'LONG' ? entry + risk * tp2RMultiple : entry - risk * tp2RMultiple

  if (nearestImbalance != null) {
    if (side === 'LONG' && nearestImbalance > entry) {
      tp1 = Math.min(tp1, nearestImbalance)
    } else if (side === 'SHORT' && nearestImbalance < entry) {
      tp1 = Math.max(tp1, nearestImbalance)
    }
  }

  return { sl, tp1, tp2 }
}
