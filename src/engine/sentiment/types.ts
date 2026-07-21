export type NewsSource =
  | 'cryptopanic'
  | 'coindesk'
  | 'cointelegraph'
  | 'decrypt'
  | 'theblock'
  | 'reuters'
  | 'bloomberg'
  | 'unknown'

export type NewsImportanceLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface NewsItem {
  id: string
  title: string
  summary?: string
  url: string
  source: NewsSource
  publishedAt: number
  coins: string[]
  sentiment: SentimentResult
}

export type SentimentLabel = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

export interface SentimentResult {
  label: SentimentLabel
  score: number
  confidence: number
  bullishHits: string[]
  bearishHits: string[]
}

export interface CoinSentiment {
  symbol: string
  score: number
  label: SentimentLabel
  newsCount: number
  items: NewsItem[]
  scoreBoost: number
  lastUpdate: number
}

export type FearGreedLabel =
  | 'Extreme Fear'
  | 'Fear'
  | 'Neutral'
  | 'Greed'
  | 'Extreme Greed'

export interface FearGreedData {
  value: number
  label: FearGreedLabel
  timestamp: number
  previousValue: number | null
}

export interface NewsIntelState {
  items: NewsItem[]
  fearGreed: FearGreedData | null
  coinSentiments: Record<string, CoinSentiment>
  isLoading: boolean
  lastUpdate: number
  error: string | null
}

export interface NewsSettings {
  enabled: boolean
  showInDrawer: boolean
  showStrip: boolean
  showFearGreed: boolean
  showSentimentBadge: boolean
  maxItems: number
  minImportance: NewsImportanceLevel
  scoreInfluence: boolean
}

export const DEFAULT_NEWS_SETTINGS: NewsSettings = {
  enabled: true,
  showInDrawer: true,
  showStrip: true,
  showFearGreed: true,
  showSentimentBadge: true,
  maxItems: 20,
  minImportance: 'LOW',
  scoreInfluence: true,
}

export const EMPTY_NEWS_INTEL: NewsIntelState = {
  items: [],
  fearGreed: null,
  coinSentiments: {},
  isLoading: false,
  lastUpdate: 0,
  error: null,
}
