import type { StyleProfile } from './types'

/** Multi-day / weekly structure trades */
export const SWING_PROFILE: StyleProfile = {
  style: 'SWING',
  label: 'Свинг',
  badge: '🕯 SWING',
  timeframeHint: '4H–1D',
  risk: {
    maxStopPct: 5,
    minStopPct: 0.8,
    tp1RMultiple: 2.5,
    tp2RMultiple: 4.5,
    horizonMinMinutes: 1440,
    horizonMaxMinutes: 10080,
  },
  weights: {
    structure: 0.35,
    orderFlow: 0.05,
    session: 0.1,
    htfBias: 0.35,
    liquidation: 0.15,
  },
  minScore: 5,
  minStrengthFilters: 2,
  minRiskReward: 2.5,
}
