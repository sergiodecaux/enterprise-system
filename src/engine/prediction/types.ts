import type { TrendDirection, TradeSide } from '../smc'

// Re-export for consumers that need direction types alongside forecast
export type { TrendDirection, TradeSide }

// ============================================================
// Multi-TF Alignment
// ============================================================

export type TFBias = 'LONG' | 'SHORT' | 'NEUTRAL'
export type AlignmentStrength =
  | 'STRONG_LONG'
  | 'LONG'
  | 'NEUTRAL'
  | 'SHORT'
  | 'STRONG_SHORT'

export interface TFSnapshot {
  timeframe: '1d' | '4h' | '1h'
  close: number
  open: number
  high: number
  low: number
  direction: 'BULLISH' | 'BEARISH' | 'DOJI'
  closePosition: 'UPPER' | 'MIDDLE' | 'LOWER'
  bodyPercent: number
  consecutiveSameSide: number
  ema20: number | null
  ema200: number | null
  aboveEma20: boolean
  aboveEma200: boolean
  rsi: number
  bias: TFBias
  biasReason: string
}

export interface MultiTFAlignment {
  daily: TFSnapshot
  h4: TFSnapshot
  h1: TFSnapshot
  strength: AlignmentStrength
  score: number
  agreement: boolean
  dominantBias: TFBias
  primaryLiqTarget: LiquidityTarget
  secondaryLiqTarget: LiquidityTarget | null
  generatedAt: number
}

// ============================================================
// Liquidity Map
// ============================================================

export type LiquidityType =
  | 'SWING_HIGH'
  | 'SWING_LOW'
  | 'ORDER_BLOCK'
  | 'FVG'
  | 'POC'
  | 'ROUND_NUMBER'
  | 'DAILY_HIGH'
  | 'DAILY_LOW'
  | 'OB_WALL'

export interface LiquidityLevel {
  id: string
  type: LiquidityType
  price: number
  side: 'BUY_SIDE' | 'SELL_SIDE'
  strength: number
  distancePercent: number
  label: string
}

export interface LiquidityTarget {
  price: number
  type: LiquidityType
  strength: number
  distancePercent: number
  direction: 'UP' | 'DOWN'
  label: string
}

// ============================================================
// Price Prediction Scenarios
// ============================================================

export interface PathPoint {
  timeOffsetSeconds: number
  price: number
  label?: string
  isKeyLevel?: boolean
}

export type ScenarioType = 'LONG' | 'SHORT' | 'RANGE'

export interface PriceScenario {
  id: 'A' | 'B' | 'C'
  type: ScenarioType
  label: string
  probability: number
  color: string
  path: PathPoint[]
  entry: number
  target: number
  invalidation: number
  liquidityTarget: LiquidityTarget
  reasoning: string[]
  triggerCondition: string
  riskReward: number
  atrMultiple: number
}

export interface PriceForecast {
  symbol: string
  currentPrice: number
  scenarios: PriceScenario[]
  mtfAlignment: MultiTFAlignment
  liquidityMap: LiquidityLevel[]
  dominantScenario: 'A' | 'B' | 'C'
  generatedAt: number
  candleTimeframeSeconds: number
  /** Unix seconds — якорь пути (закрытая свеча) */
  lastCandleTimestamp: number
  /** INTRA / SCALP / SWING / MACRO */
  horizon?: 'SCALP' | 'INTRA' | 'SWING' | 'MACRO'
  macroSummary?: string
}
