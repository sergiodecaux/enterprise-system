/**
 * How bars actually closed — 15m then 1h then 4h.
 * Day / week / month are the global picture, not a 15m flip.
 */

import type { OhlcvCandle } from '../../api/mexc'
import { readCloseQuality, type CloseQuality } from './mmTrapThesis'

export type CascadeTf = '15m' | '1h' | '4h' | '1d' | '1w' | '1M'

export interface ClosedBar {
  tf: CascadeTf
  quality: CloseQuality
  /** −1..+1, displacement is stronger than a weak body */
  score: number
  close: number
  open: number
  timeMs: number
  bodyPct: number
  closePos: number
  forming: boolean
}

export interface CloseCascade {
  m15: ClosedBar | null
  h1: ClosedBar | null
  h4: ClosedBar | null
  d1: ClosedBar | null
  w1: ClosedBar | null
  m1: ClosedBar | null
  /** 15m + 1h + 4h, 4h/1h dominate, 15m confirms */
  execution: number
  /** Closed day + week + month */
  global: number
  /** 15m fights 4h / day — hunt, not a new trend */
  ltfFightsHtf: boolean
  aligned: boolean
  line: string
  /** Changes only when a 15m/1h/4h/D bar closes */
  anchorKey: string
}

const BAR_MS: Record<CascadeTf, number> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
  '1M': 2_419_200_000,
}

export function isBarClosed(
  c: OhlcvCandle,
  barMs: number,
  now = Date.now()
): boolean {
  return now >= c[0] + barMs - 1_200
}

export function lastClosedBar(
  candles: OhlcvCandle[] | undefined,
  barMs: number,
  now = Date.now()
): OhlcvCandle | null {
  if (!candles?.length) return null
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i]
    if (c && isBarClosed(c, barMs, now)) return c
  }
  return candles.length >= 2 ? candles[candles.length - 2] ?? null : null
}

