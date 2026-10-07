/**
 * Continuation extension 141–161.
 * Separate from globalFibonacci (that one projects the zone back through P,
 * as a sweep/reversal). Here 0% is the impulse start and 100% is the impulse
 * end, both on wicks, and 141–161 sits beyond the end in the same direction.
 *
 * Leg search copies the pivot rules from globalFibonacci.ts (radius 2, last
 * break, else the current leg, same minLeg). Prices used for the zone are
 * wicks, not candle bodies.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { Fib141State } from './structureRead'

export interface ContinuationPivot {
  price: number
  time: number
}

export interface ContinuationExtensionZone {
  tf: string
  impulse: 'UP' | 'DOWN'
  /** Reaction at the extension: fade back from the zone. */
  reactionBias: 'LONG' | 'SHORT'
  pivotStart: ContinuationPivot
  pivotEnd: ContinuationPivot
  top: number
  bottom: number
  level141: number
  level161: number
  mode: 'BREAK' | 'EXPECTED'
}

export interface ContinuationReaction {
  state: Fib141State
  bias: 'LONG' | 'SHORT'
  zoneTop: number
  zoneBottom: number
  reactionPrice: number | null
  barsAgo: number | null
  touches: number
}

const PIVOT_R = 2

interface Pivot {
  i: number
  /** Wick. Continuation levels use this. */
  price: number
  /** Candle body. Leg filter and the reversal pierce test use this, same as globalFibonacci. */
  anchor: number
  kind: 'HIGH' | 'LOW'
}

interface Leg {
  pivot: Pivot
  extreme: { i: number; price: number }
  breakIdx: number | null
}

function findPivots(window: OhlcvCandle[]): Pivot[] {
  const out: Pivot[] = []
  for (let i = PIVOT_R; i < window.length - PIVOT_R; i++) {
    const h = window[i][2]
    const l = window[i][3]
    let isHigh = true
    let isLow = true
    for (let k = 1; k <= PIVOT_R; k++) {
      if (h < window[i - k][2] || h <= window[i + k][2]) isHigh = false
      if (l > window[i - k][3] || l >= window[i + k][3]) isLow = false
    }
    const bodyHi = Math.max(window[i][1], window[i][4])
    const bodyLo = Math.min(window[i][1], window[i][4])
    if (isHigh) out.push({ i, price: h, anchor: bodyHi, kind: 'HIGH' })
    if (isLow) out.push({ i, price: l, anchor: bodyLo, kind: 'LOW' })
  }
  return out
}

function atrOf(window: OhlcvCandle[], period = 14): number {
  const n = Math.min(period, window.length - 1)
  if (n <= 0) return 0
  let sum = 0
  for (let i = window.length - n; i < window.length; i++) {
    const c = window[i]
    const p = window[i - 1][4]
    sum += Math.max(c[2] - c[3], Math.abs(c[2] - p), Math.abs(c[3] - p))
  }
  return sum / n
}

function extremeAfter(
  window: OhlcvCandle[],
  p: Pivot,
  end: number
): { i: number; price: number } | null {
  let best: { i: number; price: number } | null = null
  for (let k = p.i + 1; k < end; k++) {
    const v = p.kind === 'LOW' ? window[k][2] : window[k][3]
    if (!best || (p.kind === 'LOW' ? v >= best.price : v <= best.price)) {
      best = { i: k, price: v }
    }
  }
  return best
}

function legOk(leg: Leg, minLeg: number): boolean {
  return Math.abs(leg.extreme.price - leg.pivot.anchor) >= minLeg
}

function findLastBreak(window: OhlcvCandle[], pivots: Pivot[], minLeg: number): Leg | null {
  let best: Leg | null = null
  for (const p of pivots) {
    let j = -1
    for (let k = p.i + PIVOT_R + 1; k < window.length; k++) {
      const close = window[k][4]
      if (p.kind === 'LOW' ? close < p.price : close > p.price) {
        j = k
        break
      }
    }
    if (j < 0) continue
    const extreme = extremeAfter(window, p, j)
    if (!extreme) continue
    const leg: Leg = { pivot: p, extreme, breakIdx: j }
    if (!legOk(leg, minLeg)) continue
    if (
      !best ||
      j > (best.breakIdx ?? -1) ||
      (j === best.breakIdx && p.i > best.pivot.i)
    ) {
      best = leg
    }
  }
  return best
}

