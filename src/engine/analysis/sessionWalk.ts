/**
 * How far this symbol actually travels inside each UTC session.
 * Range and net are measured on completed sessions. The path may
 * spend only what this session has not already used.
 */

import type { OhlcvCandle } from '../../api/mexc'
import { getSessionAtHour, SESSION_DEFINITIONS } from '../sessions/sessionMap'
import type { SessionName } from '../sessions/types'

export interface SessionWalk {
  name: SessionName
  label: string
  samples: number
  /** Median high-low of completed sessions, price units. */
  medianRange: number
  /** 70th percentile of the same ranges. */
  p70Range: number
  /** Median close-open. Positive means the session usually finishes up. */
  medianNet: number
  /** Share of completed sessions that closed above their open. */
  upShare: number
  /** 1 - median(|net| / range). How much of a session is given back. */
  retraceFrac: number
  rangeSoFar: number
  netSoFar: number
  /** Price distance still typical before this session's median range is spent. */
  remaining: number
  remainingSec: number
  /** Today's range already reached the historical 70th percentile. */
  spent: boolean
  /** Median true range of one bar on the series used for the current session. */
  barRange: number
  line: string
}

interface Bucket {
  name: SessionName
  startMs: number
  endMs: number
  open: number
  high: number
  low: number
  close: number
  bars: number
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = s[lo] ?? 0
  const b = s[hi] ?? a
  if (lo === hi) return a
  return a * (hi - pos) + b * (pos - lo)
}

function median(values: number[]): number {
  return quantile(values, 0.5)
}

