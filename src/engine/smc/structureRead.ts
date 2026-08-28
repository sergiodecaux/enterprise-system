/**
 * Smart Money market structure: BOS / CHoCH / reclaim / sweep,
 * Fib 141 reaction, and a HTF-weighted flight path.
 *
 * Weight: 1H (execution) > 4H (confirm) > Daily > Weekly (bias).
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { PathPoint } from '../prediction/types'
import type { GlobalFibonacciMap } from '../zones/globalFibonacci'

export type StructureTf = '1h' | '4h' | '1d' | '1w'
export type StructureTrend = 'BULLISH' | 'BEARISH' | 'RANGING'
export type StructureEventKind =
  | 'BOS'
  | 'CHOCH'
  | 'RECLAIM'
  | 'SWEEP'
  | 'FIB141_BOUNCE'
  | 'FIB141_BREAK'

export interface StructureSwing {
  index: number
  price: number
  timeSec: number
  kind: 'HIGH' | 'LOW'
}

export interface StructureEvent {
  kind: StructureEventKind
  side: 'UP' | 'DOWN'
  price: number
  timeSec: number
  index: number
  label: string
  /** Subsequent close held the break / reclaim */
  held: boolean
}

export interface TfStructure {
  tf: StructureTf
  trend: StructureTrend
  lastBos: StructureEvent | null
  lastChoch: StructureEvent | null
  lastReclaim: StructureEvent | null
  lastSweep: StructureEvent | null
  lastSwingHigh: StructureSwing | null
  lastSwingLow: StructureSwing | null
  dealingHigh: number
  dealingLow: number
  /** Price in upper half of dealing range */
  inPremium: boolean
  inDiscount: boolean
  nextBsl: number | null
  nextSsl: number | null
  narrative: string
}

export type Fib141State =
  | 'NONE'
  | 'APPROACHING'
  | 'INSIDE'
  | 'BOUNCE'
  | 'BREAK'
  | 'RECLAIM'

export interface Fib141Reaction {
  state: Fib141State
  bias: 'LONG' | 'SHORT' | null
  zoneTop: number
  zoneBottom: number
  reactionPrice: number | null
  barsAgo: number | null
  narrative: string
}

export interface StructureMarker {
  time: number
  position: 'aboveBar' | 'belowBar'
  color: string
  shape: 'arrowUp' | 'arrowDown' | 'circle'
  text: string
}

export interface StructureRead {
  h1: TfStructure | null
  h4: TfStructure | null
  d1: TfStructure | null
  w1: TfStructure | null
  fib141: Fib141Reaction | null
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  preferredSide: 'LONG' | 'SHORT' | null
  summary: string
  factors: string[]
  chartPath: PathPoint[]
  markers: StructureMarker[]
  magnet: { price: number; label: string } | null
  invalidation: number | null
}

const TF_WEIGHT: Record<StructureTf, number> = {
  '1h': 0.42,
  '4h': 0.33,
  '1d': 0.16,
  '1w': 0.09,
}

function atrApprox(candles: OhlcvCandle[], period = 14): number {
  if (candles.length < 3) return 0
  const n = Math.min(period, candles.length - 1)
  let sum = 0
  for (let i = candles.length - n; i < candles.length; i++) {
    const prev = candles[i - 1]
    const c = candles[i]
    if (!prev) continue
    sum += Math.max(
      c[2] - c[3],
      Math.abs(c[2] - prev[4]),
      Math.abs(c[3] - prev[4])
    )
  }
  return n > 0 ? sum / n : 0
}

function pivotRadius(tf: StructureTf): number {
  if (tf === '1h') return 2
  if (tf === '4h') return 2
  return 1
}

export function findSwings(
  candles: OhlcvCandle[],
  radius: number
): StructureSwing[] {
  const out: StructureSwing[] = []
  if (candles.length < radius * 2 + 3) return out
  for (let i = radius; i < candles.length - radius; i++) {
    const h = candles[i][2]
    const l = candles[i][3]
    let isHigh = true
    let isLow = true
    for (let k = 1; k <= radius; k++) {
      if (h <= candles[i - k][2] || h <= candles[i + k][2]) isHigh = false
      if (l >= candles[i - k][3] || l >= candles[i + k][3]) isLow = false
    }
    const t = Math.floor(candles[i][0] / 1000)
    if (isHigh) out.push({ index: i, price: h, timeSec: t, kind: 'HIGH' })
    if (isLow) out.push({ index: i, price: l, timeSec: t, kind: 'LOW' })
  }
  return out
}

