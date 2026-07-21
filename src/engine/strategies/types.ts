import type { TradeSide } from '../smc'
import type { CoinSignal } from '../types'

/** Горизонт сделки: скальп / интрадей / свинг */
export type TradeStyle = 'SCALP' | 'INTRADAY' | 'SWING'

export interface StyleRiskModel {
  /** Макс. допустимый стоп в % от цены */
  maxStopPct: number
  /** Мин. допустимый стоп в % от цены */
  minStopPct: number
  /** Множитель R для TP1 */
  tp1RMultiple: number
  /** Множитель R для TP2 */
  tp2RMultiple: number
  /** Ожидаемая длительность, мин */
  horizonMinMinutes: number
  horizonMaxMinutes: number
}

export interface StyleConfidenceWeights {
  /** Веса факторов 0..1, сумма ≈ 1 */
  structure: number
  orderFlow: number
  session: number
  htfBias: number
  liquidation: number
}

export interface StyleProfile {
  style: TradeStyle
  label: string
  badge: string
  timeframeHint: string
  risk: StyleRiskModel
  weights: StyleConfidenceWeights
  /** Мин. confluence score для trigger */
  minScore: number
  /** Мин. strength-фильтров для Sniper */
  minStrengthFilters: number
  /** Мин. R:R */
  minRiskReward: number
}

export interface StyleClassification {
  style: TradeStyle
  confidence: number
  reasons: string[]
}

export interface StyleScoredSignal {
  signal: CoinSignal
  style: TradeStyle
  styleConfidence: number
  styleReasons: string[]
}

export type { TradeSide }
