/**
 * Walk-forward structure read. Bars that have not closed by `asOfMs`
 * are not passed into composeStructureRead.
 *
 * Week bars are aggregateWeekly(native daily), Monday UTC — the same
 * function useMultiTFAnalysis uses. This client has no Week1 fetch.
 */
import type { OhlcvCandle } from '../../api/mexc'
import { aggregateWeekly, composeStructureRead, findCongestionZones } from '../smc/structureRead'
import { featureVectorOf } from './featureVector'
import type { StructureEvent, StructureRead, TfStructure } from '../smc/structureRead'
import { readCloseQuality } from '../smc/mmTrapThesis'
import { LIVE_WINDOWS } from './config'
import { BAR_MS, type HistoryTf } from './history'
import { labelOutcome, resolvedBefore } from './outcomeLabeler'
import type { EventKind, EventSide, EventTf, HeldSnap, HistorySeries, LabeledEvent } from './types'

const TF_BAR: Record<EventTf, number> = {
  '1h': BAR_MS['1h'],
  '4h': BAR_MS['4h'],
  '1d': BAR_MS['1d'],
  '1w': 7 * BAR_MS['1d'],
}

export interface ClosedBook {
  m15: OhlcvCandle[]
  h1: OhlcvCandle[]
  h4: OhlcvCandle[]
  d1: OhlcvCandle[]
  w1: OhlcvCandle[]
}

export function closedUntil(candles: OhlcvCandle[], barMs: number, asOfMs: number): OhlcvCandle[] {
  const out: OhlcvCandle[] = []
  for (const c of candles) {
    if (c[0] + barMs <= asOfMs) out.push(c)
  }
  return out
}

function tail(candles: OhlcvCandle[], n: number): OhlcvCandle[] {
  return candles.length <= n ? candles : candles.slice(candles.length - n)
}

export function bookAt(series: HistorySeries, asOfMs: number): ClosedBook {
  const d1 = tail(closedUntil(series.d1, BAR_MS['1d'], asOfMs), LIVE_WINDOWS.d1)
  return {
    m15: tail(closedUntil(series.m15, BAR_MS['15m'], asOfMs), LIVE_WINDOWS.m15),
    h1: tail(closedUntil(series.h1, BAR_MS['1h'], asOfMs), LIVE_WINDOWS.h1),
    h4: tail(closedUntil(series.h4, BAR_MS['4h'], asOfMs), LIVE_WINDOWS.h4),
    d1,
    w1: aggregateWeekly(d1),
  }
}

function atr14(candles: OhlcvCandle[]): number {
  if (candles.length < 3) return 0
  const n = Math.min(14, candles.length - 1)
  let sum = 0
  for (let i = candles.length - n; i < candles.length; i++) {
    const prev = candles[i - 1]
    const c = candles[i]
    if (!prev || !c) continue
    sum += Math.max(c[2] - c[3], Math.abs(c[2] - prev[4]), Math.abs(c[3] - prev[4]))
  }
  return n > 0 ? sum / n : 0
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : ((s[m - 1] ?? 0) + s[m]!) / 2
}

function volumeRatio(candles: OhlcvCandle[], timeSec: number): number | null {
  const idx = candles.findIndex((c) => Math.floor(c[0] / 1000) === timeSec)
  if (idx < 1) return null
  const prev = candles.slice(Math.max(0, idx - 20), idx).map((c) => c[5]).filter((v) => v > 0)
  const mid = median(prev)
  const vol = candles[idx]?.[5] ?? 0
  if (!(mid > 0) || !(vol > 0)) return null
  return vol / mid
}

function bodyOf(candles: OhlcvCandle[], timeSec: number, side: EventSide): 'displacement' | 'weak' {
  const c = candles.find((bar) => Math.floor(bar[0] / 1000) === timeSec)
  const q = readCloseQuality(c)
  if (side === 'UP' && q === 'DISPLACEMENT_UP') return 'displacement'
  if (side === 'DOWN' && q === 'DISPLACEMENT_DOWN') return 'displacement'
  return 'weak'
}

function inZone(zones: { top: number; bottom: number }[], price: number): boolean {
  return zones.some((z) => price <= z.top && price >= z.bottom)
}

function candlesOf(book: ClosedBook, tf: EventTf): OhlcvCandle[] {
  if (tf === '1h') return book.h1
  if (tf === '4h') return book.h4
  if (tf === '1d') return book.d1
  return book.w1
}

function higherOf(book: ClosedBook, tf: EventTf): OhlcvCandle[] {
  if (tf === '1h') return book.h4
  if (tf === '4h') return book.d1
  return book.w1
}

function readOne(
  book: ClosedBook,
  tf: EventTf,
  structure: TfStructure | null,
  ev: StructureEvent,
  kind: EventKind
): HeldSnap | null {
  if (!ev.held || !structure) return null
  const candles = candlesOf(book, tf)
  const entry = candles[candles.length - 1]?.[4] ?? 0
  if (!(entry > 0)) return null
  const atr = atr14(candles)
  const targetRaw = ev.side === 'UP' ? structure.nextBsl : structure.nextSsl
  const target =
    targetRaw != null && targetRaw > 0 && (ev.side === 'UP' ? targetRaw > entry : targetRaw < entry)
      ? targetRaw
      : null
  const sweep = structure.lastSweep
  const priorSweep = Boolean(
    sweep &&
      sweep.timeSec < ev.timeSec &&
      ev.timeSec - sweep.timeSec <= 30 * (TF_BAR[tf] / 1000)
  )
  const location = structure.inPremium
    ? 'PREMIUM'
    : structure.inDiscount
      ? 'DISCOUNT'
      : 'EQUILIBRIUM'
  return {
    tf,
    kind,
    side: ev.side,
    level: ev.price,
    timeSec: ev.timeSec,
    target,
    trend: structure.trend,
    location,
    priorSweep,
    volumeRatio: volumeRatio(candles, ev.timeSec),
    body: bodyOf(candles, ev.timeSec, ev.side),
    htfZone: inZone(findCongestionZones(higherOf(book, tf)), entry),
    atr,
    entry,
  }
}

