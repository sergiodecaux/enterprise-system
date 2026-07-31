/**
 * Per-symbol MACRO memory — recent analyses + outcomes so the bot
 * does not flip-flop or re-enter the same losing pattern.
 */

import type { Side, VaneKv } from './types'

const MEM_PREFIX = 'vane:macro_mem:'

export type MacroContext = 'ZONE' | 'RANGE_BREAK' | 'MOMENTUM'

export interface MacroMemoryEvent {
  at: number
  side: Side
  context: MacroContext
  outcome: 'WIN' | 'LOSS' | 'BE' | 'OPEN' | 'SKIP' | null
  pnlPct?: number
  reason?: string
}

export interface MacroSymbolMemory {
  symbol: string
  updatedAt: number
  lastBias: Side | 'FLAT'
  lastContext: MacroContext | 'SKIP' | null
  lastReason: string
  /** Rolling notes the engine "keeps in mind" */
  notes: string[]
  recent: MacroMemoryEvent[]
  lossStreakLong: number
  lossStreakShort: number
  cooldownUntil: number | null
  cooldownSide: Side | null
}

const MAX_RECENT = 12
const MAX_NOTES = 8
/** Same-side loss streak → pause that side */
const SIDE_LOSS_COOLDOWN_MS = 90 * 60_000
const SIDE_LOSS_STREAK = 2

export function emptyMacroMemory(symbol: string): MacroSymbolMemory {
  return {
    symbol,
    updatedAt: Date.now(),
    lastBias: 'FLAT',
    lastContext: null,
    lastReason: '',
    notes: [],
    recent: [],
    lossStreakLong: 0,
    lossStreakShort: 0,
    cooldownUntil: null,
    cooldownSide: null,
  }
}

export async function loadMacroMemory(
  kv: VaneKv | undefined,
  symbol: string
): Promise<MacroSymbolMemory> {
  if (!kv) return emptyMacroMemory(symbol)
  try {
    const raw = await kv.get(MEM_PREFIX + symbol)
    if (!raw) return emptyMacroMemory(symbol)
    const parsed = JSON.parse(raw) as MacroSymbolMemory
    return {
      ...emptyMacroMemory(symbol),
      ...parsed,
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-MAX_RECENT) : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes.slice(-MAX_NOTES) : [],
    }
  } catch {
    return emptyMacroMemory(symbol)
  }
}

export async function saveMacroMemory(
  kv: VaneKv | undefined,
  mem: MacroSymbolMemory
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(MEM_PREFIX + mem.symbol, JSON.stringify(mem))
  } catch {
    /* quota */
  }
}

export function memoryAllowsTrade(
  mem: MacroSymbolMemory,
  side: Side,
  now = Date.now()
): { ok: boolean; reason: string; tags: string[] } {
  const tags: string[] = []
  if (mem.cooldownUntil != null && mem.cooldownUntil > now) {
    if (mem.cooldownSide == null || mem.cooldownSide === side) {
      return {
        ok: false,
        reason: 'mem_cooldown',
        tags: [`CD_${Math.ceil((mem.cooldownUntil - now) / 60_000)}m`],
      }
    }
  }
  const streak = side === 'LONG' ? mem.lossStreakLong : mem.lossStreakShort
  if (streak >= SIDE_LOSS_STREAK) {
    return { ok: false, reason: 'mem_side_loss_streak', tags: [`LOSS×${streak}`] }
  }
  // Avoid instant flip against last OPEN/recent WIN opposite
  const lastOpen = mem.recent.find((e) => e.outcome === 'OPEN')
  if (lastOpen && lastOpen.side !== side && now - lastOpen.at < 20 * 60_000) {
    return { ok: false, reason: 'mem_opposite_open', tags: ['ANTI_FLIP'] }
  }
  if (mem.lastBias === side) tags.push('MEM_CONT')
  if (mem.notes.length) tags.push(`HIST×${mem.notes.length}`)
  return { ok: true, reason: 'mem_ok', tags }
}

