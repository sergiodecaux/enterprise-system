import type { SignalJournalEntry } from './types'
import { computeJournalAnalytics } from './stats'
import type { JournalAnalytics } from './types'

const STORAGE_KEY = 'enterprise_signal_journal'
const MAX_ENTRIES = 500
const RETENTION_MS = 60 * 24 * 60 * 60 * 1000 // 60 days

export function loadJournal(): SignalJournalEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SignalJournalEntry[]
    if (!Array.isArray(parsed)) return []
    const cutoff = Date.now() - RETENTION_MS
    return parsed.filter((e) => e.createdAt >= cutoff).slice(-MAX_ENTRIES)
  } catch {
    return []
  }
}

export function saveJournal(entries: SignalJournalEntry[]): void {
  try {
    const cutoff = Date.now() - RETENTION_MS
    const trimmed = entries
      .filter((e) => e.createdAt >= cutoff)
      .slice(-MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    /* quota / private mode */
  }
}

export function upsertJournalEntry(
  entries: SignalJournalEntry[],
  entry: SignalJournalEntry
): SignalJournalEntry[] {
  const idx = entries.findIndex((e) => e.id === entry.id)
  if (idx >= 0) {
    const next = entries.slice()
    next[idx] = entry
    return next
  }
  return [...entries, entry]
}

export function findOpenDuplicate(
  entries: SignalJournalEntry[],
  params: {
    internalSymbol: string
    direction: 'LONG' | 'SHORT'
    setupType: string
    windowMs?: number
  }
): SignalJournalEntry | undefined {
  const windowMs = params.windowMs ?? 30 * 60 * 1000
  const now = Date.now()
  return entries.find(
    (e) =>
      e.status === 'OPEN' &&
      e.internalSymbol === params.internalSymbol &&
      e.direction === params.direction &&
      e.setupType === params.setupType &&
      now - e.createdAt < windowMs
  )
}

export function getAnalytics(entries: SignalJournalEntry[]): JournalAnalytics {
  return computeJournalAnalytics(entries)
}

export function clearJournal(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