function lastClosedMonth(candles: OhlcvCandle[] | undefined): OhlcvCandle | null {
  if (!candles?.length) return null
  const now = new Date()
  const curKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}`
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i]
    const d = new Date(c[0])
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    if (k !== curKey) return c
  }
  return candles.length >= 2 ? candles[candles.length - 2] ?? null : null
}

export function closedSlice(
  candles: OhlcvCandle[] | undefined,
  barMs: number,
  now = Date.now()
): OhlcvCandle[] {
  if (!candles?.length) return []
  const last = lastClosedBar(candles, barMs, now)
  if (!last) return candles.slice(0, -1)
  const idx = candles.findIndex((c) => c[0] === last[0])
  return idx >= 0 ? candles.slice(0, idx + 1) : candles
}

export function aggregateMonthly(daily: OhlcvCandle[]): OhlcvCandle[] {
  if (!daily.length) return []
  const months: OhlcvCandle[] = []
  let cur: OhlcvCandle | null = null
  let key = ''
  for (const c of daily) {
    const d = new Date(c[0])
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    if (k !== key) {
      if (cur) months.push(cur)
      key = k
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
      cur = [start, c[1], c[2], c[3], c[4], c[5]]
    } else if (cur) {
      cur = [
        cur[0],
        cur[1],
        Math.max(cur[2], c[2]),
        Math.min(cur[3], c[3]),
        c[4],
        cur[5] + c[5],
      ]
    }
  }
  if (cur) months.push(cur)
  return months
}

function scoreClose(c: OhlcvCandle, q: CloseQuality): number {
  const [, o, h, l, close] = c
  const range = h - l
  const bodyPct = range > 0 ? Math.abs(close - o) / range : 0
  const closePos = range > 0 ? (close - l) / range : 0.5
  if (q === 'DISPLACEMENT_UP') return 1
  if (q === 'DISPLACEMENT_DOWN') return -1
  if (q === 'REJECT_HIGH') return -0.72
  if (q === 'REJECT_LOW') return 0.72
  if (q === 'INDECISION') return 0
  if (close > o) return 0.28 + bodyPct * 0.25 + (closePos - 0.5) * 0.2
  if (close < o) return -(0.28 + bodyPct * 0.25 + (0.5 - closePos) * 0.2)
  return 0
}

function readClosed(
  candles: OhlcvCandle[] | undefined,
  tf: CascadeTf
): ClosedBar | null {
  const c = tf === '1M' ? lastClosedMonth(candles) : lastClosedBar(candles, BAR_MS[tf])
  if (!c) return null
  const q = readCloseQuality(c)
  const range = c[2] - c[3]
  return {
    tf,
    quality: q,
    score: scoreClose(c, q),
    close: c[4],
    open: c[1],
    timeMs: c[0],
    bodyPct: range > 0 ? Math.abs(c[4] - c[1]) / range : 0,
    closePos: range > 0 ? (c[4] - c[3]) / range : 0.5,
    forming: false,
  }
}

function ru(bar: ClosedBar | null, name: string): string | null {
  if (!bar) return null
  const q = bar.quality
  const how =
    q === 'DISPLACEMENT_UP'
      ? 'тело вверх'
      : q === 'DISPLACEMENT_DOWN'
        ? 'тело вниз'
        : q === 'REJECT_HIGH'
          ? 'отказ от хая'
          : q === 'REJECT_LOW'
            ? 'отказ от лоя'
            : q === 'INDECISION'
              ? 'доджи / пила'
              : bar.close > bar.open
                ? 'слабое тело вверх'
                : bar.close < bar.open
                  ? 'слабое тело вниз'
                  : 'нерешительность'
  return `${name} ${how}`
}

function sign(n: number): 1 | -1 | 0 {
  if (n >= 0.28) return 1
  if (n <= -0.28) return -1
  return 0
}

export function readCloseCascade(input: {
  candles15m?: OhlcvCandle[]
  candles1h?: OhlcvCandle[]
  candles4h?: OhlcvCandle[]
  candles1d?: OhlcvCandle[]
  candles1w?: OhlcvCandle[]
  candles1M?: OhlcvCandle[]
}): CloseCascade {
  const m15 = readClosed(input.candles15m, '15m')
  const h1 = readClosed(input.candles1h, '1h')
  const h4 = readClosed(input.candles4h, '4h')
  const d1 = readClosed(input.candles1d, '1d')
  const w1 = readClosed(input.candles1w, '1w')
  const m1 = readClosed(input.candles1M, '1M')

  const h4s = h4?.score ?? 0
  const h1s = h1?.score ?? 0
  const m15s = m15?.score ?? 0
  const h4Sign = sign(h4s)
  const h1Sign = sign(h1s)
  const m15Sign = sign(m15s)

  let execution = h4s * 1.05
  if (h1) {
    execution += h4Sign !== 0 && h1Sign === h4Sign ? h1s * 0.9 : h1s * 0.28
  }
  if (m15) {
    const followHour = h1Sign !== 0 && m15Sign === h1Sign
    execution += followHour ? m15s * 0.55 : m15s * 0.16
  }

  const global =
    (d1?.score ?? 0) * 0.48 + (w1?.score ?? 0) * 0.34 + (m1?.score ?? 0) * 0.18

  const gSign = sign(global)
  const ltfFightsHtf =
    (h4Sign !== 0 && m15Sign !== 0 && m15Sign !== h4Sign) ||
    (gSign !== 0 && m15Sign !== 0 && m15Sign !== gSign)

  const aligned =
    h4Sign !== 0 &&
    h1Sign === h4Sign &&
    (m15Sign === 0 || m15Sign === h4Sign) &&
    (gSign === 0 || gSign === h4Sign)

  const bits = [
    ru(m1, 'месяц'),
    ru(w1, 'неделя'),
    ru(d1, 'день'),
    ru(h4, '4ч'),
    ru(h1, 'час'),
    ru(m15, '15м'),
  ].filter((x): x is string => x != null)

  let line = bits.slice(0, 4).join(' · ')
  if (aligned) {
    line +=
      h4Sign > 0
        ? '. Закрытия 15м→1ч→4ч в одну сторону вверх — это не пила.'
        : '. Закрытия 15м→1ч→4ч в одну сторону вниз — это не пила.'
  } else if (ltfFightsHtf) {
    line +=
      '. 15м против 4ч/дня — сначала охота, глобальную картину свеча 15м не ломает.'
  }

  const anchorKey = [
    m15?.timeMs ?? 0,
    h1?.timeMs ?? 0,
    h4?.timeMs ?? 0,
    d1?.timeMs ?? 0,
    w1?.timeMs ?? 0,
  ].join('|')

  return {
    m15,
    h1,
    h4,
    d1,
    w1,
    m1,
    execution,
    global,
    ltfFightsHtf,
    aligned,
    line,
    anchorKey,
  }
}

export function cascadePrice(c: CloseCascade, fallback: number): number {
  const px = c.m15?.close ?? c.h1?.close ?? c.h4?.close ?? c.d1?.close
  return px != null && px > 0 ? px : fallback
}