function lastOf(
  swings: StructureSwing[],
  kind: 'HIGH' | 'LOW'
): StructureSwing | null {
  for (let i = swings.length - 1; i >= 0; i--) {
    if (swings[i].kind === kind) return swings[i]
  }
  return null
}

function trendFromSwings(highs: StructureSwing[], lows: StructureSwing[]): StructureTrend {
  if (highs.length < 2 || lows.length < 2) return 'RANGING'
  const h = highs.slice(-3)
  const l = lows.slice(-3)
  const hh = h.length >= 2 && h[h.length - 1].price > h[h.length - 2].price
  const hl = l.length >= 2 && l[l.length - 1].price > l[l.length - 2].price
  const lh = h.length >= 2 && h[h.length - 1].price < h[h.length - 2].price
  const ll = l.length >= 2 && l[l.length - 1].price < l[l.length - 2].price
  if (hh && hl) return 'BULLISH'
  if (lh && ll) return 'BEARISH'
  return 'RANGING'
}

function closeBeyond(close: number, level: number, side: 'UP' | 'DOWN', atr: number): boolean {
  const pad = Math.max(level * 0.0004, atr * 0.08)
  return side === 'UP' ? close > level + pad : close < level - pad
}

function wickBeyond(candle: OhlcvCandle, level: number, side: 'UP' | 'DOWN'): boolean {
  return side === 'UP' ? candle[2] > level : candle[3] < level
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

/**
 * Scan confirmed swings for BOS / CHoCH / sweep / reclaim.
 * BOS = close through swing in the direction of trend (continuation).
 * CHoCH = first close through swing against the trend.
 * Sweep = wick through, close back inside (liquidity grab).
 * Reclaim = after a break, price closes back and holds the original side.
 */
export function readTfStructure(
  candles: OhlcvCandle[],
  tf: StructureTf
): TfStructure | null {
  if (candles.length < 16) return null
  const atr = atrApprox(candles)
  const swings = findSwings(candles, pivotRadius(tf))
  const highs = swings.filter((s) => s.kind === 'HIGH')
  const lows = swings.filter((s) => s.kind === 'LOW')
  const lastHigh = lastOf(swings, 'HIGH')
  const lastLow = lastOf(swings, 'LOW')
  const trend = trendFromSwings(highs, lows)

  let lastBos: StructureEvent | null = null
  let lastChoch: StructureEvent | null = null
  let lastSweep: StructureEvent | null = null
  let lastReclaim: StructureEvent | null = null
  let liveTrend: StructureTrend = trend

  const consider = swings.slice(-10)
  for (const sw of consider) {
    const after = candles.slice(sw.index + 1)
    if (!after.length) continue
    const breakSide: 'UP' | 'DOWN' = sw.kind === 'HIGH' ? 'UP' : 'DOWN'

    for (let k = 0; k < after.length; k++) {
      const c = after[k]
      const absIdx = sw.index + 1 + k
      const t = Math.floor(c[0] / 1000)
      const closedBeyond = closeBeyond(c[4], sw.price, breakSide, atr)
      const wicked = wickBeyond(c, sw.price, breakSide) && !closedBeyond

      if (wicked && !closedBeyond) {
        lastSweep = {
          kind: 'SWEEP',
          side: breakSide,
          price: sw.price,
          timeSec: t,
          index: absIdx,
          label:
            breakSide === 'UP'
              ? `свип BSL ${tf}`
              : `свип SSL ${tf}`,
          held: false,
        }
        continue
      }

      if (!closedBeyond) continue

      const held = heldAfter(candles, absIdx, sw.price, breakSide)
      const against =
        (liveTrend === 'BULLISH' && breakSide === 'DOWN') ||
        (liveTrend === 'BEARISH' && breakSide === 'UP')
      const withTrend =
        (liveTrend === 'BULLISH' && breakSide === 'UP') ||
        (liveTrend === 'BEARISH' && breakSide === 'DOWN') ||
        liveTrend === 'RANGING'

      if (against) {
        lastChoch = {
          kind: 'CHOCH',
          side: breakSide,
          price: sw.price,
          timeSec: t,
          index: absIdx,
          label: `CHoCH ${tf} ${breakSide === 'UP' ? '↑' : '↓'}`,
          held,
        }
        liveTrend = breakSide === 'UP' ? 'BULLISH' : 'BEARISH'
      } else if (withTrend) {
        lastBos = {
          kind: 'BOS',
          side: breakSide,
          price: sw.price,
          timeSec: t,
          index: absIdx,
          label: `BOS ${tf} ${breakSide === 'UP' ? '↑' : '↓'}`,
          held,
        }
        liveTrend = breakSide === 'UP' ? 'BULLISH' : 'BEARISH'
      }
      break
    }
  }

  // Reclaim: after a sweep or failed close-through, later close recaptures the level
  if (lastSweep) {
    const from = lastSweep.index
    const level = lastSweep.price
    const recaptureSide: 'UP' | 'DOWN' =
      lastSweep.side === 'UP' ? 'DOWN' : 'UP'
    for (let i = from + 1; i < candles.length; i++) {
      const c = candles[i]
      if (!closeBeyond(c[4], level, recaptureSide, atr)) continue
      const held = heldAfter(candles, i, level, recaptureSide)
      lastReclaim = {
        kind: 'RECLAIM',
        side: recaptureSide,
        price: level,
        timeSec: Math.floor(c[0] / 1000),
        index: i,
        label: `закреп ${tf} ${recaptureSide === 'UP' ? '↑' : '↓'}`,
        held,
      }
      break
    }
  }

  // Also: BOS then retest that holds = reclaim of broken structure
  if (!lastReclaim && lastBos && lastBos.held) {
    const level = lastBos.price
    for (let i = lastBos.index + 1; i < candles.length; i++) {
      const c = candles[i]
      const tagged =
        lastBos.side === 'UP'
          ? c[3] <= level * 1.002 && c[4] >= level
          : c[2] >= level * 0.998 && c[4] <= level
      if (tagged) {
        lastReclaim = {
          kind: 'RECLAIM',
          side: lastBos.side,
          price: level,
          timeSec: Math.floor(c[0] / 1000),
          index: i,
          label: `ретест BOS ${tf}`,
          held: true,
        }
        break
      }
    }
  }

  const dealingHigh = lastHigh?.price ?? Math.max(...candles.slice(-20).map((c) => c[2]))
  const dealingLow = lastLow?.price ?? Math.min(...candles.slice(-20).map((c) => c[3]))
  const last = candles[candles.length - 1]
  const close = last[4]
  const mid = (dealingHigh + dealingLow) / 2
  const inPremium = dealingHigh > dealingLow && close >= mid
  const inDiscount = dealingHigh > dealingLow && close < mid

  const nextBsl = highs.length ? highs[highs.length - 1].price : dealingHigh
  const nextSsl = lows.length ? lows[lows.length - 1].price : dealingLow

  const bits: string[] = []
  if (lastBos) bits.push(lastBos.label + (lastBos.held ? ' держит' : ''))
  if (lastChoch) bits.push(lastChoch.label)
  if (lastReclaim) bits.push(lastReclaim.label)
  else if (lastSweep) bits.push(lastSweep.label)
  bits.push(inDiscount ? 'дисконт' : inPremium ? 'премиум' : 'середина')

  return {
    tf,
    trend: liveTrend,
    lastBos,
    lastChoch,
    lastReclaim,
    lastSweep,
    lastSwingHigh: lastHigh,
    lastSwingLow: lastLow,
    dealingHigh,
    dealingLow,
    inPremium,
    inDiscount,
    nextBsl,
    nextSsl,
    narrative: bits.join(' · ') || `${tf} нет явной структуры`,
  }
}

export function readFib141Reaction(
  candles: OhlcvCandle[],
  fib: GlobalFibonacciMap | null
): Fib141Reaction | null {
  if (!fib?.zone141) return null
  const z = fib.zone141
  const top = Math.max(z.top, z.bottom)
  const bottom = Math.min(z.top, z.bottom)
  const last = candles[candles.length - 1]
  const close = last?.[4] ?? 0
  const atr = atrApprox(candles)
  const pad = Math.max((top - bottom) * 0.15, atr * 0.25, close * 0.002)
  const near =
    close <= top + pad * 2 && close >= bottom - pad * 2

  let state: Fib141State = 'NONE'
  let reactionPrice: number | null = null
  let barsAgo: number | null = null
  const look = candles.slice(-36)

  for (let i = look.length - 1; i >= 0; i--) {
    const c = look[i]
    const abs = candles.length - look.length + i
    const touched = c[2] >= bottom && c[3] <= top
    if (!touched) continue

    const wickUp = c[2] - Math.max(c[1], c[4])
    const wickDn = Math.min(c[1], c[4]) - c[3]
    const range = Math.max(c[2] - c[3], 1e-12)
    const closedAbove = c[4] > top
    const closedBelow = c[4] < bottom
    const inside = c[4] <= top && c[4] >= bottom

    const bounceShort =
      z.bias === 'SHORT' &&
      (wickUp / range >= 0.45 || (c[2] >= top && c[4] < top - pad * 0.2)) &&
      !closedAbove
    const bounceLong =
      z.bias === 'LONG' &&
      (wickDn / range >= 0.45 || (c[3] <= bottom && c[4] > bottom + pad * 0.2)) &&
      !closedBelow

    const broke =
      z.bias === 'SHORT' ? closedAbove && heldAfter(candles, abs, top, 'UP')
        : closedBelow && heldAfter(candles, abs, bottom, 'DOWN')

    const reclaimed =
      (z.bias === 'SHORT' && closedAbove && i < look.length - 1 &&
        look.slice(i + 1).some((n) => n[4] <= top)) ||
      (z.bias === 'LONG' && closedBelow && i < look.length - 1 &&
        look.slice(i + 1).some((n) => n[4] >= bottom))

    barsAgo = look.length - 1 - i
    reactionPrice = z.bias === 'SHORT' ? c[2] : c[3]

    if (reclaimed) {
      state = 'RECLAIM'
      break
    }
    if (broke) {
      state = 'BREAK'
      break
    }
    if (bounceShort || bounceLong) {
      state = 'BOUNCE'
      break
    }
    if (inside) {
      state = 'INSIDE'
      break
    }
    state = 'APPROACHING'
    break
  }

  if (state === 'NONE' && near) state = 'APPROACHING'
  if (state === 'NONE' && close <= top && close >= bottom) state = 'INSIDE'

  const narrative =
    state === 'BOUNCE'
      ? `Отскок от 141 → ${z.bias} (как в прошлый раз)`
      : state === 'BREAK'
        ? `Слом 141 — импульс продолжается, 161/ликвидность дальше`
        : state === 'RECLAIM'
          ? `Ложный пробой 141 + закреп обратно → ${z.bias}`
          : state === 'INSIDE'
            ? `Цена в зоне 141 — ждём отскок ${z.bias} или слом`
            : state === 'APPROACHING'
              ? `Подход к 141 · план ${z.bias}`
              : '141 ещё не торговалась на этом импульсе'

  return {
    state,
    bias: z.bias,
    zoneTop: top,
    zoneBottom: bottom,
    reactionPrice,
    barsAgo,
    narrative,
  }
}

export function aggregateWeekly(daily: OhlcvCandle[]): OhlcvCandle[] {
  if (!daily.length) return []
  const weeks: OhlcvCandle[] = []
  let cur: OhlcvCandle | null = null
  let weekKey = Number.NaN
  for (const c of daily) {
    const day = new Date(c[0]).getUTCDay()
    const mondayOffset = (day + 6) % 7
    const mondayMs = c[0] - mondayOffset * 86_400_000
    const key = Math.floor(mondayMs / 86_400_000)
    if (key !== weekKey) {
      if (cur) weeks.push(cur)
      weekKey = key
      cur = [mondayMs, c[1], c[2], c[3], c[4], c[5]]
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
  if (cur) weeks.push(cur)
  return weeks
}

function scoreTf(tf: TfStructure | null): number {
  if (!tf) return 0
  let s = 0
  if (tf.trend === 'BULLISH') s += 1
  else if (tf.trend === 'BEARISH') s -= 1
  const ranked = [tf.lastChoch, tf.lastBos]
    .filter((x): x is StructureEvent => x != null)
    .sort((a, b) => a.index - b.index)
  const ev = ranked.length ? ranked[ranked.length - 1] : null
  if (ev) {
    const w = ev.kind === 'CHOCH' ? 1.15 : ev.held ? 1 : 0.55
    s += ev.side === 'UP' ? w : -w
  }
  if (tf.lastReclaim) {
    s += tf.lastReclaim.side === 'UP' ? 0.85 : -0.85
  }
  if (tf.trend === 'BULLISH' && tf.inDiscount) s += 0.35
  if (tf.trend === 'BEARISH' && tf.inPremium) s -= 0.35
  return s
}

function pickMagnet(
  h1: TfStructure | null,
  h4: TfStructure | null,
  d1: TfStructure | null,
  w1: TfStructure | null,
  fib: Fib141Reaction | null,
  side: 'LONG' | 'SHORT'
): { price: number; label: string } | null {
  const cands: { price: number; label: string; rank: number }[] = []
  const push = (price: number | null | undefined, label: string, rank: number) => {
    if (price != null && price > 0) cands.push({ price, label, rank })
  }
  if (side === 'LONG') {
    push(h4?.nextBsl, '4H BSL', 8)
    push(d1?.nextBsl, 'Daily high', 7)
    push(w1?.nextBsl, 'Weekly high', 6)
    push(h1?.nextBsl, '1H BSL', 5)
    if (fib && fib.bias === 'SHORT' && fib.state !== 'BREAK') {
      push((fib.zoneTop + fib.zoneBottom) / 2, 'Fib 141', 4)
    }
  } else {
    push(h4?.nextSsl, '4H SSL', 8)
    push(d1?.nextSsl, 'Daily low', 7)
    push(w1?.nextSsl, 'Weekly low', 6)
    push(h1?.nextSsl, '1H SSL', 5)
    if (fib && fib.bias === 'LONG' && fib.state !== 'BREAK') {
      push((fib.zoneTop + fib.zoneBottom) / 2, 'Fib 141', 4)
    }
  }
  cands.sort((a, b) => b.rank - a.rank)
  return cands[0] ?? null
}

function buildFlightPath(opts: {
  price: number
  side: 'LONG' | 'SHORT'
  h1: TfStructure | null
  h4: TfStructure | null
  fib: Fib141Reaction | null
  magnet: { price: number; label: string } | null
  invalidation: number | null
}): PathPoint[] {
  const { price, side, h1, h4, fib, magnet, invalidation } = opts
  const dir = side === 'LONG' ? 1 : -1
  const hour = 3600
  const points: PathPoint[] = [{ timeOffsetSeconds: 0, price, label: 'сейчас' }]

  // Pullback into discount (long) / premium (short) — 1H structure
  const pull =
    side === 'LONG'
      ? h1?.lastReclaim?.price ?? h1?.lastSwingLow?.price ?? h1?.dealingLow
      : h1?.lastReclaim?.price ?? h1?.lastSwingHigh?.price ?? h1?.dealingHigh

  const usePull =
    pull != null &&
    ((side === 'LONG' && pull < price && pull > price * 0.92) ||
      (side === 'SHORT' && pull > price && pull < price * 1.08))

  let t = 0
  if (fib && (fib.state === 'APPROACHING' || fib.state === 'INSIDE')) {
    const mid = (fib.zoneTop + fib.zoneBottom) / 2
    t += Math.round(hour * 2.5)
    points.push({
      timeOffsetSeconds: t,
      price: mid,
      label: fib.state === 'INSIDE' ? 'в 141' : 'к 141',
      isKeyLevel: true,
    })
    t += Math.round(hour * 1.5)
    const bounce =
      fib.bias === 'LONG'
        ? mid + Math.abs(fib.zoneTop - fib.zoneBottom) * 0.35
        : mid - Math.abs(fib.zoneTop - fib.zoneBottom) * 0.35
    points.push({
      timeOffsetSeconds: t,
      price: bounce,
      label: 'отскок 141',
      isKeyLevel: true,
    })
  } else if (fib?.state === 'BOUNCE' || fib?.state === 'RECLAIM') {
    t += Math.round(hour * 1.2)
    points.push({
      timeOffsetSeconds: t,
      price: price + dir * Math.abs(price) * 0.004,
      label: fib.state === 'RECLAIM' ? 'закреп 141' : 'после отскока 141',
    })
  } else if (usePull && pull != null) {
    t += Math.round(hour * 2)
    points.push({
      timeOffsetSeconds: t,
      price: pull,
      label: h1?.lastReclaim ? 'ретест 1H' : 'OTE / дисконт 1H',
      isKeyLevel: true,
    })
  }

  const h4Target =
    side === 'LONG' ? h4?.nextBsl ?? h4?.dealingHigh : h4?.nextSsl ?? h4?.dealingLow
  if (h4Target != null && h4Target > 0) {
    const aligned =
      (side === 'LONG' && h4Target > price) || (side === 'SHORT' && h4Target < price)
    if (aligned) {
      t += Math.round(hour * 6)
      points.push({
        timeOffsetSeconds: t,
        price: h4Target,
        label: 'цель 4H',
        isKeyLevel: true,
      })
    }
  }

  if (magnet && magnet.price > 0) {
    const aligned =
      (side === 'LONG' && magnet.price > price) ||
      (side === 'SHORT' && magnet.price < price)
    if (aligned) {
      t += Math.round(hour * 10)
      points.push({
        timeOffsetSeconds: t,
        price: magnet.price,
        label: magnet.label,
        isKeyLevel: true,
      })
    }
  }

  if (invalidation != null && invalidation > 0 && points.length < 3) {
    points.push({
      timeOffsetSeconds: hour * 4,
      price: invalidation,
      label: 'слом',
    })
  }

  return points
}

export function composeStructureRead(input: {
  price: number
  candles1h?: OhlcvCandle[]
  candles4h?: OhlcvCandle[]
  candles1d?: OhlcvCandle[]
  candles1w?: OhlcvCandle[]
  fib?: GlobalFibonacciMap | null
}): StructureRead {
  const h1 = input.candles1h?.length ? readTfStructure(input.candles1h, '1h') : null
  const h4 = input.candles4h?.length ? readTfStructure(input.candles4h, '4h') : null
  const d1 = input.candles1d?.length ? readTfStructure(input.candles1d, '1d') : null
  const w1 = input.candles1w?.length ? readTfStructure(input.candles1w, '1w') : null
  const fibSrc = input.candles1h ?? input.candles4h ?? input.candles1d ?? []
  const fib141 = readFib141Reaction(fibSrc, input.fib ?? null)

  const weighted =
    scoreTf(h1) * TF_WEIGHT['1h'] +
    scoreTf(h4) * TF_WEIGHT['4h'] +
    scoreTf(d1) * TF_WEIGHT['1d'] +
    scoreTf(w1) * TF_WEIGHT['1w']

  let fibTilt = 0
  if (fib141?.state === 'BOUNCE' || fib141?.state === 'RECLAIM') {
    fibTilt = fib141.bias === 'LONG' ? 0.55 : -0.55
  } else if (fib141?.state === 'BREAK') {
    fibTilt = fib141.bias === 'LONG' ? -0.35 : 0.35
  } else if (fib141?.state === 'INSIDE' || fib141?.state === 'APPROACHING') {
    fibTilt = fib141.bias === 'LONG' ? 0.2 : -0.2
  }

  const net = weighted + fibTilt * 0.28
  const bias: StructureRead['bias'] =
    net >= 0.28 ? 'BULLISH' : net <= -0.28 ? 'BEARISH' : 'NEUTRAL'
  const preferredSide: 'LONG' | 'SHORT' | null =
    bias === 'BULLISH' ? 'LONG' : bias === 'BEARISH' ? 'SHORT' : fib141?.bias ?? null

  const factors: string[] = []
  if (h1) factors.push(`1H ${h1.narrative}`)
  if (h4) factors.push(`4H ${h4.narrative}`)
  if (d1) factors.push(`D ${d1.trend === 'RANGING' ? 'флэт' : d1.trend === 'BULLISH' ? 'бычий' : 'медвежий'} · ${d1.inDiscount ? 'дисконт' : 'премиум'}`)
  if (w1) factors.push(`W ${w1.trend === 'BULLISH' ? 'бычий' : w1.trend === 'BEARISH' ? 'медвежий' : 'флэт'}`)
  if (fib141) factors.push(fib141.narrative)

  const magnet = preferredSide
    ? pickMagnet(h1, h4, d1, w1, fib141, preferredSide)
    : null

  const invalidation =
    preferredSide === 'LONG'
      ? h1?.lastSwingLow?.price ?? h4?.lastSwingLow?.price ?? null
      : preferredSide === 'SHORT'
        ? h1?.lastSwingHigh?.price ?? h4?.lastSwingHigh?.price ?? null
        : null

  const confidence = Math.round(
    Math.min(
      92,
      38 + Math.abs(net) * 55 + (h1?.lastBos?.held || h1?.lastReclaim?.held ? 8 : 0) +
        (h4 && h1 && h4.trend === h1.trend && h1.trend !== 'RANGING' ? 10 : 0)
    )
  )

  const summary =
    bias === 'NEUTRAL'
      ? 'Структура смешанная — ждём закреп 1H / 4H'
      : preferredSide === 'LONG'
        ? `Смарт-мани вверх: 1H ${h1?.lastChoch?.kind === 'CHOCH' ? 'CHoCH↑' : h1?.lastBos ? 'BOS↑' : 'дисконт'} · цель ${magnet?.label ?? '4H BSL'}`
        : `Смарт-мани вниз: 1H ${h1?.lastChoch?.kind === 'CHOCH' ? 'CHoCH↓' : h1?.lastBos ? 'BOS↓' : 'премиум'} · цель ${magnet?.label ?? '4H SSL'}`

  const markers: StructureMarker[] = []
  const pushMark = (ev: StructureEvent | null, tf: string) => {
    if (!ev) return
    const up = ev.side === 'UP'
    const isBos = ev.kind === 'BOS'
    const isChoch = ev.kind === 'CHOCH'
    const isRec = ev.kind === 'RECLAIM'
    markers.push({
      time: ev.timeSec,
      position: up ? 'belowBar' : 'aboveBar',
      color: isChoch ? '#f59e0b' : isRec ? '#22d3ee' : up ? '#22c55e' : '#f43f5e',
      shape: isRec ? 'circle' : up ? 'arrowUp' : 'arrowDown',
      text: isBos ? `BOS ${tf}` : isChoch ? `CHoCH ${tf}` : `закр ${tf}`,
    })
  }
  // 1H is the execution chart — those markers matter most
  pushMark(h1?.lastBos ?? null, '1H')
  pushMark(h1?.lastChoch ?? null, '1H')
  pushMark(h1?.lastReclaim ?? null, '1H')
  if (h4?.lastBos && (!h1?.lastBos || h4.lastBos.timeSec !== h1.lastBos.timeSec)) {
    pushMark(h4.lastBos, '4H')
  }
  if (h4?.lastChoch) pushMark(h4.lastChoch, '4H')

  const chartPath =
    preferredSide && input.price > 0
      ? buildFlightPath({
          price: input.price,
          side: preferredSide,
          h1,
          h4,
          fib: fib141,
          magnet,
          invalidation,
        })
      : []

  return {
    h1,
    h4,
    d1,
    w1,
    fib141,
    bias,
    confidence,
    preferredSide,
    summary,
    factors: factors.slice(0, 6),
    chartPath,
    markers,
    magnet,
    invalidation,
  }
}

/** Map structure markers onto the visible chart TF (match by unix seconds). */
export function markersForChart(
  read: StructureRead,
  candleTimesSec: number[]
): StructureMarker[] {
  if (!candleTimesSec.length) return []
  const minT = candleTimesSec[0]
  const maxT = candleTimesSec[candleTimesSec.length - 1]
  const seen = new Set<string>()
  const out: StructureMarker[] = []
  for (const m of read.markers) {
    if (m.time < minT - 3600 || m.time > maxT + 7200) continue
    let best = candleTimesSec[0]
    let bestD = Math.abs(best - m.time)
    for (const t of candleTimesSec) {
      const d = Math.abs(t - m.time)
      if (d < bestD) {
        best = t
        bestD = d
      }
    }
    const key = `${best}|${m.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...m, time: best })
  }
  return out.slice(-8)
}
