/** Vane sniper — zone hold vs S/R flip types */

export type Side = 'LONG' | 'SHORT'
export type VanePath = 'HOLD' | 'FLIP'
export type VaneTier = 'TIER1' | 'TIER2'
export type ZoneGrade = 'STRONG' | 'WEAK' | 'NEUTRAL'
export type VanePhase =
  | 'MONITOR'
  | 'ZONE_TOUCH'
  | 'STRONG_HOLD'
  | 'WEAK_BREAK'
  | 'BREAK_ARMED'
  | 'RETEST_WAIT'
  | 'LONG_LIMIT'
  | 'SHORT_LIMIT'
  | 'ABORT'

export type Candle = [number, number, number, number, number, number]

export interface VaneZoneGeom {
  zoneLow: number
  zoneHigh: number
  mid: number
  limitEntry: number
  source: 'SSL' | 'BSL' | 'FVG15' | 'OB15'
  tf: '4H' | '1D' | '15m'
  strength: number
  touches: number
}

export interface VaneSymbolState {
  symbol: string
  phase: VanePhase
  /** Original zone side before flip (LONG zone → flip SHORT) */
  originSide: Side
  path: VanePath | null
  tier: VaneTier | null
  zone: VaneZoneGeom
  score: number
  armedAt: number | null
  breakConfirmedAt: number | null
  retestBarsLeft: number
  updatedAt: number
  reason: string
}

export interface VaneRiskLevels {
  entry: number
  sl: number
  tp: number
  slPct: number
  tpPct: number
  rr: number
  ok: boolean
  rejectReason?: string
}

export interface VaneDecision {
  symbol: string
  side: Side
  path: VanePath
  tier: VaneTier
  score: number
  setup: string
  zone: VaneZoneGeom
  entry: number
  sl: number
  tp: number
  invalidate: number
  winPct: number
  riskPct: number
  sizeMult: number
  reasons: string[]
  title: string
  text: string
  dedupeKey: string
  /** Alert + paper WAITING, also arm pullback watches */
  needsPullbackWatch?: boolean
  /** Structure arm only — TG watch, no market chase */
  watchOnly?: boolean
  target1?: number
  /** High-WR micro scalp */
  micro?: boolean
}

export interface VaneKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

export const VANE_STATE_PREFIX = 'vane:sym:'
export const VANE_WALL_PREFIX = 'vane:wall:'
export const VANE_RISK_KEY = 'vane:portfolio_risk_v1'

/** Scalp-friendly floors — find early moves, still wait zone fill */
export const MIN_VANE_SCORE = 48
export const TIER1_SCORE = 72
export const MIN_RR = 1.2
export const TP_MIN_PCT = 0.75
export const TP_MAX_PCT = 1.8
/** Wall must live across ~1–2 cron ticks (was 12s — almost never true) */
export const WALL_PERSIST_MS = 5_000
export const RETEST_TTL_BARS_5M = 14
/** Was 0.5% — blocked too many alt scalps on normal BTC noise */
export const BTC_SHIELD_PCT = 0.85
export const BTC_SHIELD_MS = 3 * 60_000
