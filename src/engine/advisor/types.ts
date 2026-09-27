/** Compact market snapshot sent to the AI advisor (budget ≈ 3k tokens). */

export interface AdvisorMarket {
  fearGreed: number | null
  fearGreedLabel?: string
  btcTrend: string | null
  btcPrice?: number
  btc24h?: number
  btcDom?: number | null
  btcDomD24h?: number | null
  total3D24h?: number | null
  altRegime?: string | null
  altBias?: string | null
  daily?: { bias: string; confidence: number; pattern?: string }
  news?: { label: string; score: number; top?: string[] }
}

export interface AdvisorTfStructure {
  trend: string
  bos?: string
  bsl?: number | null
  ssl?: number | null
  range?: [number, number]
  zone?: 'premium' | 'discount' | 'mid'
}

export interface AdvisorFocus {
  symbol: string
  price: number
  ch24h: number
  signal?: {
    dir: string | null
    prob: number
    score: number
    style?: string | null
    rsi?: number | null
    sl?: number | null
    tp1?: number | null
    tp2?: number | null
    trend?: string | null
    zones?: string[]
    grade?: string
    ready?: boolean
    missing?: string[]
  }
  structure?: {
    bias: string
    confidence: number
    side: string | null
    held: boolean
    summary: string
    factors?: string[]
    magnet?: number | null
    invalidation?: number | null
    fuel?: number | null
    tf?: Partial<Record<'h1' | 'h4' | 'd1' | 'w1', AdvisorTfStructure>>
    intra?: string
    zones?: string
    scenario?: string
    trap?: string
  }
  zone141?: {
    state: string
    bias: string | null
    top: number
    bottom: number
    touches?: number
    stop?: number
    note?: string
  }
  brief?: {
    now: string
    tf: Record<'w' | 'd' | 'h4' | 'h1', string>
    plans?: Array<{
      style: string
      side: string
      prob: number
      zone: [number, number]
      target: number
      invalidation: number
    }>
  }
  radar?: AdvisorRadarRow
}

export interface AdvisorRadarRow {
  s: string
  px: number
  trig: string
  d141: number | null
  side: string | null
  score: number
  gap: number
  rs: string
  liq: string
  test: string
  bias: string
  news?: boolean
}

export interface AdvisorTrade {
  id: string
  s: string
  dir: string
  status: string
  entry: number
  px: number
  sl: number
  tp1: number
  tp2?: number | null
  pnl: number
  conf: number
  style?: string | null
  inv?: number | null
  ageMin: number
  last?: string
}

export interface AdvisorJournal {
  total: number
  resolved: number
  wr: number
  avgR: number
  expR: number
  pf: number
  setups?: Array<{ setup: string; n: number; wr: number; avgR: number }>
  insights?: string[]
}

export interface AdvisorSnapshot {
  t: string
  focusTradeId?: string
  market: AdvisorMarket
  focus?: AdvisorFocus
  radar?: { scannedAt?: string; rows: AdvisorRadarRow[] }
  trades?: AdvisorTrade[]
  journal?: AdvisorJournal
}

export interface AdvisorSnapshotResult {
  snapshot: AdvisorSnapshot
  json: string
  chars: number
  approxTokens: number
  /** Trim steps applied to fit the budget */
  trimmed: string[]
}
