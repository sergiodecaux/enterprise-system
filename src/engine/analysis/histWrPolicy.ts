/**
 * Historical WR from local journal → soft demotion / boost / gate item.
 * Closes the feedback loop: Lab WR must affect Sniper / Signals / readyGate.
 */

import type { CoinSignal } from '../types'
import { classifySmcSetup } from '../journal/classify'
import {
  querySimilarSetups,
  type SimilarSetupsStats,
} from '../journal/similarSetups'
import type { GateItem } from './readyGate'

/** Min decided trades before hist WR can block / demote */
export const HIST_WR_MIN_N = 8
/** Soft sample for display / mild demotion */
export const HIST_WR_SOFT_N = 3

export type HistWrAction = 'block' | 'demote' | 'boost' | 'neutral' | 'thin'

export interface HistWrPolicy {
  stats: SimilarSetupsStats
  decided: number
  winRate: number | null
  action: HistWrAction
  /** Adjustment to confidence / winPct display (−20…+8) */
  deltaPct: number
  reason: string
}

export function queryHistWrForSignal(signal: CoinSignal): SimilarSetupsStats {
  const classified = classifySmcSetup(signal)
  return querySimilarSetups({
    internalSymbol: signal.internalSymbol,
    direction: signal.direction,
    setupType: classified.setupType,
    tradeStyle: signal.tradeStyle ?? null,
    windowMs: 30 * 24 * 60 * 60 * 1000,
    fallbackGlobal: true,
  })
}

export function evaluateHistWrPolicy(signal: CoinSignal): HistWrPolicy {
  const stats = queryHistWrForSignal(signal)
  const decided = stats.wins + stats.losses
  const winRate = stats.winRate

  if (decided < HIST_WR_SOFT_N || winRate == null) {
    return {
      stats,
      decided,
      winRate,
      action: 'thin',
      deltaPct: 0,
      reason:
        decided === 0
          ? 'Нет истории в журнале'
          : `Мало сделок (n=${decided})`,
    }
  }

  if (decided >= HIST_WR_MIN_N && winRate < 40) {
    return {
      stats,
      decided,
      winRate,
      action: 'block',
      deltaPct: -18,
      reason: `Hist WR ${winRate.toFixed(0)}% (n=${decided}) — блок`,
    }
  }

  if (decided >= HIST_WR_SOFT_N && winRate < 45) {
    return {
      stats,
      decided,
      winRate,
      action: 'demote',
      deltaPct: -10,
      reason: `Hist WR ${winRate.toFixed(0)}% (n=${decided}) — понижение`,
    }
  }

  if (decided >= HIST_WR_SOFT_N && winRate >= 60) {
    return {
      stats,
      decided,
      winRate,
      action: 'boost',
      deltaPct: decided >= HIST_WR_MIN_N ? 8 : 4,
      reason: `Hist WR ${winRate.toFixed(0)}% (n=${decided}) — плюс`,
    }
  }

  return {
    stats,
    decided,
    winRate,
    action: 'neutral',
    deltaPct: 0,
    reason: `Hist WR ${winRate.toFixed(0)}% (n=${decided})`,
  }
}

/** Blend model confidence with hist WR when sample is meaningful */
export function blendConfidenceWithHist(
  modelPct: number,
  policy: HistWrPolicy
): number {
  const base = Math.max(0, Math.min(95, modelPct + policy.deltaPct))
  if (
    policy.winRate == null ||
    policy.decided < HIST_WR_SOFT_N ||
    policy.action === 'thin'
  ) {
    return Math.round(base)
  }
  // Pull toward hist WR (30% hist when soft, 45% when full sample)
  const w = policy.decided >= HIST_WR_MIN_N ? 0.45 : 0.3
  return Math.round(
    Math.max(18, Math.min(92, base * (1 - w) + policy.winRate * w))
  )
}

export function histWrToGateItem(policy: HistWrPolicy): GateItem {
  if (policy.action === 'thin' || policy.winRate == null) {
    return {
      id: 'hist_wr',
      label: 'Hist WR (журнал)',
      status: 'PENDING',
      detail: policy.reason,
    }
  }
  if (policy.action === 'block') {
    return {
      id: 'hist_wr',
      label: 'Hist WR (журнал)',
      status: 'FAIL',
      detail: policy.reason,
    }
  }
  if (policy.action === 'demote') {
    return {
      id: 'hist_wr',
      label: 'Hist WR (журнал)',
      status: 'PENDING',
      detail: policy.reason,
    }
  }
  if (policy.action === 'boost') {
    return {
      id: 'hist_wr',
      label: 'Hist WR (журнал)',
      status: 'PASS',
      detail: policy.reason,
    }
  }
  return {
    id: 'hist_wr',
    label: 'Hist WR (журнал)',
    status: policy.winRate >= 50 ? 'PASS' : 'PENDING',
    detail: policy.reason,
  }
}