function findCurrentLeg(window: OhlcvCandle[], pivots: Pivot[], minLeg: number): Leg | null {
  if (!pivots.length) return null
  const last = pivots[pivots.length - 1]
  for (let idx = pivots.length - 1; idx >= 0; idx--) {
    const p = pivots[idx]
    if (p.kind === last.kind) continue
    const extreme = extremeAfter(window, p, window.length)
    if (!extreme) continue
    const leg: Leg = { pivot: p, extreme, breakIdx: null }
    if (legOk(leg, minLeg)) return leg
  }
  return null
}

/**
 * 141/161 beyond the impulse end.
 * UP: E + (E − P) × 0.414 / 0.618, which is low + (high − low) × 1.414 / 1.618.
 */
export function continuationLevels(
  pivotStart: number,
  pivotEnd: number,
  impulse: 'UP' | 'DOWN'
): { level141: number; level161: number } {
  if (impulse === 'UP') {
    const span = pivotEnd - pivotStart
    return {
      level141: pivotEnd + span * 0.414,
      level161: pivotEnd + span * 0.618,
    }
  }
  const span = pivotStart - pivotEnd
  return {
    level141: pivotEnd - span * 0.414,
    level161: pivotEnd - span * 0.618,
  }
}

function withPad(level141: number, level161: number): { top: number; bottom: number } {
  const top0 = Math.max(level141, level161)
  const bottom0 = Math.min(level141, level161)
  const span = top0 - bottom0
  const mid = (top0 + bottom0) / 2
  const pad = Math.max(span * 0.02, Math.abs(mid) * 0.0015)
  return { top: top0 + pad, bottom: bottom0 - pad }
}

function zoneFromLeg(
  window: OhlcvCandle[],
  leg: Leg,
  tf: string,
  mode: 'BREAK' | 'EXPECTED'
): ContinuationExtensionZone {
  const impulse: 'UP' | 'DOWN' = leg.pivot.kind === 'LOW' ? 'UP' : 'DOWN'
  const p = leg.pivot.price
  const e = leg.extreme.price
  const { level141, level161 } = continuationLevels(p, e, impulse)
  const { top, bottom } = withPad(level141, level161)
  return {
    tf,
    impulse,
    reactionBias: impulse === 'UP' ? 'SHORT' : 'LONG',
    pivotStart: { price: p, time: window[leg.pivot.i][0] },
    pivotEnd: { price: e, time: window[leg.extreme.i][0] },
    top,
    bottom,
    level141,
    level161,
    mode,
  }
}

/**
 * Same discard as globalFibonacci: a broken leg is dropped when price has
 * already closed through its reversal 141 band. That keeps the chosen P/E
 * pair, even though this module then projects the other way.
 */
function reversalPierced(window: OhlcvCandle[], leg: Leg, fromIdx: number): boolean {
  const e = leg.extreme.price
  const p = leg.pivot.anchor
  const r141 = e + (p - e) * 1.414
  const r161 = e + (p - e) * 1.618
  const top0 = Math.max(r141, r161)
  const bot0 = Math.min(r141, r161)
  const span = top0 - bot0
  const mid = (top0 + bot0) / 2
  const pad = Math.max(span * 0.02, Math.abs(mid) * 0.0015)
  const top = top0 + pad
  const bottom = bot0 - pad
  const biasLong = leg.pivot.kind === 'LOW'
  for (let k = fromIdx; k < window.length; k++) {
    const close = window[k][4]
    if (biasLong ? close < bottom : close > top) return true
  }
  return false
}

export function buildContinuationExtension(
  candles: OhlcvCandle[],
  tf: string
): ContinuationExtensionZone | null {
  if (candles.length < 25) return null
  const window = candles.slice(-160)
  const pivots = findPivots(window)
  if (pivots.length < 2) return null
  const price = window[window.length - 1][4]
  const minLeg = Math.max(price * 0.008, atrOf(window) * 1.5)

  let mode: 'BREAK' | 'EXPECTED' = 'BREAK'
  let leg = findLastBreak(window, pivots, minLeg)
  if (leg && leg.breakIdx != null && reversalPierced(window, leg, leg.breakIdx)) {
    leg = null
  }
  if (!leg) {
    mode = 'EXPECTED'
    leg = findCurrentLeg(window, pivots, minLeg)
    if (!leg) return null
  }
  return zoneFromLeg(window, leg, tf, mode)
}

