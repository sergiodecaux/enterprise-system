/** Журнал отработки сигналов — факты для улучшения движка */

export type JournalSource = 'MEME' | 'SMC' | 'SNIPER' | 'MANUAL'

export type JournalSetupType =
  | 'SQUEEZE'
  | 'FLATLINE'
  | 'BACKSIDE'
  | 'CVD_TRAP'
  | 'ABSORPTION'
  | 'LIQUIDITY_RAID'
  | 'MEAN_REVERSION'
  | 'VOLUME_SPIKE'
  | 'SPREAD_PRESSURE'
  | 'SCALP_SMC'
  | 'INTRADAY_SMC'
  | 'SWING_SMC'
  | 'UNKNOWN'

export type JournalOutcome =
  | 'OPEN'
  | 'WIN'
  | 'LOSS'
  | 'TIMEOUT'
  | 'INVALIDATED'
  | 'MANUAL'

export interface SignalJournalEntry {
  id: string
  symbol: string
  internalSymbol: string
  displayName: string
  direction: 'LONG' | 'SHORT'
  source: JournalSource
  setupType: JournalSetupType
  setupTag: string
  tradeStyle: 'SCALP' | 'INTRADAY' | 'SWING' | null
  confidenceAtSignal: number
  entryPrice: number
  sl: number
  tp1: number
  tp2: number | null
  createdAt: number
  status: JournalOutcome
  resolvedAt: number | null
  exitPrice: number | null
  /** Realized PnL % from entry to exit */
  pnlPercent: number | null
  /** R-multiple: pnl / risk */
  rMultiple: number | null
  /** Max favorable excursion % while OPEN */
  mfePercent: number
  /** Max adverse excursion % while OPEN */
  maePercent: number
  linkedTradeId: string | null
  mmStatus: string | null
  isMeme: boolean
  factors: string[]
  /** How resolved: auto price check / trade close / timeout */
  resolveSource: 'AUTO' | 'TRADE' | 'TIMEOUT' | 'MANUAL' | null
  notes: string | null
}

export interface SetupStats {
  setupType: JournalSetupType
  total: number
  wins: number
  losses: number
  timeouts: number
  open: number
  winRate: number
  avgR: number
  avgPnl: number
  avgConfidence: number
  avgMfe: number
  avgMae: number
  expectancyR: number
}

export interface ConfidenceBucketStats {
  label: string
  min: number
  max: number
  total: number
  wins: number
  winRate: number
  avgR: number
}

export interface ImprovementInsight {
  id: string
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'POSITIVE'
  title: string
  detail: string
  setupType?: JournalSetupType
}

export interface JournalAnalytics {
  total: number
  resolved: number
  open: number
  wins: number
  losses: number
  timeouts: number
  winRate: number
  avgR: number
  expectancyR: number
  avgPnl: number
  profitFactor: number
  bySetup: SetupStats[]
  bySource: Array<{
    source: JournalSource
    total: number
    winRate: number
    avgR: number
  }>
  byConfidence: ConfidenceBucketStats[]
  insights: ImprovementInsight[]
  recent: SignalJournalEntry[]
}
