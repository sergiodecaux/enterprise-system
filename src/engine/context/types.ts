import type { SessionContext } from '../sessions/sessionQuality'

export type CandleBias = 'BULL' | 'BEAR' | 'NEUTRAL'
export type CloseLocation = 'HIGH' | 'LOW' | 'MID'
export type CrowdTrend = 'RISING' | 'FALLING' | 'FLAT'

export interface OhlcClose {
  open: number
  high: number
  low: number
  close: number
  bias: CandleBias
}

export interface HTFCloseContext {
  dailyClose: OhlcClose
  weeklyClose: OhlcClose
  closedAboveMidpoint: boolean
  closedNearHighOrLow: CloseLocation
}

export interface CrowdContext {
  /** >1 means the crowd is net long. 1 when unknown. */
  longShortRatio: number
  longShortTrend: CrowdTrend
  fundingRate: number
  fundingTrend: CrowdTrend
  /** Percent change of open interest over the last sample. */
  openInterestChangePct: number
  /** False when public ratio/funding/OI could not be read. */
  known: boolean
}

export interface WhaleContext {
  drive: 'UP' | 'DOWN' | 'NEUTRAL'
  hunt: boolean
  nearCluster: boolean
  preferredSide: 'LONG' | 'SHORT' | null
}

export interface ContextThresholds {
  requiredConfirmation: 'SOFT' | 'HARD'
  reversalBias: number
  continuationBias: number
  minZoneStrength: number
}

export interface FullMarketContext {
  session: SessionContext
  htf: HTFCloseContext | null
  crowd: CrowdContext
  whales: WhaleContext
  thresholds: ContextThresholds
  notes: string[]
}

export const EMPTY_CROWD: CrowdContext = {
  longShortRatio: 1,
  longShortTrend: 'FLAT',
  fundingRate: 0,
  fundingTrend: 'FLAT',
  openInterestChangePct: 0,
  known: false,
}
