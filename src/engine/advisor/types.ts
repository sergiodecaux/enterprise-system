/** Compact market snapshot sent to the AI advisor (budget ≈ 3k tokens, more for coin/trade). */
import type { OhlcvCandle } from '../../api/mexc'
import type { LiqHeatmapModel } from '../derivatives/liqHeatmap'
import type { MacroOutlookContext } from '../prediction/macroOutlook'
import type { PriceForecast } from '../prediction/types'
import type { ConditionalSetup, TradeGlobalView, TradeMagnet } from '../setups/types'
import type { LiveSignalResult } from '../trades/findLiveSignal'
import type { DirectionConsensus } from '../trend/directionConsensus'

/** Raw state of the open chart, published by LiveChart for the advisor. */
export interface AdvisorChartInput {
  timeframe: string
  horizon: string
  candles: OhlcvCandle[]
  forecast: PriceForecast | null
  consensus: DirectionConsensus | null
  liveSignal: LiveSignalResult | null
  setups: ConditionalSetup[]
  globalView: TradeGlobalView | null
  magnet: TradeMagnet | null
  liq: LiqHeatmapModel | null
  macro: MacroOutlookContext | null
  updatedAt: number
}

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
  chart?: AdvisorChart
  flow?: AdvisorFlow
  smc?: AdvisorSmcExtra
  session?: AdvisorSession
  composite?: AdvisorComposite
}

/** [high, low, close, volume ÷ avg20] */
export type AdvisorBar = [number, number, number, number]

export interface AdvisorScenario {
  id: string
  type: string
  prob: number
  entry: number | null
  target: number | null
  inv: number | null
  rr?: number | null
  trigger?: string
  why?: string[]
}

export interface AdvisorSetup {
  side: string
  title: string
  prob: number
  status: string
  zone: [number, number]
  entry: number | null
  target: number | null
  inv: number | null
  ladder?: [number, number, number]
  pReach?: [number, number, number]
  trigger?: string
  pending?: string[]
}

export interface AdvisorChart {
  tf: string
  horizon?: string
  ageSec: number
  stats?: {
    bars: number
    chgPct: number | null
    hi: number | null
    lo: number | null
    atrPct: number | null
    volX: number | null
  }
  bars?: AdvisorBar[]
  mtf?: Record<'d' | 'h4' | 'h1', string> & { strength: string; target?: string }
  forecast?: { dominant: string; macro?: string; scenarios: AdvisorScenario[] }
  consensus?: { bias: string; conf: number; summary?: string; votes?: string[] }
  live?: {
    phase: string
    primary: string
    summary?: string
    inv?: string
    alts?: string[]
    drive?: string
    smc?: string[]
    now?: string
  }
  view?: { bias: string; summary?: string; magnet?: string }
  setups?: AdvisorSetup[]
  liq?: {
    label?: string
    longLiqBelow: number | null
    shortLiqAbove: number | null
    longClusters?: number[]
    shortClusters?: number[]
    tapeBuy: number | null
    tapeSell: number | null
  }
  macro?: string
}

export interface AdvisorFlow {
  book?: {
    obi: number | null
    pressure: string
    spreadPct: number | null
    walls?: string[]
    shift?: string
  }
  cvd?: { src: string; trend: string; buyPct: number; div?: string }
  tape?: { signal: string; pressure: string; burst: boolean; ticks: number }
  aggression?: { label: string; ratio: number; largeBuys: number }
  whales?: { support?: string; resistance?: string; alerts?: string[] }
  alerts?: string[]
}

export interface AdvisorSmcExtra {
  mm?: {
    drive: string
    conf: number
    side: string | null
    micro?: string
    macro?: string
    stopHunt?: boolean
    why?: string[]
  }
  surgical?: {
    status: string
    side: string
    limit?: number | null
    zone?: [number, number]
    inv?: number | null
    reason?: string
    confirms?: string[]
  }
  ltf?: string[]
  eqLevels?: string[]
  btcDiv?: string
  htf?: string
  regime?: string
  vp?: { poc: number | null; vah: number | null; val: number | null; note?: string }
  liqGate?: string
  globalFib?: string
  score?: string[]
  dataQuality?: string
  invalidation?: string
  warnings?: string[]
}

export interface AdvisorSession {
  dna?: string
  po3?: string
  flip?: string
}

export interface AdvisorComposite {
  score: number
  phase: string
  force: string
  vol: string
  advice?: string
  warnings?: string[]
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
