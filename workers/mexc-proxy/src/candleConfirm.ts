/**
 * Shared 1m candle entry confirmation for meme LONG/SHORT.
 * Entry requires trigger candle + 2 closed bars agreeing.
 */

import type { Candle } from './peakFuelFail'

function bodyRatio(c: Candle): number {
  const range = c[2] - c[3]
  if (!(range > 0)) return 0
  return Math.abs(c[4] - c[1]) / range
}

/** Last closed bar: buyers won (green, close upper half, real body). */
export function bullishTriggerCandle(candles: Candle[]): boolean {
  const c = candles[candles.length - 2]
  if (!c) return false
  const [, o, h, l, cl] = c
  const range = h - l
  if (!(range > 0)) return false
  return cl > o * 1.0005 && (cl - l) / range >= 0.55 && bodyRatio(c) >= 0.35
}

/** Last closed bar: sellers won. */
export function bearishTriggerCandle(candles: Candle[]): boolean {
  const c = candles[candles.length - 2]
  if (!c) return false
  const [, o, h, l, cl] = c
  const range = h - l
  if (!(range > 0)) return false
  return cl < o * 0.9995 && (cl - l) / range <= 0.45 && bodyRatio(c) >= 0.35
}

function higherHighHold(candles: Candle[]): boolean {
  if (candles.length < 8) return false
  const closed = candles.slice(0, -1)
  const last = closed[closed.length - 1]
  if (!last) return false
  const prior = closed.slice(-8, -1)
  if (prior.length < 3) return false
  const priorHigh = Math.max(...prior.map((c) => c[2]))
  return last[2] > priorHigh * 1.0005 && last[4] >= priorHigh * 0.999
}

function failedBreakHold(candles: Candle[]): boolean {
  if (candles.length < 6) return false
  const closed = candles.slice(0, -1)
  for (let k = 0; k < 3; k++) {
    const last = closed[closed.length - 1 - k]
    if (!last) continue
    const prior = closed.slice(-(8 + k), -(1 + k))
    if (prior.length < 3) continue
    const priorHigh = Math.max(...prior.map((c) => c[2]))
    if (last[2] > priorHigh * 1.0003 && last[4] < priorHigh * 1.0002) {
      return true
    }
  }
  return false
}

/**
 * 2 closed 1m bars confirm LONG: higher close + higher low,
 * at least one real green body, not a dump close.
 */
export function chartConfirmLong2m(candles: Candle[]): boolean {
  const closed = candles.slice(0, -1).slice(-2)
  if (closed.length < 2) return false
  const [a, b] = closed
  if (!a || !b) return false
  const green = (c: Candle) => c[4] > c[1]
  const higherClose = b[4] >= a[4] * 0.9995
  const higherLow = b[3] >= a[3] * 0.998
  const notDumpBar =
    b[4] >= b[1] * 0.997 ||
    (b[4] - b[3]) / Math.max(b[2] - b[3], 1e-12) >= 0.45
  const realBody = bodyRatio(a) >= 0.32 || bodyRatio(b) >= 0.32
  return (
    (green(a) || green(b)) &&
    higherClose &&
    higherLow &&
    notDumpBar &&
    realBody
  )
}

/** 2 closed 1m bars confirm SHORT: lower closes / red hold. */
export function chartConfirmShort2m(candles: Candle[]): boolean {
  const closed = candles.slice(0, -1).slice(-2)
  if (closed.length < 2) return false
  const [a, b] = closed
  if (!a || !b) return false
  const red = (c: Candle) => c[4] < c[1]
  const lowerClose = b[4] <= a[4] * 1.0005
  const lowerHigh = b[2] <= a[2] * 1.0015
  const sellersHold =
    b[4] <= b[1] * 1.001 ||
    (b[2] - b[4]) / Math.max(b[2] - b[3], 1e-12) >= 0.45
  const realBody = bodyRatio(a) >= 0.32 || bodyRatio(b) >= 0.32
  return (
    (red(a) || red(b)) &&
    lowerClose &&
    (lowerHigh || sellersHold) &&
    realBody
  )
}

/** Hard entry gate LONG: 2m chart + trigger (or HH hold). */
export function longCandleEntryOk(candles: Candle[]): boolean {
  if (!chartConfirmLong2m(candles)) return false
  return bullishTriggerCandle(candles) || higherHighHold(candles)
}

/** Hard entry gate SHORT: 2m chart + bearish trigger (or failed break). */
export function shortCandleEntryOk(candles: Candle[]): boolean {
  if (!chartConfirmShort2m(candles)) return false
  return bearishTriggerCandle(candles) || failedBreakHold(candles)
}
