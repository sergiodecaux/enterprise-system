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
  /** Forced liquidation cascade (inferred from tape burst) */
  | 'LIQ'
  /** Spot vs perp health sample */
  | 'SPOT_PERP'

export interface MarketFrame {
  at: number
  kind: FrameKind
  /** Directional hint for the frame */
  side?: 'BID' | 'ASK' | 'BUY' | 'SELL' | 'FLAT' | 'LONG_LIQ' | 'SHORT_LIQ'
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
  /** Толпа заперта лимитками кита → топливо для разворота */
  | 'TRAPPED_TRADERS'

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
  /** Z-score of recent hit USD vs rolling baseline */
  hitZScore?: number | null
  hitIsAnomaly?: boolean
  /** Spot vs perpetual delta health */
  spotPerpMul?: number | null
  spotPerpStatus?: string | null
  /** Recent inferred liquidation cascade USD */
  liqUsd?: number | null
  liqSide?: 'LONG_LIQ' | 'SHORT_LIQ' | null
}
