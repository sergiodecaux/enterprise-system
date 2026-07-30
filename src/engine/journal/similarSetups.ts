/**
 * Historical WR for similar setups on a coin (local journal).
 */

import { loadJournal } from './storage'
import type {
  JournalSetupType,
  SignalJournalEntry,
} from './types'

const DAY = 24 * 60 * 60 * 1000

export interface SimilarSetupsQuery {
  internalSymbol: string
  direction?: 'LONG' | 'SHORT' | null
  setupType?: JournalSetupType | null
  tradeStyle?: 'SCALP' | 'INTRADAY' | 'SWING' | null
  /** Lookback window (default 30d) */
  windowMs?: number
  /** Also match same setupType across all coins if coin sample tiny */
  fallbackGlobal?: boolean
}

export interface SimilarSetupsStats {
  total: number
  wins: number
  losses: number
  timeouts: number
  open: number
  /** wins / (wins+losses), null if no decided trades */
  winRate: number | null
  avgR: number | null
  sample: 'COIN' | 'GLOBAL' | 'NONE'
  recent: SignalJournalEntry[]
}

function isWin(e: SignalJournalEntry): boolean {
  return e.status === 'WIN' || (e.status === 'MANUAL' && (e.pnlPercent ?? 0) > 0)
}

function isLoss(e: SignalJournalEntry): boolean {
  return (
    e.status === 'LOSS' ||
    e.status === 'INVALIDATED' ||
    (e.status === 'MANUAL' && (e.pnlPercent ?? 0) <= 0)
  )
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function summarize(
  entries: SignalJournalEntry[],
  sample: SimilarSetupsStats['sample']
): SimilarSetupsStats {
  const wins = entries.filter(isWin)
  const losses = entries.filter(isLoss)
  const timeouts = entries.filter((e) => e.status === 'TIMEOUT')
  const open = entries.filter((e) => e.status === 'OPEN')
  const decided = wins.length + losses.length
  const withR = entries.filter(
    (e) =>
      e.rMultiple != null &&
      (e.status === 'WIN' ||
        e.status === 'LOSS' ||
        e.status === 'INVALIDATED' ||
        e.status === 'MANUAL')
  )
  return {
    total: entries.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    open: open.length,
    winRate: decided > 0 ? (wins.length / decided) * 100 : null,
    avgR: avg(withR.map((e) => e.rMultiple!)),
    sample,
    recent: [...entries]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5),
  }
}

function matchFilters(
  e: SignalJournalEntry,
  q: SimilarSetupsQuery,
  now: number
): boolean {
  const windowMs = q.windowMs ?? 30 * DAY
  if (now - e.createdAt > windowMs) return false
  if (q.direction && e.direction !== q.direction) return false
  if (q.setupType && e.setupType !== q.setupType) return false
  if (q.tradeStyle && e.tradeStyle && e.tradeStyle !== q.tradeStyle) return false
  return true
}

/**
 * Query local journal for similar setups.
 * Prefer same coin; if &lt; 3 decided, optionally fall back to global same setupType.
 */
export function querySimilarSetups(q: SimilarSetupsQuery): SimilarSetupsStats {
  const now = Date.now()
  const all = loadJournal()
  const coin = all.filter(
    (e) =>
      e.internalSymbol === q.internalSymbol && matchFilters(e, q, now)
  )
  const coinStats = summarize(coin, coin.length ? 'COIN' : 'NONE')
  const allowGlobal = q.fallbackGlobal !== false
  if ((coinStats.wins + coinStats.losses) >= 3 || !allowGlobal) {
    return coinStats.total ? coinStats : summarize([], 'NONE')
  }

  if (allowGlobal && q.setupType) {
    const global = all.filter(
      (e) =>
        e.internalSymbol !== q.internalSymbol &&
        matchFilters(e, { ...q, internalSymbol: e.internalSymbol }, now)
    )
    if (global.length > 0) {
      return summarize([...coin, ...global], coin.length ? 'COIN' : 'GLOBAL')
    }
  }

  return coinStats
}
