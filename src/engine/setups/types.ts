import type { PathPoint } from '../prediction/types'

export type SetupKind =
  | 'FORECAST_A'
  | 'FORECAST_B'
  | 'FORECAST_C'
  | 'MM_HUNT'
  | 'SURGICAL'
  | 'BOUNCE_SSL'
  | 'BOUNCE_BSL'
  | 'STOP_THEN_REVERSE'

export type SetupPreconditionStatus = 'PENDING' | 'MET' | 'FAILED'

export interface SetupPrecondition {
  id: string
  label: string
  status: SetupPreconditionStatus
}

export type ConditionalSetupStatus =
  | 'HYPOTHESIS'
  | 'ARMED'
  | 'READY'
  | 'INVALIDATED'
  | 'EXPIRED'

/** Horizon of the conditional trade (chart Zones / Сделки) */
export type SetupTradeStyle = 'SCALP' | 'INTRADAY' | 'SWING'

/** Take-profit ladder with cascade reach probabilities (given fill). */
export interface TradeTargetLadder {
  r1: number
  r2: number
  r3: number
  pReach1: number
  pReach2: number
  pReach3: number
}

export type TradeMagnetKind =
  | 'BSL'
  | 'SSL'
  | 'POC'
  | 'FIB141'
  | 'MM_MACRO'
  | 'MM_MICRO'
  | 'OPPOSITE_LIQ'

export interface TradeMagnet {
  price: number
  label: string
  kind: TradeMagnetKind
}

export interface TradeGlobalView {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  summary: string
  factors: string[]
}

export interface ConditionalSetup {
  id: string
  kind: SetupKind
  side: 'LONG' | 'SHORT'
  title: string
  probability: number
  preconditions: SetupPrecondition[]
  entryZone: { top: number; bottom: number }
  limitEntry: number
  target: number
  invalidation: number
  triggerSummary: string
  reasoning: string[]
  chartPath?: PathPoint[]
  status: ConditionalSetupStatus
  /** Symbol for watch persistence */
  symbol?: string
  internalSymbol?: string
  createdAt: number
  /** 1R / 2R / 3R ladder + reach probs */
  targetsLadder?: TradeTargetLadder
  /** Main liquidity / structure magnet for the flight */
  magnet?: TradeMagnet
  /** Market-level bias narrative shared across ranked trades */
  globalView?: TradeGlobalView
  /** SCALP / INTRADAY / SWING — set by Zones & Сделки */
  tradeStyle?: SetupTradeStyle
}

export interface WatchedSetup {
  watchId: string
  chatId: number
  symbol: string
  internalSymbol: string
  setup: ConditionalSetup
  createdAt: number
  expiresAt: number
  lastStatus: ConditionalSetupStatus
  readyNotified: boolean
  invalidatedNotified: boolean
  updatedAt: number
}
