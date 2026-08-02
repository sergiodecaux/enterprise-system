import type { MarketRegime } from '../regime/marketRegime'
import type { OiSnapshot } from './oiTracker'

/** One Remizov "frame" — a micro-event in the order-flow process */
export type FrameKind =
  | 'PA'
  | 'VOL'
  | 'BOOK'
  | 'HIT'
  | 'DELTA'
  | 'REGIME'
  | 'WALL'
  | 'OI'

export interface MarketFrame {
  at: number
  kind: FrameKind
  /** Directional hint for the frame */
  side?: 'BID' | 'ASK' | 'BUY' | 'SELL' | 'FLAT'
  price?: number
  volumeUsd?: number
  /** 0..1 relative strength */
  strength?: number
  label?: string
  meta?: Record<string, string | number | boolean | null | undefined>
}

export type SequenceKind =
  | 'WALL_ABSORPTION_EXHAUSTION'
  | 'CVD_DIVERGENCE_LIMIT'
  | 'WALL_RELEASE'
  | 'OI_DELTA_CONFIRM'

export interface SequenceHit {
  id: string
  kind: SequenceKind
  side: 'LONG' | 'SHORT'
  /** 0..100 */
  confidence: number
  title: string
  summary: string
  steps: string[]
  wallPrice: number | null
  hitUsd: number
  regime: MarketRegime
  /** False → show as context only, do not promote to primary */
  allowedInRegime: boolean
  framesUsed: number
  detectedAt: number
  expiresAt: number
  /** Optional hist WR overlay from local journal */
  histWr?: {
    winRate: number | null
    decided: number
    deltaPct: number
    reason: string
  } | null
}

export interface SequenceEvalContext {
  symbol: string
  price: number
  regime: MarketRegime
  /** Whale support (BID) */
  supportPrice?: number | null
  supportUsd?: number | null
  supportDistPct?: number | null
  /** Whale resistance (ASK) */
  resistPrice?: number | null
  resistUsd?: number | null
  resistDistPct?: number | null
  /** CVD / tape over recent window */
  buyVol?: number
  sellVol?: number
  cumulativeDelta?: number
  aggressionBuyPct?: number
  cvdDivergence?: 'BULLISH' | 'BEARISH' | 'NONE' | null
  cvdHasDivergence?: boolean
  /** Wall still present & not eaten */
  bidWallAlive?: boolean
  askWallAlive?: boolean
  /** Recent wall eat / spoof flags */
  wallEatenBid?: boolean
  wallEatenAsk?: boolean
  bookImbalance?: number | null
  oi?: OiSnapshot | null
  now?: number
}
