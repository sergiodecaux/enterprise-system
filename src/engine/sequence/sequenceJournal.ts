/**
 * Local journal feedback for Remizov sequences (client-only).
 */

import {
  findOpenDuplicate,
  loadJournal,
  saveJournal,
  upsertJournalEntry,
} from '../journal/storage'
import { querySimilarSetups } from '../journal/similarSetups'
import type { JournalSetupType, SignalJournalEntry } from '../journal/types'
import type { SequenceHit, SequenceKind } from './types'

const MIN_CONF_TO_LOG = 58

export function sequenceKindToSetupType(kind: SequenceKind): JournalSetupType {
  switch (kind) {
    case 'WALL_ABSORPTION_EXHAUSTION':
      return 'SEQUENCE_ABSORB'
    case 'CVD_DIVERGENCE_LIMIT':
      return 'SEQUENCE_CVD_DIV'
    case 'WALL_RELEASE':
      return 'SEQUENCE_WALL_RELEASE'
    case 'OI_DELTA_CONFIRM':
      return 'SEQUENCE_OI_CONFIRM'
    default:
      return 'UNKNOWN'
  }
}

export function applySequenceHistWr(
  hit: SequenceHit,
  internalSymbol?: string
): SequenceHit {
  const setupType = sequenceKindToSetupType(hit.kind)
  const stats = querySimilarSetups({
    internalSymbol: internalSymbol || hit.id.split('_')[0] || '_',
    direction: hit.side,
    setupType,
    windowMs: 45 * 24 * 60 * 60 * 1000,
    fallbackGlobal: true,
  })

  // Prefer coin-agnostic global for sequences (thin samples per coin)
  const decided = stats.wins + stats.losses
  const winRate = stats.winRate
  let deltaPct = 0
  let reason = 'Нет истории sequence'

  if (decided >= 3 && winRate != null) {
    if (winRate >= 58) {
      deltaPct = Math.min(8, Math.round((winRate - 55) / 3))
      reason = `Hist WR ${winRate.toFixed(0)}% (n=${decided}) · boost`
    } else if (winRate < 42) {
      deltaPct = -12
      reason = `Hist WR ${winRate.toFixed(0)}% (n=${decided}) · demote`
    } else {
      reason = `Hist WR ${winRate.toFixed(0)}% (n=${decided})`
    }
  }

  const confidence = Math.round(
    Math.min(92, Math.max(35, hit.confidence + deltaPct))
  )

  return {
    ...hit,
    confidence,
    histWr: {
      winRate,
      decided,
      deltaPct,
      reason,
    },
  }
}

export function recordSequenceHit(opts: {
  symbol: string
  flatSymbol: string
  displayName?: string
  price: number
  hit: SequenceHit
  sl?: number | null
  tp1?: number | null
}): SignalJournalEntry | null {
  const { hit } = opts
  if (hit.confidence < MIN_CONF_TO_LOG) return null
  if (!hit.allowedInRegime) return null

  const setupType = sequenceKindToSetupType(hit.kind)
  const riskPct = 0.012
  const rewardPct = 0.022
  const sl =
    opts.sl != null && opts.sl > 0
      ? opts.sl
      : hit.side === 'LONG'
        ? opts.price * (1 - riskPct)
        : opts.price * (1 + riskPct)
  const tp1 =
    opts.tp1 != null && opts.tp1 > 0
      ? opts.tp1
      : hit.side === 'LONG'
        ? opts.price * (1 + rewardPct)
        : opts.price * (1 - rewardPct)

  let entries = loadJournal()
  const dup = findOpenDuplicate(entries, {
    internalSymbol: opts.symbol,
    direction: hit.side,
    setupType,
  })
  if (dup) {
    const updated: SignalJournalEntry = {
      ...dup,
      confidenceAtSignal: Math.max(dup.confidenceAtSignal, hit.confidence),
      entryPrice: opts.price,
      sl,
      tp1,
      setupTag: hit.kind,
      notes: hit.summary.slice(0, 180),
    }
    entries = upsertJournalEntry(entries, updated)
    saveJournal(entries)
    return updated
  }

  const entry: SignalJournalEntry = {
    id: crypto.randomUUID(),
    symbol: opts.flatSymbol,
    internalSymbol: opts.symbol,
    displayName: opts.displayName ?? opts.flatSymbol,
    direction: hit.side,
    source: 'SNIPER',
    setupType,
    setupTag: hit.kind,
    tradeStyle: 'SCALP',
    confidenceAtSignal: hit.confidence,
    entryPrice: opts.price,
    sl,
    tp1,
    tp2: null,
    createdAt: Date.now(),
    status: 'OPEN',
    resolvedAt: null,
    exitPrice: null,
    pnlPercent: null,
    rMultiple: null,
    mfePercent: 0,
    maePercent: 0,
    linkedTradeId: null,
    mmStatus: null,
    isMeme: false,
    factors: [hit.kind, hit.regime, `frames:${hit.framesUsed}`],
    resolveSource: null,
    notes: hit.summary.slice(0, 220),
  }

  entries = upsertJournalEntry(entries, entry)
  saveJournal(entries)
  return entry
}
