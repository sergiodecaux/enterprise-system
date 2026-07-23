import type { CoinSignal, MemeSignal } from '../types'
import { classifyMemeSetup, classifySmcSetup } from './classify'
import { calcPnlAndR } from './stats'
import type { JournalOutcome, SignalJournalEntry } from './types'
import {
  findOpenDuplicate,
  loadJournal,
  saveJournal,
  upsertJournalEntry,
} from './storage'

export type {
  SignalJournalEntry,
  JournalAnalytics,
  JournalSetupType,
  JournalOutcome,
  JournalSource,
  SetupStats,
  ImprovementInsight,
  ConfidenceBucketStats,
} from './types'
export { SETUP_LABELS } from './classify'
export { computeJournalAnalytics, calcPnlAndR } from './stats'
export {
  loadJournal,
  saveJournal,
  clearJournal,
  getAnalytics,
  findOpenDuplicate,
} from './storage'

const MIN_MEME_HEAT_TO_LOG = 55
const MIN_SMC_CONF_TO_LOG = 65

function newId(): string {
  return crypto.randomUUID()
}

export function recordMemeSignal(
  meme: MemeSignal,
  levels: { sl: number; tp1: number; tp2: number | null; direction: 'LONG' | 'SHORT' },
  confidence: number
): SignalJournalEntry | null {
  if (!levels.direction || !levels.sl || !levels.tp1) return null
  if (meme.heatScore < MIN_MEME_HEAT_TO_LOG && confidence < MIN_SMC_CONF_TO_LOG) {
    return null
  }

  const { setupType, setupTag } = classifyMemeSetup(meme)
  let entries = loadJournal()
  const dup = findOpenDuplicate(entries, {
    internalSymbol: meme.internalSymbol,
    direction: levels.direction,
    setupType,
  })
  if (dup) {
    // Refresh confidence / levels on duplicate
    const updated: SignalJournalEntry = {
      ...dup,
      confidenceAtSignal: Math.max(dup.confidenceAtSignal, confidence),
      entryPrice: meme.price,
      sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      setupTag,
    }
    entries = upsertJournalEntry(entries, updated)
    saveJournal(entries)
    return updated
  }

  const entry: SignalJournalEntry = {
    id: newId(),
    symbol: meme.symbol,
    internalSymbol: meme.internalSymbol,
    displayName: meme.displayName,
    direction: levels.direction,
    source: 'MEME',
    setupType,
    setupTag,
    tradeStyle: 'SCALP',
    confidenceAtSignal: confidence,
    entryPrice: meme.price,
    sl: levels.sl,
    tp1: levels.tp1,
    tp2: levels.tp2,
    createdAt: Date.now(),
    status: 'OPEN',
    resolvedAt: null,
    exitPrice: null,
    pnlPercent: null,
    rMultiple: null,
    mfePercent: 0,
    maePercent: 0,
    linkedTradeId: null,
    mmStatus: meme.absorptionAlert?.type === 'DISTRIBUTION' ? 'DISTRIBUTION' : null,
    isMeme: true,
    factors: [setupTag, meme.quality].filter(Boolean),
    resolveSource: null,
    notes: null,
  }

  entries = upsertJournalEntry(entries, entry)
  saveJournal(entries)
  return entry
}

export function recordCoinSignal(
  signal: CoinSignal,
  confidence: number
): SignalJournalEntry | null {
  if (!signal.direction || signal.sl == null || signal.tp1 == null) return null
  if (confidence < MIN_SMC_CONF_TO_LOG && !signal.memePulse) return null

  const classified = classifySmcSetup(signal)
  let entries = loadJournal()
  const dup = findOpenDuplicate(entries, {
    internalSymbol: signal.internalSymbol,
    direction: signal.direction,
    setupType: classified.setupType,
  })
  if (dup) {
    const updated: SignalJournalEntry = {
      ...dup,
      confidenceAtSignal: Math.max(dup.confidenceAtSignal, confidence),
      entryPrice: signal.price,
      sl: signal.sl,
      tp1: signal.tp1,
      tp2: signal.tp2,
      setupTag: classified.setupTag,
    }
    entries = upsertJournalEntry(entries, updated)
    saveJournal(entries)
    return updated
  }

  const entry: SignalJournalEntry = {
    id: newId(),
    symbol: signal.symbol,
    internalSymbol: signal.internalSymbol,
    displayName: signal.displayName,
    direction: signal.direction,
    source: classified.source,
    setupType: classified.setupType,
    setupTag: classified.setupTag,
    tradeStyle: signal.tradeStyle ?? null,
    confidenceAtSignal: confidence,
    entryPrice: signal.ltfChoCH?.surgicalEntryPrice ?? signal.price,
    sl: signal.sl,
    tp1: signal.tp1,
    tp2: signal.tp2,
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
    isMeme: !!signal.memePulse,
    factors: signal.zones.slice(0, 4),
    resolveSource: null,
    notes: null,
  }

  entries = upsertJournalEntry(entries, entry)
  saveJournal(entries)
  return entry
}

export function linkTradeToJournal(
  tradeId: string,
  params: {
    internalSymbol: string
    direction: 'LONG' | 'SHORT'
    entryPrice: number
    isMeme?: boolean
  }
): void {
  let entries = loadJournal()
  const open = entries
    .filter(
      (e) =>
        e.status === 'OPEN' &&
        e.internalSymbol === params.internalSymbol &&
        e.direction === params.direction
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0]

  if (!open) return
  const updated: SignalJournalEntry = {
    ...open,
    linkedTradeId: tradeId,
    entryPrice: params.entryPrice,
    isMeme: params.isMeme ?? open.isMeme,
  }
  entries = upsertJournalEntry(entries, updated)
  saveJournal(entries)
}

export function resolveJournalByTrade(
  tradeId: string,
  outcome: 'WIN' | 'LOSS' | 'MANUAL',
  exitPrice: number
): void {
  let entries = loadJournal()
  const entry = entries.find((e) => e.linkedTradeId === tradeId && e.status === 'OPEN')
  if (!entry) return

  const status: JournalOutcome =
    outcome === 'WIN' ? 'WIN' : outcome === 'LOSS' ? 'LOSS' : 'MANUAL'
  const { pnlPercent, rMultiple } = calcPnlAndR({
    direction: entry.direction,
    entry: entry.entryPrice,
    exit: exitPrice,
    sl: entry.sl,
  })

  const updated: SignalJournalEntry = {
    ...entry,
    status,
    resolvedAt: Date.now(),
    exitPrice,
    pnlPercent,
    rMultiple,
    resolveSource: 'TRADE',
  }
  entries = upsertJournalEntry(entries, updated)
  saveJournal(entries)
}

export function resolveJournalEntry(
  id: string,
  patch: Partial<SignalJournalEntry>
): SignalJournalEntry | null {
  let entries = loadJournal()
  const entry = entries.find((e) => e.id === id)
  if (!entry) return null
  const updated = { ...entry, ...patch }
  entries = upsertJournalEntry(entries, updated)
  saveJournal(entries)
  return updated
}

/** TTL по стилю для авто-таймаута */
export function journalTimeoutMs(entry: SignalJournalEntry): number {
  if (entry.isMeme || entry.tradeStyle === 'SCALP') return 4 * 60 * 60 * 1000
  if (entry.tradeStyle === 'SWING') return 72 * 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}