export async function rememberMacroAnalysis(
  kv: VaneKv | undefined,
  opts: {
    symbol: string
    side: Side | 'FLAT'
    context: MacroContext | 'SKIP'
    reason: string
    note?: string
  }
): Promise<void> {
  const mem = await loadMacroMemory(kv, opts.symbol)
  mem.updatedAt = Date.now()
  mem.lastBias = opts.side
  mem.lastContext = opts.context
  mem.lastReason = opts.reason
  if (opts.note) {
    mem.notes = [...mem.notes, opts.note].slice(-MAX_NOTES)
  }
  if (opts.context !== 'SKIP' && opts.side !== 'FLAT') {
    mem.recent = [
      ...mem.recent,
      {
        at: Date.now(),
        side: opts.side,
        context: opts.context,
        outcome: 'OPEN',
        reason: opts.reason,
      },
    ].slice(-MAX_RECENT)
  }
  await saveMacroMemory(kv, mem)
}

export async function rememberMacroOutcome(
  kv: VaneKv | undefined,
  opts: {
    symbol: string
    side: Side
    pnlPct: number | null
    isLoss: boolean
    isWin: boolean
  }
): Promise<void> {
  const mem = await loadMacroMemory(kv, opts.symbol)
  mem.updatedAt = Date.now()
  const outcome: MacroMemoryEvent['outcome'] = opts.isWin
    ? 'WIN'
    : opts.isLoss
      ? 'LOSS'
      : 'BE'
  // Close latest OPEN for side, or append
  let closed = false
  for (let i = mem.recent.length - 1; i >= 0; i--) {
    const e = mem.recent[i]!
    if (e.side === opts.side && e.outcome === 'OPEN') {
      e.outcome = outcome
      e.pnlPct = opts.pnlPct ?? undefined
      closed = true
      break
    }
  }
  if (!closed) {
    mem.recent.push({
      at: Date.now(),
      side: opts.side,
      context: (mem.lastContext as MacroContext) ?? 'MOMENTUM',
      outcome,
      pnlPct: opts.pnlPct ?? undefined,
    })
    mem.recent = mem.recent.slice(-MAX_RECENT)
  }

  if (opts.isLoss) {
    if (opts.side === 'LONG') mem.lossStreakLong++
    else mem.lossStreakShort++
    const streak =
      opts.side === 'LONG' ? mem.lossStreakLong : mem.lossStreakShort
    if (streak >= SIDE_LOSS_STREAK) {
      mem.cooldownUntil = Date.now() + SIDE_LOSS_COOLDOWN_MS
      mem.cooldownSide = opts.side
      mem.notes = [
        ...mem.notes,
        `${opts.side} LOSS×${streak} → cooldown 90m`,
      ].slice(-MAX_NOTES)
    }
  } else if (opts.isWin) {
    if (opts.side === 'LONG') mem.lossStreakLong = 0
    else mem.lossStreakShort = 0
    if (mem.cooldownSide === opts.side) {
      mem.cooldownUntil = null
      mem.cooldownSide = null
    }
    mem.notes = [
      ...mem.notes,
      `${opts.side} WIN ${opts.pnlPct?.toFixed(2) ?? ''}%`,
    ].slice(-MAX_NOTES)
  }

  await saveMacroMemory(kv, mem)
}

/** Short text block for TG / decision reasons */
export function memorySummary(mem: MacroSymbolMemory): string {
  const wins = mem.recent.filter((e) => e.outcome === 'WIN').length
  const losses = mem.recent.filter((e) => e.outcome === 'LOSS').length
  const last = mem.notes.slice(-2).join(' · ') || mem.lastReason || '—'
  return `Память: W${wins}/L${losses} · last ${mem.lastBias}/${mem.lastContext ?? '—'} · ${last}`
}