export function snapsFromRead(book: ClosedBook, read: StructureRead): HeldSnap[] {
  const pairs: Array<[EventTf, TfStructure | null]> = [
    ['1h', read.h1],
    ['4h', read.h4],
    ['1d', read.d1],
    ['1w', read.w1],
  ]
  const out: HeldSnap[] = []
  for (const [tf, structure] of pairs) {
    const rows: Array<[EventKind, StructureEvent | null]> = [
      ['BOS', structure?.lastBos ?? null],
      ['CHOCH', structure?.lastChoch ?? null],
      ['RECLAIM', structure?.lastReclaim ?? null],
    ]
    for (const [kind, ev] of rows) {
      if (!ev) continue
      const snap = readOne(book, tf, structure, ev, kind)
      if (snap) out.push(snap)
    }
  }
  return out
}

export function structureAt(symbol: string, book: ClosedBook): StructureRead {
  const price = book.h1[book.h1.length - 1]?.[4] ?? book.d1[book.d1.length - 1]?.[4] ?? 0
  const base = symbol.toUpperCase()
  return composeStructureRead({
    price,
    symbol,
    isBtc: base.startsWith('BTC'),
    candles15m: book.m15.length >= 12 ? book.m15 : undefined,
    candles1h: book.h1.length >= 16 ? book.h1 : undefined,
    candles4h: book.h4.length >= 16 ? book.h4 : undefined,
    candles1d: book.d1.length >= 16 ? book.d1 : undefined,
    candles1w: book.w1.length >= 8 ? book.w1 : undefined,
  })
}

export function snapId(s: HeldSnap): string {
  return `${s.tf}|${s.kind}|${s.timeSec}|${s.level}`
}

function seriesOf(series: HistorySeries, tf: EventTf): OhlcvCandle[] {
  if (tf === '1h') return series.h1
  if (tf === '4h') return series.h4
  if (tf === '1d') return series.d1
  return aggregateWeekly(series.d1)
}

function futureBars(candles: OhlcvCandle[], afterMs: number): OhlcvCandle[] {
  return candles.filter((c) => c[0] >= afterMs)
}

function barsBetween(
  candles: OhlcvCandle[],
  fromMs: number,
  toMs: number,
  barMs: number
): OhlcvCandle[] {
  return candles.filter((c) => c[0] >= fromMs && c[0] + barMs <= toMs)
}

function weekKeyOf(ms: number): number {
  const day = new Date(ms).getUTCDay()
  const mondayOffset = (day + 6) % 7
  const mondayMs = ms - mondayOffset * 86_400_000
  return Math.floor(mondayMs / 86_400_000)
}

interface OpenTrade {
  tf: EventTf
  kind: EventKind
  side: EventSide
  target: number | null
  invalidation: number
  discoveredMs: number
}

export function labelSymbol(
  symbol: string,
  series: HistorySeries,
  holdoutStartMs: number
): LabeledEvent[] {
  const seen = new Set<string>()
  const open = new Map<string, OpenTrade>()
  const labeled: LabeledEvent[] = []
  const h1 = series.h1
  for (let i = 0; i < h1.length; i++) {
    const asOfMs = h1[i]![0] + BAR_MS['1h']
    const book = bookAt(series, asOfMs)
    if (book.h1.length < 40 || book.h4.length < 16) continue
    let read: StructureRead
    try {
      read = structureAt(symbol, book)
    } catch {
      continue
    }
    const snaps = snapsFromRead(book, read)
    for (const snap of snaps) {
      const id = snapId(snap)
      if (seen.has(id)) continue
      seen.add(id)
      const openKey = `${snap.tf}|${snap.kind}|${snap.side}`
      const prev = open.get(openKey)
      if (prev) {
        const between = barsBetween(
          seriesOf(series, snap.tf),
          prev.discoveredMs,
          asOfMs,
          TF_BAR[snap.tf]
        )
        if (!resolvedBefore(prev.side, prev.target, prev.invalidation, between)) continue
      }
      const future = futureBars(seriesOf(series, snap.tf), asOfMs)
      const horizons = labelOutcome({
        side: snap.side,
        entry: snap.entry,
        target: snap.target,
        invalidation: snap.level,
        atr: snap.atr,
        future,
      })
      open.set(openKey, {
        tf: snap.tf,
        kind: snap.kind,
        side: snap.side,
        target: snap.target,
        invalidation: snap.level,
        discoveredMs: asOfMs,
      })
      labeled.push({
        ...snap,
        symbol,
        discoveredMs: asOfMs,
        weekKey: weekKeyOf(asOfMs),
        oi: 'unknown',
        holdout: asOfMs >= holdoutStartMs,
        horizons,
        features: featureVectorOf(snap),
      })
    }
  }
  return labeled
}

export function tfBarMs(tf: HistoryTf): number {
  return BAR_MS[tf]
}
