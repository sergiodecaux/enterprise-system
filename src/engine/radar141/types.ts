export type TriggerState =
  | 'APPROACH_141'
  | 'INSIDE_141'
  | 'EXIT_141'
  | 'IN_GAP'

export type RsLabel = 'STRONG' | 'WEAK' | 'NEUTRAL'
export type LiquidityGrade = 'A' | 'B' | 'C' | 'D'
export type VolRegime = 'OK' | 'THIN' | 'CHOP'
export type TestKind = 'FIRST' | 'RETEST' | 'EXHAUSTED' | 'NONE'

export interface Radar141Filters {
  topLiquidityOnly: boolean
  minGapPct: number
  minGapAtr: number
  maxDist141Pct: number
  minAtrPct: number
  excludeNewsRisk: boolean
}

export const DEFAULT_RADAR141_FILTERS: Radar141Filters = {
  topLiquidityOnly: true,
  minGapPct: 3,
  minGapAtr: 2,
  maxDist141Pct: 0.8,
  minAtrPct: 0.35,
  excludeNewsRisk: true,
}

export interface GapCard {
  side: 'UP' | 'DOWN'
  upper: { price: number; label: string; tf: string }
  lower: { price: number; label: string; tf: string }
  gapPct: number
  gapAtr: number
  clutter: number
  freePathScore: number
  flyProb: number
  plan: {
    retest: string
    breakout: string
    invalidation: string
  }
}

export interface CoinGapStats {
  flights: number
  avgFlightPct: number
  false141Exits: number
  bestSession: string | null
  lastUpdated: number
}

export interface Radar141Row {
  symbol: string
  internalSymbol: string
  displayName: string
  price: number
  change24h: number
  dist141Pct: number | null
  dist141Atr: number | null
  gapPct: number
  gapAtr: number
  freePathScore: number
  liquidityGrade: LiquidityGrade
  liquidityOk: boolean
  volume24h: number
  atrPct: number
  volRegime: VolRegime
  trigger: TriggerState
  triggerLabel: string
  rsBtc1d: number
  rsBtc4h: number
  rsMarket: number
  rsLabel: RsLabel
  trendAlign: boolean
  htfBias: 'LONG' | 'SHORT' | 'FLAT'
  opportunityScore: number
  scoreWhy: string
  preferredSide: 'LONG' | 'SHORT' | null
  expectedTravel: number
  gap: GapCard | null
  minutesInZone: number | null
  testKind: TestKind
  newsRisk: boolean
  newsNote: string | null
  stats: CoinGapStats
  updatedAt: number
}

export interface Radar141Meta {
  scanning: boolean
  progress: string
  lastScanAt: number | null
  universeSize: number
  error: string | null
}
