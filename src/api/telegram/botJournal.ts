/**
 * Bot journal types + fetch from Cloudflare Worker for Lab sync.
 */

export interface BotJournalEntryDto {
  id: string
  symbol: string
  displayName: string
  side: 'LONG' | 'SHORT'
  alertType: 'SNIPER' | 'MEME'
  setup: string
  score: number
  entryPrice: number
  sl: number
  tp: number
  invalidate: number
  createdAt: number
  expiresAt: number
  status: 'OPEN' | 'WIN' | 'LOSS' | 'TIMEOUT' | 'INVALIDATED'
  resolvedAt: number | null
  exitPrice: number | null
  pnlPercent: number | null
  rMultiple: number | null
  mfePercent: number
  maePercent: number
  dedupeKey: string
  resolveSource: 'AUTO' | 'TIMEOUT' | null
}

export interface BotSetupStatsDto {
  setup: string
  alertType: 'SNIPER' | 'MEME' | 'ALL'
  total: number
  wins: number
  losses: number
  timeouts: number
  open: number
  winRate: number
  avgR: number
  avgPnl: number
  avgMfe: number
  avgMae: number
  expectancyR: number
}

export interface BotJournalInsightDto {
  id: string
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'POSITIVE'
  title: string
  detail: string
  setup?: string
}

export interface BotAdaptiveGatesDto {
  minMemeScore: number
  minSniperScore: number
  blockedSetups: string[]
  boostedSetups: string[]
  requireHighBrokenForSqueeze: boolean
  updatedAt: number
  sampleSize: number
}

export interface BotJournalAnalyticsDto {
  total: number
  resolved: number
  wins: number
  losses: number
  timeouts: number
  open: number
  winRate: number
  avgR: number
  avgPnl: number
  bySetup: BotSetupStatsDto[]
  byAlertType: BotSetupStatsDto[]
  insights: BotJournalInsightDto[]
  updatedAt: number
}

export interface BotJournalPayload {
  analytics: BotJournalAnalyticsDto
  entries: BotJournalEntryDto[]
  gates: BotAdaptiveGatesDto
}

const CACHE_KEY = 'enterprise_bot_journal_cache'

export function loadCachedBotJournal(): BotJournalPayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as BotJournalPayload
  } catch {
    return null
  }
}

export function saveCachedBotJournal(payload: BotJournalPayload): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
  } catch {
    /* ignore */
  }
}

function getProxyBase(): string {
  const envUrl = import.meta.env.VITE_MEXC_PROXY_URL as string | undefined
  if (envUrl && envUrl.trim()) return envUrl.replace(/\/$/, '')
  return ''
}

export async function fetchBotJournal(): Promise<BotJournalPayload | null> {
  const base = getProxyBase()
  if (!base) return loadCachedBotJournal()
  try {
    const res = await fetch(`${base}/telegram/journal`)
    if (!res.ok) return loadCachedBotJournal()
    const data = (await res.json()) as {
      ok?: boolean
      analytics: BotJournalAnalyticsDto
      entries: BotJournalEntryDto[]
      gates: BotAdaptiveGatesDto
    }
    if (!data.analytics) return loadCachedBotJournal()
    const payload: BotJournalPayload = {
      analytics: data.analytics,
      entries: data.entries ?? [],
      gates: data.gates,
    }
    saveCachedBotJournal(payload)
    return payload
  } catch {
    return loadCachedBotJournal()
  }
}
