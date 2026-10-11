import type { OhlcvCandle } from '../../api/mexc'
import type { HORIZONS } from './config'

export type EventTf = '1h' | '4h' | '1d' | '1w'
export type EventKind = 'BOS' | 'CHOCH' | 'RECLAIM'
export type EventSide = 'UP' | 'DOWN'
export type OutcomeKind = 'hit' | 'invalidated' | 'undecided'
export type GroupStatus = 'insufficient' | 'concentrated' | 'wide' | 'ok'
export type OiFlag = 'unknown'
/** Order is the search order: body, then HTF zone on top, then leg location on top. */
export type GroupAxis = 'body' | 'htfZone' | 'location'

export interface HistorySeries {
  m15: OhlcvCandle[]
  h1: OhlcvCandle[]
  h4: OhlcvCandle[]
  d1: OhlcvCandle[]
}

export interface HeldSnap {
  tf: EventTf
  kind: EventKind
  side: EventSide
  level: number
  timeSec: number
  target: number | null
  trend: 'BULLISH' | 'BEARISH' | 'RANGING'
  location: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM'
  priorSweep: boolean
  volumeRatio: number | null
  body: 'displacement' | 'weak'
  htfZone: boolean
  atr: number
  entry: number
}

export interface HorizonOutcome {
  horizon: (typeof HORIZONS)[number]
  result: OutcomeKind
  mfeAtr: number
  maeAtr: number
  barsToTarget: number | null
}

export interface LabeledEvent extends HeldSnap {
  symbol: string
  discoveredMs: number
  weekKey: number
  oi: OiFlag
  holdout: boolean
  horizons: HorizonOutcome[]
  features: FeatureVector
}

export interface FeatureVector {
  event: HeldSnap['kind']
  tf: HeldSnap['tf']
  oi: 'unknown'
  priorSweep: boolean
  trend: HeldSnap['trend']
  location: HeldSnap['location']
  volumeRatio: number | null
  body: HeldSnap['body']
  htfZone: boolean
}

export interface HorizonStats {
  n: number
  hitBeforeInvalidation: number | null
  undecidedShare: number | null
  avgMfeAtr: number | null
  avgMaeAtr: number | null
}

export interface SymbolSpan {
  n: number
  firstMs: number
  lastMs: number
}

export interface CalibrationGroup {
  key: string
  event: EventKind
  tf: EventTf
  oi: OiFlag
  priorSweep: boolean
  /** Null when that axis is not part of this split. */
  body: 'displacement' | 'weak' | null
  htfZone: boolean | null
  location: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' | null
  n: number
  uniqueSymbols: number
  uniqueWeeks: number
  status: GroupStatus
  winRate: number | null
  undecidedShare: number | null
  invalidatedShare: number | null
  /** avgMfeAtr / avgMaeAtr on the 50-bar horizon. Null when MAE is 0. */
  avgRR: number | null
  /** Wilson 95% lower bound of the win rate is above 0.5. */
  significantVsRandom: boolean
  /** Lower bound after Bonferroni. Null when n is below the sample floor. */
  adjustedLo: number | null
  avgMfeAtr: number | null
  avgMaeAtr: number | null
  medianBarsToTarget: number | null
  wilsonLo: number | null
  wilsonHi: number | null
  wilsonWidth: number | null
  window: {
    firstMs: number
    lastMs: number
    bySymbol: Record<string, SymbolSpan>
  }
  byHorizon: Record<string, HorizonStats>
}

export interface HoldoutGroup {
  key: string
  n: number
  winRate: number | null
  undecidedShare: number | null
  invalidatedShare: number | null
  wilsonLo: number | null
  wilsonHi: number | null
  significantVsRandom: boolean
  trainWinRate: number | null
  trainAvgRR: number | null
  trainSignificant: boolean
  overfit: boolean
  /** Train is ok, both sides beat 50% on the Wilson floor, R:R > 1, holdout n >= 10. */
  survives: boolean
}

export interface CalibrationTable {
  calibratedAt: string
  universe: 'blue-chip-pinned'
  minSamples: number
  minUniqueWeeks: number
  wideInterval: number
  horizons: number[]
  holdoutWeeks: number
  oiHistory: 'unavailable'
  staleAfterDays: number
  weekSource: string
  daySource: string
  axes: GroupAxis[]
  comparisons: number
  familyAlpha: number
  adjustedZ: number
  symbols: string[]
  fromMs: number
  toMs: number
  totals: {
    eventsLabeled: number
    trainEvents: number
    holdoutEvents: number
    groups: number
    groupsOk: number
    groupsInsufficient: number
    groupsWide: number
    groupsConcentrated: number
    groupsSignificant: number
    groupsSurvive: number
  }
  checks: {
    significantVsRandom: string
    avgRR: string
    invalidatedShare: string
    survives: string
    rawEventsPersisted: boolean
  }
  groups: CalibrationGroup[]
  holdout: HoldoutGroup[]
}