function heldAfter(
  candles: OhlcvCandle[],
  fromIdx: number,
  level: number,
  side: 'UP' | 'DOWN'
): boolean {
  const end = Math.min(candles.length - 1, fromIdx + 3)
  if (end <= fromIdx) return false
  let holds = 0
  for (let i = fromIdx + 1; i <= end; i++) {
    const c = candles[i][4]
    if (side === 'UP' ? c >= level : c <= level) holds++
  }
  return holds >= 1
}

/** Touch state on a continuation zone. Same labels as readFib141Reaction. */
export function readContinuationReaction(
  candles: OhlcvCandle[],
  zone: ContinuationExtensionZone | null,
  zoneAtr?: number
): ContinuationReaction | null {
  if (!zone || candles.length < 2) return null
  const top = zone.top
  const bottom = zone.bottom
  const bias = zone.reactionBias
  const last = candles[candles.length - 1]
  const close = last[4]
  const atrN = Math.min(14, candles.length - 1)
  let atrSum = 0
  for (let i = candles.length - atrN; i < candles.length; i++) {
    const c = candles[i]
    const p = candles[i - 1][4]
    atrSum += Math.max(c[2] - c[3], Math.abs(c[2] - p), Math.abs(c[3] - p))
  }
  const atr = zoneAtr != null ? zoneAtr : atrSum / Math.max(atrN, 1)
  const pad = Math.max((top - bottom) * 0.15, atr * 0.25, close * 0.002)
  const since = zone.pivotEnd.time
  const look = candles.slice(-36).filter((c) => c[0] > since)

  let state: Fib141State = 'NONE'
  let reactionPrice: number | null = null
  let barsAgo: number | null = null

  for (let i = look.length - 1; i >= 0; i--) {
    const c = look[i]
    const abs = candles.length - look.length + i
    if (!(c[2] >= bottom && c[3] <= top)) continue
    const wickUp = c[2] - Math.max(c[1], c[4])
    const wickDn = Math.min(c[1], c[4]) - c[3]
    const range = Math.max(c[2] - c[3], 1e-12)
    const closedAbove = c[4] > top
    const closedBelow = c[4] < bottom
    const inside = c[4] <= top && c[4] >= bottom
    const bounceShort =
      bias === 'SHORT' &&
      (wickUp / range >= 0.45 || (c[2] >= top && c[4] < top - pad * 0.2)) &&
      !closedAbove
    const bounceLong =
      bias === 'LONG' &&
      (wickDn / range >= 0.45 || (c[3] <= bottom && c[4] > bottom + pad * 0.2)) &&
      !closedBelow
    const broke =
      bias === 'SHORT'
        ? closedAbove && heldAfter(candles, abs, top, 'UP')
        : closedBelow && heldAfter(candles, abs, bottom, 'DOWN')
    const reclaimed =
      (bias === 'SHORT' &&
        closedAbove &&
        i < look.length - 1 &&
        look.slice(i + 1).some((n) => n[4] <= top)) ||
      (bias === 'LONG' &&
        closedBelow &&
        i < look.length - 1 &&
        look.slice(i + 1).some((n) => n[4] >= bottom))
    barsAgo = look.length - 1 - i
    reactionPrice = bias === 'SHORT' ? c[2] : c[3]
    if (reclaimed) state = 'RECLAIM'
    else if (broke) state = 'BREAK'
    else if (bounceShort || bounceLong) state = 'BOUNCE'
    else if (inside) state = 'INSIDE'
    else state = 'APPROACHING'
    break
  }

  if (state === 'NONE' && close <= top + pad * 2 && close >= bottom - pad * 2) {
    state = 'APPROACHING'
  }
  if (state === 'NONE' && close <= top && close >= bottom) state = 'INSIDE'

  let touches = 0
  for (let i = 0; i < look.length; i++) {
    const hit = look[i][2] >= bottom && look[i][3] <= top
    const prev = i > 0 && look[i - 1][2] >= bottom && look[i - 1][3] <= top
    if (hit && !prev) touches++
  }

  return {
    state,
    bias,
    zoneTop: top,
    zoneBottom: bottom,
    reactionPrice,
    barsAgo,
    touches,
  }
}