function dayStartMs(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

const SEGMENT_HOURS: Record<SessionName, [number, number]> = {
  ASIA: [0, 7],
  LONDON: [7, 13],
  OVERLAP: [13, 16],
  NEW_YORK: [16, 22],
  CLOSED: [22, 24],
}

function sessionBounds(name: SessionName, dayMs: number): { startMs: number; endMs: number } {
  const [startH, endH] = SEGMENT_HOURS[name]
  return { startMs: dayMs + startH * 3_600_000, endMs: dayMs + endH * 3_600_000 }
}

function pushBar(map: Map<string, Bucket>, c: OhlcvCandle) {
  const t = c[0]
  const name = getSessionAtHour(new Date(t).getUTCHours())
  const day = dayStartMs(t)
  const bounds = sessionBounds(name, day)
  if (t < bounds.startMs || t >= bounds.endMs) return
  const key = `${bounds.startMs}|${name}`
  const prev = map.get(key)
  if (!prev) {
    map.set(key, {
      name,
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      bars: 1,
    })
    return
  }
  prev.high = Math.max(prev.high, c[2])
  prev.low = Math.min(prev.low, c[3])
  if (t >= prev.startMs) prev.close = c[4]
  prev.bars += 1
}

function barRanges(candles: OhlcvCandle[]): number[] {
  const out: number[] = []
  for (const c of candles) {
    const r = c[2] - c[3]
    if (r > 0) out.push(r)
  }
  return out
}

export function measureSessionWalk(input: {
  candles15m?: OhlcvCandle[]
  candles1h?: OhlcvCandle[]
  price: number
  now?: number
}): SessionWalk {
  const now = input.now ?? Date.now()
  const name = getSessionAtHour(new Date(now).getUTCHours())
  const label = SESSION_DEFINITIONS[name].label
  const empty = (line: string): SessionWalk => ({
    name,
    label,
    samples: 0,
    medianRange: 0,
    p70Range: 0,
    medianNet: 0,
    upShare: 0.5,
    retraceFrac: 0.45,
    rangeSoFar: 0,
    netSoFar: 0,
    remaining: 0,
    remainingSec: 0,
    spent: false,
    barRange: 0,
    line,
  })

  const series =
    (input.candles1h?.length ?? 0) >= 48
      ? { candles: input.candles1h ?? [], barMs: 3_600_000 }
      : (input.candles15m?.length ?? 0) >= 32
        ? { candles: input.candles15m ?? [], barMs: 900_000 }
        : null
  if (!series) return empty(`${label}: мало свечей, размах сессии не измерен.`)

  const map = new Map<string, Bucket>()
  for (const c of series.candles) pushBar(map, c)

  const done: Bucket[] = []
  let live: Bucket | null = null
  for (const b of map.values()) {
    if (b.name !== name) continue
    if (b.endMs <= now) done.push(b)
    else if (now >= b.startMs && now < b.endMs) live = b
  }

  const bounds = sessionBounds(name, dayStartMs(now))
  const remainingSec = Math.max(0, Math.round((bounds.endMs - now) / 1000))
  const lengthSec = Math.max(1, (bounds.endMs - bounds.startMs) / 1000)
  const remainingFrac = remainingSec / lengthSec

  const fine = input.candles15m?.length ? input.candles15m : series.candles
  const barRange = median(barRanges(fine.slice(-80)))
  const rangeSoFar = live ? Math.max(0, live.high - live.low) : 0
  const netSoFar = live ? live.close - live.open : 0

  if (done.length < 4) {
    const barsLeft = Math.max(1, remainingSec / (series.barMs / 1000))
    const estimated = barRange * Math.sqrt(barsLeft)
    const remaining = Math.max(0, estimated)
    return {
      name,
      label,
      samples: done.length,
      medianRange: estimated,
      p70Range: estimated * 1.3,
      medianNet: 0,
      upShare: 0.5,
      retraceFrac: 0.45,
      rangeSoFar,
      netSoFar,
      remaining,
      remainingSec,
      spent: false,
      barRange,
      line: `${label}: в истории ${done.length} полных сессий. Размах до конца ≈ ${fmtPx(remaining)} по корню числа оставшихся баров.`,
    }
  }

  const ranges = done.map((b) => b.high - b.low).filter((r) => r > 0)
  const nets = done.map((b) => b.close - b.open)
  const efficiencies = done
    .map((b) => {
      const r = b.high - b.low
      if (!(r > 0)) return null
      return Math.abs(b.close - b.open) / r
    })
    .filter((x): x is number => x != null)

  const medianRange = median(ranges)
  const p70Range = quantile(ranges, 0.7)
  const medianNet = median(nets)
  const upShare = nets.filter((n) => n > 0).length / nets.length
  const efficiency = median(efficiencies.length ? efficiencies : [0.55])
  const retraceFrac = Math.min(0.62, Math.max(0.2, 1 - efficiency))
  const timeBudget = medianRange * remainingFrac
  const spentBudget = Math.max(0, medianRange - rangeSoFar)
  const remaining = Math.max(0, Math.min(timeBudget, spentBudget))
  const spent = rangeSoFar >= p70Range && p70Range > 0

  const px = input.price > 0 ? input.price : 1
  const line = spent
    ? `${label}: сегодня уже ${pct(rangeSoFar, px)} при обычных ${pct(medianRange, px)} (p70 ${pct(p70Range, px)}, n=${done.length}). Размах сессии выбран.`
    : `${label}: обычно ${pct(medianRange, px)} (p70 ${pct(p70Range, px)}, вверх в ${Math.round(upShare * 100)}% из ${done.length}). Сегодня ${pct(rangeSoFar, px)}, запас ${pct(remaining, px)}.`

  return {
    name,
    label,
    samples: done.length,
    medianRange,
    p70Range,
    medianNet,
    upShare,
    retraceFrac,
    rangeSoFar,
    netSoFar,
    remaining,
    remainingSec,
    spent,
    barRange,
    line,
  }
}

function pct(dist: number, price: number): string {
  if (!(price > 0)) return '—'
  return `${((dist / price) * 100).toFixed(2)}%`
}

function fmtPx(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 100) return n.toFixed(1)
  if (n >= 1) return n.toFixed(3)
  return n.toPrecision(3)
}
