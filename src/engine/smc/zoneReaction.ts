/**
 * Support / resistance rectangles + live reaction:
 * hold vs break, закреп, проторговка под/над зоной, next dump/flight zone.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone } from '../indicators/types'
import type { Time } from 'lightweight-charts'
import { isBarClosed } from './closeCascade'
import { readCloseQuality, type CloseQuality } from './mmTrapThesis'

export type SrRole = 'SUPPORT' | 'RESISTANCE' | 'RANGE'
export type SrSource = 'CONGESTION' | 'SWING_CLUSTER' | 'DEALING' | 'EQUAL'

export type ZoneReactionState =
  | 'APPROACHING'
  | 'INSIDE'
  | 'HOLDING_ABOVE'
  | 'HOLDING_BELOW'
  | 'CONSOLIDATING_OVER'
  | 'CONSOLIDATING_UNDER'
  | 'BREAKING'
  | 'BROKEN'
  | 'RECLAIMED'

export interface SrBand {
  id: string
  role: SrRole
  source: SrSource
  top: number
  bottom: number
  startTimeSec: number
  endTimeSec: number
  touches: number
  strength: number
  tier: 'WEAK' | 'MEDIUM' | 'STRONG'
}

export type ZoneClosePosture =
  | 'HELD_ABOVE'
  | 'HELD_BELOW'
  | 'INSIDE'
  | 'BROKE_UP'
  | 'BROKE_DOWN'
  | 'WICK_REJECT'

export type ZoneStance =
  | 'HOLD_ABOVE'
  | 'HOLD_BELOW'
  | 'BREAK_UP'
  | 'BREAK_DOWN'
  | 'WAIT_4H'
  | 'CHOP'

export interface TfZoneClose {
  tf: '1h' | '4h'
  posture: ZoneClosePosture
  quality: CloseQuality
  close: number
  forming: boolean
  line: string
}

export interface ZoneCloseVerdict {
  h1: TfZoneClose | null
  h4: TfZoneClose | null
  stance: ZoneStance
  destination: { price: number; label: string } | null
  line: string
}

export interface ZoneDumpTarget {
  id: string
  top: number
  bottom: number
  label: string
}

export interface ZoneReaction {
  zone: SrBand
  state: ZoneReactionState
  holdProbability: number
  continueProbability: number
  breakProbability: number
  going: 'UP' | 'DOWN' | 'CHOP'
  heldCloses: number
  consolidating: boolean
  reclaimed: boolean
  /** Likely break target (aligned with going / lead side) */
  nextIfBreak: ZoneDumpTarget | null
  nextIfBreakUp: ZoneDumpTarget | null
  nextIfBreakDown: ZoneDumpTarget | null
  targetIfHold: { price: number; label: string } | null
  closes: ZoneCloseVerdict | null
  destination: { price: number; label: string } | null
  narrative: string
}

export interface ZoneReactionBoard {
  bands: SrBand[]
  reactions: ZoneReaction[]
  active: ZoneReaction | null
  line: string
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function tierOf(strength: number): SrBand['tier'] {
  if (strength >= 10) return 'STRONG'
  if (strength >= 7) return 'MEDIUM'
  return 'WEAK'
}

function atrApprox(candles: OhlcvCandle[], period = 14): number {
  if (candles.length < 3) return 0
  const n = Math.min(period, candles.length - 1)
  let sum = 0
  let c = 0
  for (let i = candles.length - n; i < candles.length; i++) {
    const prev = candles[i - 1]
    const cur = candles[i]
    if (!prev || !cur) continue
    sum += Math.max(
      cur[2] - cur[3],
      Math.abs(cur[2] - prev[4]),
      Math.abs(cur[3] - prev[4])
    )
    c++
  }
  return c > 0 ? sum / c : 0
}

function tsSec(c: OhlcvCandle): number {
  return Math.floor(c[0] / 1000)
}

function fmtPx(p: number): string {
  if (!Number.isFinite(p) || !(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  if (p >= 0.01) return p.toFixed(5)
  return p.toFixed(6)
}

function bandMid(z: SrBand): number {
  return (z.top + z.bottom) / 2
}

function overlaps(a: SrBand, b: SrBand, frac = 0.45): boolean {
  const ov = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom)
  const minH = Math.min(a.top - a.bottom, b.top - b.bottom)
  return minH > 0 && ov > minH * frac
}

interface Pivot {
  index: number
  price: number
  timeSec: number
  kind: 'HIGH' | 'LOW'
}

function findPivots(candles: OhlcvCandle[], radius = 2): Pivot[] {
  const out: Pivot[] = []
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
    if (isHigh) out.push({ index: i, price: h, timeSec: tsSec(candles[i]), kind: 'HIGH' })
    if (isLow) out.push({ index: i, price: l, timeSec: tsSec(candles[i]), kind: 'LOW' })
  }
  return out
}

function spanTimes(
  candles: OhlcvCandle[],
  top: number,
  bottom: number
): { start: number; end: number; lastTouch: number; stillLive: boolean } {
  const last = candles[candles.length - 1]
  const lastTs = last ? tsSec(last) : 0
  let first = -1
  let lastTouch = -1
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    if (c[2] >= bottom && c[3] <= top) {
      if (first < 0) first = i
      lastTouch = i
    }
  }
  if (first < 0) {
    return { start: lastTs, end: lastTs, lastTouch: lastTs, stillLive: false }
  }
  const pad = Math.max(priceAtr(candles) * 0.8, (top - bottom) * 0.4)
  const far =
    last != null &&
    (last[4] > top + pad || last[4] < bottom - pad) &&
    candles.length - 1 - lastTouch > 8
  return {
    start: tsSec(candles[first]),
    end: far ? tsSec(candles[lastTouch]) : lastTs,
    lastTouch: tsSec(candles[lastTouch]),
    stillLive: !far,
  }
}

function priceAtr(candles: OhlcvCandle[]): number {
  return atrApprox(candles)
}

function maxBandHeight(atr: number, price: number): number {
  return Math.max(atr * 1.25, price * 0.006)
}

function densestSlice(
  run: { a: number; b: number; sum: number },
  counts: number[],
  maxBins: number
): { a: number; b: number; sum: number } {
  const width = run.b - run.a + 1
  if (width <= maxBins) return run
  let bestA = run.a
  let bestSum = 0
  for (let a = run.a; a + maxBins - 1 <= run.b; a++) {
    let s = 0
    for (let k = 0; k < maxBins; k++) s += counts[a + k] ?? 0
    if (s > bestSum) {
      bestSum = s
      bestA = a
    }
  }
  return { a: bestA, b: bestA + maxBins - 1, sum: bestSum }
}

function congestionBands(candles: OhlcvCandle[], maxZones: number): SrBand[] {
  if (candles.length < 12) return []
  const window = candles.slice(-110)
  const highs = window.map((c) => c[2])
  const lows = window.map((c) => c[3])
  const minP = Math.min(...lows)
  const maxP = Math.max(...highs)
  if (!(maxP > minP)) return []
  const atr = atrApprox(window)
  const lastPx = window[window.length - 1]?.[4] ?? maxP

  const bins = 30
  const step = (maxP - minP) / bins
  if (!(step > 0)) return []
  const counts = new Array<number>(bins).fill(0)
  for (const c of window) {
    const a = Math.max(0, Math.floor((c[3] - minP) / step))
    const b = Math.min(bins - 1, Math.floor((c[2] - minP) / step))
    for (let i = a; i <= b; i++) counts[i]++
  }
  const avg = counts.reduce((s, n) => s + n, 0) / bins
  const thresh = Math.max(avg * 1.18, 3)

  const runs: { a: number; b: number; sum: number }[] = []
  let start = -1
  for (let i = 0; i <= bins; i++) {
    if (i < bins && counts[i] >= thresh) {
      if (start < 0) start = i
    } else if (start >= 0) {
      let sum = 0
      for (let k = start; k < i; k++) sum += counts[k]
      runs.push({ a: start, b: i - 1, sum })
      start = -1
    }
  }
  runs.sort((x, y) => y.sum - x.sum)

  const out: SrBand[] = []
  const cap = maxBandHeight(atr, lastPx)
  for (const raw of runs) {
    if (out.length >= maxZones) break
    const r = densestSlice(raw, counts, 4)
    const bottom = minP + r.a * step
    const top = minP + (r.b + 1) * step
    if (!(top > bottom) || top - bottom > cap) continue
    const span = spanTimes(window, top, bottom)
    const next: SrBand = {
      id: `sr_cong_${span.start}_${r.sum}`,
      role: 'RANGE',
      source: 'CONGESTION',
      top,
      bottom,
      startTimeSec: span.start,
      endTimeSec: span.end,
      touches: r.sum,
      strength: clamp(6 + Math.round(r.sum / 8), 6, 12),
      tier: 'MEDIUM',
    }
    if (!out.some((z) => overlaps(z, next))) out.push(next)
  }
  return out
}

function swingClusterBands(candles: OhlcvCandle[], maxZones: number): SrBand[] {
  const atr = atrApprox(candles)
  const last = candles[candles.length - 1]
  const price = last?.[4] ?? 0
  if (!(atr > 0) || !(price > 0)) return []
  const pivots = findPivots(candles, candles.length > 80 ? 2 : 1)
  const tol = Math.max(atr * 0.42, price * 0.0022)

  const cluster = (kind: 'HIGH' | 'LOW'): SrBand[] => {
    const pts = pivots.filter((p) => p.kind === kind).sort((a, b) => a.price - b.price)
    const groups: Pivot[][] = []
    let cur: Pivot[] = []
    for (const p of pts) {
      if (!cur.length || p.price - cur[cur.length - 1].price <= tol) {
        cur.push(p)
      } else {
        if (cur.length >= 2) groups.push(cur)
        cur = [p]
      }
    }
    if (cur.length >= 2) groups.push(cur)

    const bands: SrBand[] = []
    for (const g of groups) {
      const lo = Math.min(...g.map((x) => x.price))
      const hi = Math.max(...g.map((x) => x.price))
      let top = hi
      let bottom = lo
      const thin = top - bottom
      if (thin < atr * 0.22) {
        const mid = (top + bottom) / 2
        const half = atr * 0.22
        top = mid + half
        bottom = mid - half
      }
      if (top - bottom > maxBandHeight(atr, price)) continue
      const span = spanTimes(candles, top, bottom)
      bands.push({
        id: `sr_${kind === 'HIGH' ? 'res' : 'sup'}_${g[0].timeSec}_${g.length}`,
        role: kind === 'HIGH' ? 'RESISTANCE' : 'SUPPORT',
        source: 'SWING_CLUSTER',
        top,
        bottom,
        startTimeSec: Math.min(...g.map((x) => x.timeSec), span.start),
        endTimeSec: span.end,
        touches: g.length,
        strength: clamp(5 + g.length * 2, 6, 12),
        tier: g.length >= 3 ? 'STRONG' : 'MEDIUM',
      })
    }
    bands.sort((a, b) => b.touches - a.touches)
    return bands.slice(0, maxZones)
  }

  return [...cluster('HIGH'), ...cluster('LOW')]
}

function roleVsPrice(band: SrBand, price: number): SrRole {
  if (price > band.top) return 'SUPPORT'
  if (price < band.bottom) return 'RESISTANCE'
  return band.role === 'RANGE' ? 'RANGE' : band.role
}

function mergeBands(list: SrBand[], max = 6): SrBand[] {
  const sorted = [...list].sort((a, b) => {
    const ha = a.top - a.bottom
    const hb = b.top - b.bottom
    return b.strength - a.strength || ha - hb || b.touches - a.touches
  })
  const out: SrBand[] = []
  for (const z of sorted) {
    const hit = out.find((o) => overlaps(o, z, 0.42))
    if (!hit) {
      out.push({ ...z })
      continue
    }
    const hitH = hit.top - hit.bottom
    const zH = z.top - z.bottom
    if (zH < hitH * 0.88 && z.strength >= hit.strength - 2) {
      Object.assign(hit, z)
    } else {
      hit.touches = Math.max(hit.touches, z.touches)
      hit.strength = Math.max(hit.strength, z.strength)
    }
  }
  return out
    .filter((z) => z.top > z.bottom)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, max)
}

interface TapeRead {
  overlapping: boolean
  compression: number
  lowerHighs: boolean
  higherLows: boolean
  downCloses: number
  upCloses: number
  avgBodyPct: number
  displacement: 'UP' | 'DOWN' | 'NONE'
  lastClose: number
  lastHigh: number
  lastLow: number
}

function readTape(candles: OhlcvCandle[]): TapeRead {
  const empty: TapeRead = {
    overlapping: false,
    compression: 0,
    lowerHighs: false,
    higherLows: false,
    downCloses: 0,
    upCloses: 0,
    avgBodyPct: 0.5,
    displacement: 'NONE',
    lastClose: 0,
    lastHigh: 0,
    lastLow: 0,
  }
  if (candles.length < 4) return empty
  const last = candles.slice(-8)
  const cur = last[last.length - 1]
  let bodySum = 0
  let overlap = 0
  let lowerHighs = 0
  let higherLows = 0
  let downCloses = 0
  let upCloses = 0
  for (let i = 0; i < last.length; i++) {
    const [, o, h, l, c] = last[i]
    const range = h - l
    bodySum += range > 0 ? Math.abs(c - o) / range : 0
    if (c < o) downCloses++
    else if (c > o) upCloses++
    if (i > 0) {
      const prev = last[i - 1]
      if (h < prev[2] - (prev[2] - prev[3]) * 0.05) lowerHighs++
      if (l > prev[3] + (prev[2] - prev[3]) * 0.05) higherLows++
      const ov = Math.min(h, prev[2]) - Math.max(l, prev[3])
      if (ov > 0) overlap++
    }
  }
  const steps = last.length - 1
  const recent = atrApprox(last, 5)
  const prior = atrApprox(candles.slice(-20), 14)
  const compression = prior > 0 ? clamp(1 - recent / prior, 0, 1) : 0
  const lastRange = cur[2] - cur[3]
  const lastBody = Math.abs(cur[4] - cur[1])
  const displacement =
    lastRange > 0 && lastBody / lastRange >= 0.62
      ? cur[4] > cur[1]
        ? 'UP'
        : 'DOWN'
      : 'NONE'

  return {
    overlapping: steps > 0 && overlap / steps >= 0.58,
    compression,
    lowerHighs: steps > 0 && lowerHighs / steps >= 0.5,
    higherLows: steps > 0 && higherLows / steps >= 0.5,
    downCloses,
    upCloses,
    avgBodyPct: bodySum / last.length,
    displacement,
    lastClose: cur[4],
    lastHigh: cur[2],
    lastLow: cur[3],
  }
}

function countSideCloses(
  candles: OhlcvCandle[],
  n: number,
  pred: (close: number) => boolean
): number {
  const slice = candles.slice(-n)
  let c = 0
  for (const bar of slice) if (pred(bar[4])) c++
  return c
}

function assignTiers(bands: SrBand[], atr: number): void {
  for (const z of bands) {
    z.tier = tierOf(z.strength)
    if (z.source === 'EQUAL' && z.strength >= 10) z.tier = 'STRONG'
    if (z.source === 'SWING_CLUSTER' && z.touches >= 3) z.tier = 'STRONG'
  }
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i]
      const b = bands[j]
      const near = Math.abs(bandMid(a) - bandMid(b)) <= atr * 0.45
      if (!near && !overlaps(a, b, 0.28)) continue
      a.strength = Math.min(12, a.strength + 2)
      b.strength = Math.min(12, b.strength + 2)
      a.tier = 'STRONG'
      b.tier = 'STRONG'
    }
  }
}

function bandLabel(z: SrBand): string {
  const strong = z.tier === 'STRONG' ? 'сильную ' : ''
  const role =
    z.role === 'SUPPORT'
      ? `${strong}поддержку`
      : z.role === 'RESISTANCE'
        ? `${strong}сопротивление`
        : `${strong}зону`
  return `${role} ${fmtPx(z.bottom)}–${fmtPx(z.top)}`
}

function nextBand(
  bands: SrBand[],
  from: SrBand,
  dir: 'UP' | 'DOWN'
): ZoneDumpTarget | null {
  const mid = bandMid(from)
  const cands = bands
    .filter((z) => z.id !== from.id)
    .filter((z) => (dir === 'DOWN' ? bandMid(z) < mid : bandMid(z) > mid))
    .sort((a, b) =>
      dir === 'DOWN' ? bandMid(b) - bandMid(a) : bandMid(a) - bandMid(b)
    )
  if (!cands.length) return null
  const preferRole: SrRole = dir === 'UP' ? 'RESISTANCE' : 'SUPPORT'
  const roleFit = cands.filter((z) => z.role === preferRole)
  const strongFit = roleFit.filter((z) => z.tier === 'STRONG')
  const strongAny = cands.filter((z) => z.tier === 'STRONG')
  const nearest = cands[0]
  const pick =
    strongFit[0] ??
    roleFit[0] ??
    (strongAny[0] &&
    Math.abs(bandMid(strongAny[0]) - mid) <= Math.abs(bandMid(nearest) - mid) * 1.85
      ? strongAny[0]
      : nearest)
  return {
    id: pick.id,
    top: pick.top,
    bottom: pick.bottom,
    label: bandLabel(pick),
  }
}

function qualityRu(q: CloseQuality): string {
  if (q === 'DISPLACEMENT_UP') return 'тело вверх'
  if (q === 'DISPLACEMENT_DOWN') return 'тело вниз'
  if (q === 'REJECT_HIGH') return 'фитиль сверху'
  if (q === 'REJECT_LOW') return 'фитиль снизу'
  if (q === 'INDECISION') return 'доджи'
  return 'обычное тело'
}

function postureRu(p: ZoneClosePosture): string {
  if (p === 'HELD_ABOVE') return 'закреп над'
  if (p === 'HELD_BELOW') return 'закреп под'
  if (p === 'BROKE_UP') return 'пробили вверх'
  if (p === 'BROKE_DOWN') return 'пробили вниз'
  if (p === 'WICK_REJECT') return 'фитиль + закрылись обратно'
  return 'внутри'
}

function readTfZoneClose(
  candles: OhlcvCandle[] | undefined,
  barMs: number,
  zone: SrBand,
  tf: '1h' | '4h',
  atr: number
): TfZoneClose | null {
  if (!candles || candles.length < 2) return null
  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  if (!last) return null
  const forming = !isBarClosed(last, barMs)
  const pad = Math.max(atr * 0.1, (zone.top - zone.bottom) * 0.08, last[4] * 0.00025)
  const close = last[4]
  const prevC = prev?.[4] ?? close
  const wickUp = last[2] > zone.top && close <= zone.top
  const wickDn = last[3] < zone.bottom && close >= zone.bottom
  let posture: ZoneClosePosture
  if (close > zone.top + pad) {
    posture = prevC <= zone.top + pad ? 'BROKE_UP' : 'HELD_ABOVE'
  } else if (close < zone.bottom - pad) {
    posture = prevC >= zone.bottom - pad ? 'BROKE_DOWN' : 'HELD_BELOW'
  } else if (wickUp || wickDn) {
    posture = 'WICK_REJECT'
  } else {
    posture = 'INSIDE'
  }
  const quality = readCloseQuality(last)
  const name = tf === '1h' ? '1ч' : '4ч'
  const live = forming ? 'закрывается' : 'закрылся'
  return {
    tf,
    posture,
    quality,
    close,
    forming,
    line: `${name} ${live}: ${postureRu(posture)} · ${qualityRu(quality)}`,
  }
}

function isAbove(p: ZoneClosePosture): boolean {
  return p === 'HELD_ABOVE' || p === 'BROKE_UP'
}
function isBelow(p: ZoneClosePosture): boolean {
  return p === 'HELD_BELOW' || p === 'BROKE_DOWN'
}

function judgeCloses(
  h1: TfZoneClose | null,
  h4: TfZoneClose | null,
  zone: SrBand,
  bands: SrBand[]
): ZoneCloseVerdict {
  const h4p = h4?.posture
  const h1p = h1?.posture
  let stance: ZoneStance = 'CHOP'
  if (h4p && h1p) {
    if (isAbove(h4p) && isAbove(h1p)) {
      stance = h4p === 'BROKE_UP' || h1p === 'BROKE_UP' ? 'BREAK_UP' : 'HOLD_ABOVE'
    } else if (isBelow(h4p) && isBelow(h1p)) {
      stance = h4p === 'BROKE_DOWN' || h1p === 'BROKE_DOWN' ? 'BREAK_DOWN' : 'HOLD_BELOW'
    } else if (isAbove(h4p) && isBelow(h1p)) {
      stance = 'WAIT_4H'
    } else if (isBelow(h4p) && isAbove(h1p)) {
      stance = 'WAIT_4H'
    } else if (h4p === 'WICK_REJECT' || h1p === 'WICK_REJECT') {
      stance = isAbove(h4p ?? 'INSIDE') ? 'HOLD_ABOVE' : isBelow(h4p ?? 'INSIDE') ? 'HOLD_BELOW' : 'CHOP'
    } else if (isAbove(h4p)) stance = 'HOLD_ABOVE'
    else if (isBelow(h4p)) stance = 'HOLD_BELOW'
    else stance = 'CHOP'
  } else if (h4p) {
    stance = isAbove(h4p)
      ? h4p === 'BROKE_UP'
        ? 'BREAK_UP'
        : 'HOLD_ABOVE'
      : isBelow(h4p)
        ? h4p === 'BROKE_DOWN'
          ? 'BREAK_DOWN'
          : 'HOLD_BELOW'
        : 'CHOP'
  } else if (h1p) {
    stance = isAbove(h1p)
      ? h1p === 'BROKE_UP'
        ? 'BREAK_UP'
        : 'HOLD_ABOVE'
      : isBelow(h1p)
        ? h1p === 'BROKE_DOWN'
          ? 'BREAK_DOWN'
          : 'HOLD_BELOW'
        : 'CHOP'
  }

  const dir: 'UP' | 'DOWN' | null =
    stance === 'HOLD_ABOVE' || stance === 'BREAK_UP'
      ? 'UP'
      : stance === 'HOLD_BELOW' || stance === 'BREAK_DOWN'
        ? 'DOWN'
        : stance === 'WAIT_4H'
          ? h4p && isAbove(h4p)
            ? 'UP'
            : h4p && isBelow(h4p)
              ? 'DOWN'
              : null
          : null
  const nxt = dir ? nextBand(bands, zone, dir) : null
  const destination = nxt
    ? {
        price: dir === 'UP' ? nxt.bottom : nxt.top,
        label: nxt.label,
      }
    : null

  const bits = [h4?.line, h1?.line].filter(Boolean)
  let destLine = ''
  if (stance === 'WAIT_4H') {
    destLine = h4p && isAbove(h4p)
      ? `Час ушёл вниз, 4ч ещё над зоной — цель не сливаем, ждём закрытие 4ч`
      : `Час выкупили, 4ч ещё под зоной — вверх не подтверждаем без 4ч`
    if (destination) destLine += ` · если 4ч подтвердит: ${destination.label}`
  } else if (destination) {
    destLine =
      stance === 'BREAK_DOWN' || stance === 'HOLD_BELOW'
        ? `Цель вниз: ${destination.label}`
        : `Цель вверх: ${destination.label}`
  } else if (stance === 'CHOP') {
    destLine = '1ч и 4ч не согласны — цели нет, пока пила в зоне'
  }
  const strong = zone.tier === 'STRONG' ? 'сильная ' : ''
  const role =
    zone.role === 'SUPPORT' ? 'поддержка' : zone.role === 'RESISTANCE' ? 'сопротивление' : 'зона'
  const line = [`${strong}${role} ${fmtPx(zone.bottom)}–${fmtPx(zone.top)}`, ...bits, destLine]
    .filter(Boolean)
    .join(' · ')

  return { h1, h4, stance, destination, line }
}

function isFatBand(z: SrBand, atr: number): boolean {
  const h = z.top - z.bottom
  return h > Math.max(atr * 1.35, z.bottom * 0.008)
}

function edgeDist(z: SrBand, price: number): number {
  if (price <= z.top && price >= z.bottom) return 0
  return Math.min(Math.abs(price - z.top), Math.abs(price - z.bottom))
}

function pickActive(
  reactions: ZoneReaction[],
  price: number,
  atr: number
): ZoneReaction | null {
  if (!reactions.length) return null
  const slim = reactions.filter((r) => !isFatBand(r.zone, atr))
  const pool = slim.length ? slim : reactions
  const score = (r: ZoneReaction): number => {
    let s = 0
    if (r.state === 'CONSOLIDATING_UNDER' || r.state === 'CONSOLIDATING_OVER') s += 42
    else if (r.state === 'HOLDING_ABOVE' || r.state === 'HOLDING_BELOW') s += 38
    else if (r.state === 'RECLAIMED') s += 36
    else if (r.state === 'BREAKING') s += 34
    else if (r.state === 'APPROACHING') s += 30
    else if (r.state === 'INSIDE') s += 10
    else if (r.state === 'BROKEN') s += 4
    const edge = edgeDist(r.zone, price)
    const width = r.zone.top - r.zone.bottom
    const scale = Math.max(atr, price * 0.001)
    s -= (edge / scale) * 12
    if (price <= r.zone.top && price >= r.zone.bottom) s -= (width / scale) * 8
    if (r.zone.tier === 'STRONG' && edge <= scale * 2.2) s += 14
    if (r.closes?.stance === 'HOLD_ABOVE' || r.closes?.stance === 'HOLD_BELOW') s += 8
    if (r.closes?.stance === 'BREAK_UP' || r.closes?.stance === 'BREAK_DOWN') s += 10
    return s
  }
  return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null
}

function classifyState(
  zone: SrBand,
  candles: OhlcvCandle[],
  price: number,
  tape: TapeRead,
  atr: number
): {
  state: ZoneReactionState
  heldCloses: number
  consolidating: boolean
  reclaimed: boolean
} {
  const top = zone.top
  const bot = zone.bottom
  const pad = Math.max(atr * 0.12, (top - bot) * 0.08, price * 0.0003)
  const above = countSideCloses(candles, 4, (c) => c > top + pad * 0.25)
  const below = countSideCloses(candles, 4, (c) => c < bot - pad * 0.25)
  const insideN = countSideCloses(candles, 4, (c) => c <= top && c >= bot)
  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const close = last?.[4] ?? price
  const wickUp = (last?.[2] ?? close) > top && close < top
  const wickDn = (last?.[3] ?? close) < bot && close > bot
  const closedUp = close > top + pad
  const closedDn = close < bot - pad
  const prevBelow = (prev?.[4] ?? close) < bot
  const prevAbove = (prev?.[4] ?? close) > top
  const chopped = tape.overlapping || tape.compression >= 0.28

  if (wickUp && prevBelow && close <= top) {
    return { state: 'RECLAIMED', heldCloses: below, consolidating: chopped, reclaimed: true }
  }
  if (wickDn && prevAbove && close >= bot) {
    return { state: 'RECLAIMED', heldCloses: above, consolidating: chopped, reclaimed: true }
  }

  if (close <= top && close >= bot) {
    return {
      state: 'INSIDE',
      heldCloses: insideN,
      consolidating: chopped,
      reclaimed: false,
    }
  }

  if (closedDn) {
    if (below >= 2 && chopped) {
      return {
        state: 'CONSOLIDATING_UNDER',
        heldCloses: below,
        consolidating: true,
        reclaimed: false,
      }
    }
    if (below >= 2) {
      return {
        state: 'HOLDING_BELOW',
        heldCloses: below,
        consolidating: false,
        reclaimed: false,
      }
    }
    if (prevAbove || insideN > 0) {
      return { state: 'BREAKING', heldCloses: below, consolidating: false, reclaimed: false }
    }
    return { state: 'BROKEN', heldCloses: below, consolidating: false, reclaimed: false }
  }

  if (closedUp) {
    if (above >= 2 && chopped) {
      return {
        state: 'CONSOLIDATING_OVER',
        heldCloses: above,
        consolidating: true,
        reclaimed: false,
      }
    }
    if (above >= 2) {
      return {
        state: 'HOLDING_ABOVE',
        heldCloses: above,
        consolidating: false,
        reclaimed: false,
      }
    }
    if (prevBelow || insideN > 0) {
      return { state: 'BREAKING', heldCloses: above, consolidating: false, reclaimed: false }
    }
    return { state: 'BROKEN', heldCloses: above, consolidating: false, reclaimed: false }
  }

  const dist = close > top ? close - top : bot - close
  if (dist <= atr * 1.15) {
    return {
      state: 'APPROACHING',
      heldCloses: Math.max(above, below),
      consolidating: chopped,
      reclaimed: false,
    }
  }

  if (close > top) {
    return {
      state: above >= 2 ? 'HOLDING_ABOVE' : 'APPROACHING',
      heldCloses: above,
      consolidating: chopped && above >= 2,
      reclaimed: false,
    }
  }
  return {
    state: below >= 2 ? 'HOLDING_BELOW' : 'APPROACHING',
    heldCloses: below,
    consolidating: chopped && below >= 2,
    reclaimed: false,
  }
}

function goingFrom(
  state: ZoneReactionState,
  tape: TapeRead,
  role: SrRole,
  preferredSide?: 'LONG' | 'SHORT' | null
): 'UP' | 'DOWN' | 'CHOP' {
  if (state === 'CONSOLIDATING_UNDER' || state === 'HOLDING_BELOW') {
    if (tape.displacement === 'DOWN' || (tape.lowerHighs && tape.downCloses >= tape.upCloses)) {
      return 'DOWN'
    }
    if (tape.higherLows && tape.upCloses > tape.downCloses) return 'UP'
    return role === 'RESISTANCE' ? 'DOWN' : 'CHOP'
  }
  if (state === 'CONSOLIDATING_OVER' || state === 'HOLDING_ABOVE') {
    if (tape.displacement === 'UP' || (tape.higherLows && tape.upCloses >= tape.downCloses)) {
      return 'UP'
    }
    if (tape.lowerHighs && tape.downCloses > tape.upCloses) return 'DOWN'
    return role === 'SUPPORT' ? 'UP' : 'CHOP'
  }
  if (state === 'INSIDE' || state === 'APPROACHING') {
    if (tape.displacement === 'UP' && preferredSide !== 'SHORT') return 'UP'
    if (tape.displacement === 'DOWN' && preferredSide !== 'LONG') return 'DOWN'
    if (preferredSide === 'LONG') return tape.lowerHighs ? 'CHOP' : 'UP'
    if (preferredSide === 'SHORT') return tape.higherLows ? 'CHOP' : 'DOWN'
    return 'CHOP'
  }
  if (state === 'BREAKING') {
    if (tape.displacement === 'UP') return 'UP'
    if (tape.displacement === 'DOWN') return 'DOWN'
  }
  if (tape.displacement === 'UP') return 'UP'
  if (tape.displacement === 'DOWN') return 'DOWN'
  return 'CHOP'
}

function scoreHold(opts: {
  state: ZoneReactionState
  zone: SrBand
  tape: TapeRead
  heldCloses: number
  reclaimed: boolean
  structureHeld?: boolean
  preferredSide?: 'LONG' | 'SHORT' | null
}): number {
  let p = 50
  const { state, zone, tape, heldCloses, reclaimed, structureHeld, preferredSide } = opts
  p += clamp(zone.touches * 1.6, 0, 10)
  p += clamp(heldCloses * 4.5, 0, 14)
  if (zone.strength >= 10) p += 3

  if (state === 'HOLDING_ABOVE' || state === 'HOLDING_BELOW') p += 10
  if (state === 'CONSOLIDATING_UNDER' || state === 'CONSOLIDATING_OVER') p += 8
  if (state === 'RECLAIMED' || reclaimed) p += 12
  if (state === 'INSIDE') p += zone.role === 'RANGE' ? -2 : 1
  if (state === 'APPROACHING') p += 1
  if (state === 'BREAKING') p -= 14
  if (state === 'BROKEN') p -= 22

  if (tape.overlapping) p += 4
  if (tape.compression >= 0.3) p += 3
  if (tape.displacement === 'DOWN' && state === 'HOLDING_ABOVE') p -= 8
  if (tape.displacement === 'UP' && state === 'HOLDING_BELOW') p -= 8
  if (tape.displacement === 'DOWN' && (state === 'BREAKING' || state === 'CONSOLIDATING_UNDER')) {
    p -= 6
  }
  if (tape.displacement === 'UP' && (state === 'BREAKING' || state === 'CONSOLIDATING_OVER')) {
    p -= 6
  }

  const holdSide: 'LONG' | 'SHORT' | null =
    state === 'HOLDING_ABOVE' || state === 'CONSOLIDATING_OVER'
      ? 'LONG'
      : state === 'HOLDING_BELOW' || state === 'CONSOLIDATING_UNDER'
        ? 'SHORT'
        : zone.role === 'SUPPORT'
          ? 'LONG'
          : zone.role === 'RESISTANCE'
            ? 'SHORT'
            : null
  if (state !== 'INSIDE' && state !== 'APPROACHING') {
    if (preferredSide && holdSide && preferredSide === holdSide) p += 8
    else if (preferredSide && holdSide && preferredSide !== holdSide) p -= 7
    if (structureHeld && holdSide && preferredSide === holdSide) p += 5
  }

  return Math.round(clamp(p, 22, 78))
}

function rolePhrase(
  role: SrRole,
  where: 'над' | 'под' | 'к' | 'внутри' | 'имя'
): string {
  if (where === 'имя') {
    return role === 'SUPPORT' ? 'поддержка' : role === 'RESISTANCE' ? 'сопротивление' : 'зона'
  }
  if (role === 'SUPPORT') {
    if (where === 'над') return 'над поддержкой'
    if (where === 'под') return 'под поддержкой'
    if (where === 'к') return 'к поддержке'
    return 'внутри поддержки'
  }
  if (role === 'RESISTANCE') {
    if (where === 'над') return 'над сопротивлением'
    if (where === 'под') return 'под сопротивлением'
    if (where === 'к') return 'к сопротивлению'
    return 'внутри сопротивления'
  }
  if (where === 'над') return 'над зоной'
  if (where === 'под') return 'под зоной'
  if (where === 'к') return 'к зоне'
  return 'внутри зоны'
}

function narrativeOf(r: Omit<ZoneReaction, 'narrative'>): string {
  const z = r.zone
  const band = `${fmtPx(z.bottom)}–${fmtPx(z.top)}`
  const breakBoth =
    r.nextIfBreakUp && r.nextIfBreakDown
      ? ` · слом ↑ ${r.nextIfBreakUp.label} · слом ↓ ${r.nextIfBreakDown.label}`
      : r.nextIfBreak
        ? r.going === 'UP'
          ? ` · если слом — летим в ${r.nextIfBreak.label}`
          : ` · если слом — льёмся в ${r.nextIfBreak.label}`
        : ''
  const breakIsUp =
    r.state === 'HOLDING_BELOW' || r.state === 'CONSOLIDATING_UNDER'
  const next =
    r.state === 'INSIDE' || r.state === 'APPROACHING'
      ? breakBoth
      : r.nextIfBreak
        ? breakIsUp || r.going === 'UP'
          ? ` · если слом — летим в ${r.nextIfBreak.label}`
          : ` · если слом — льёмся в ${r.nextIfBreak.label}`
        : ''
  const holdTo = r.targetIfHold
    ? ` · дальше ${r.targetIfHold.label} ${fmtPx(r.targetIfHold.price)}`
    : ''

  const closeLead = r.closes?.line ? `${r.closes.line}. ` : ''
  switch (r.state) {
    case 'HOLDING_ABOVE':
      return `${closeLead}Закреп ${rolePhrase(z.role, 'над')} ${band} держит (${r.holdProbability}%). Идём дальше ${r.continueProbability}%.${holdTo}${next}`
    case 'HOLDING_BELOW':
      return `Закрепились ${rolePhrase(z.role, 'под')} ${band} (${r.holdProbability}%). ${
        r.going === 'DOWN' ? 'Идём вниз' : r.going === 'UP' ? 'Ещё не вниз — пила' : 'Пока пила'
      } ${r.continueProbability}%.${holdTo}${next}`
    case 'CONSOLIDATING_UNDER':
      return `Проторговка ${rolePhrase(z.role, 'под')} ${band}. ${
        r.going === 'DOWN'
          ? `Держим закреп снизу, вероятность вниз ${r.continueProbability}%`
          : r.going === 'UP'
            ? `Пока не вниз — копят под зоной, слом вверх ${r.breakProbability}%`
            : `Пила под зоной, удерж ${r.holdProbability}%`
      }.${next}`
    case 'CONSOLIDATING_OVER':
      return `Проторговка ${rolePhrase(z.role, 'над')} ${band}. ${
        r.going === 'UP'
          ? `Закреп сверху держит, вверх ${r.continueProbability}%`
          : r.going === 'DOWN'
            ? `Слабый закреп, риск слива ${r.breakProbability}%`
            : `Пила над зоной, удерж ${r.holdProbability}%`
      }.${next}`
    case 'RECLAIMED':
      return `Ложный пробой ${rolePhrase(z.role, 'имя')} ${band} + закреп обратно (${r.holdProbability}%).${holdTo}`
    case 'BREAKING':
      return `Ломаем ${rolePhrase(z.role, 'имя')} ${band} (${r.breakProbability}%).${next}`
    case 'BROKEN':
      return `Зона ${band} сломана. ${r.nextIfBreak ? `Льёмся / летим в ${r.nextIfBreak.label}` : 'Ищем следующую зону'}.`
    case 'INSIDE':
      return `${rolePhrase(z.role, 'внутри')} ${band}: удерж ${r.holdProbability}% · слом ${r.breakProbability}%.${breakBoth}`
    case 'APPROACHING':
      return `Подход ${rolePhrase(z.role, 'к')} ${band}. Удерж ${r.holdProbability}%, слом ${r.breakProbability}%.${breakBoth}`
    default:
      return `${rolePhrase(z.role, 'имя')} ${band}`
  }
}

export function hintForReaction(r: ZoneReaction): string {
  const role =
    (r.zone.tier === 'STRONG' ? 'сил. ' : '') +
    (r.zone.role === 'SUPPORT' ? 'подд.' : r.zone.role === 'RESISTANCE' ? 'сопр.' : 'зона')
  const tf =
    r.closes?.h1 && r.closes?.h4
      ? ` · 1ч ${postureRu(r.closes.h1.posture)} · 4ч ${postureRu(r.closes.h4.posture)}`
      : r.closes?.h1
        ? ` · 1ч ${postureRu(r.closes.h1.posture)}`
        : ''
  const dest = r.destination ? ` → ${r.destination.label}` : ''
  switch (r.state) {
    case 'HOLDING_ABOVE':
      return `${role} · закреп над · ${r.holdProbability}%${tf}${dest}`
    case 'HOLDING_BELOW':
      return `${role} · закреп под · ${r.holdProbability}%${tf}${dest}`
    case 'CONSOLIDATING_UNDER':
      return `${role} · проторг. под · ${r.going === 'DOWN' ? 'вниз' : r.going === 'UP' ? 'вверх?' : 'пила'} ${r.continueProbability}%${tf}${dest}`
    case 'CONSOLIDATING_OVER':
      return `${role} · проторг. над · ${r.going === 'UP' ? 'вверх' : r.going === 'DOWN' ? 'вниз?' : 'пила'} ${r.continueProbability}%${tf}${dest}`
    case 'BREAKING':
      return `${role} · ломаем · ${r.breakProbability}%${tf}${dest}`
    case 'BROKEN':
      return `${role} · слом → ${r.destination?.label ?? r.nextIfBreak?.label ?? 'дальше'}${tf}`
    case 'RECLAIMED':
      return `${role} · ложный + закреп · ${r.holdProbability}%${tf}`
    case 'INSIDE':
      return `${role} · внутри · удерж ${r.holdProbability}%${tf}`
    case 'APPROACHING':
      return `${role} · подход · удерж ${r.holdProbability}%${tf}`
    default:
      return role + tf
  }
}

export function discoverSrBands(opts: {
  candles: OhlcvCandle[]
  htfCandles?: OhlcvCandle[]
  price: number
  dealingHigh?: number | null
  dealingLow?: number | null
  equalHighs?: Array<{ price: number; strength: string; isActive: boolean }>
  equalLows?: Array<{ price: number; strength: string; isActive: boolean }>
  maxBands?: number
}): SrBand[] {
  const { candles, price, maxBands = 6 } = opts
  if (candles.length < 12 || !(price > 0)) return []
  const atr = atrApprox(candles)
  const raw: SrBand[] = [
    ...congestionBands(candles, 4),
    ...swingClusterBands(candles, 4),
  ]
  if (opts.htfCandles && opts.htfCandles.length >= 16) {
    raw.push(
      ...congestionBands(opts.htfCandles, 2).map((z) => ({
        ...z,
        id: `sr_htf_${z.id}`,
        strength: Math.min(12, z.strength + 1),
      })),
      ...swingClusterBands(opts.htfCandles, 2).map((z) => ({
        ...z,
        id: `sr_htf_${z.id}`,
        strength: Math.min(12, z.strength + 1),
      }))
    )
  }

  const dHi = opts.dealingHigh
  const dLo = opts.dealingLow
  if (dHi != null && dLo != null && dHi > dLo && atr > 0) {
    const thinTop: SrBand = {
      id: `sr_deal_hi_${Math.round(dHi * 1e6)}`,
      role: 'RESISTANCE',
      source: 'DEALING',
      top: dHi + atr * 0.18,
      bottom: dHi - atr * 0.18,
      startTimeSec: tsSec(candles[Math.max(0, Math.floor(candles.length * 0.4))]),
      endTimeSec: tsSec(candles[candles.length - 1]),
      touches: 3,
      strength: 8,
      tier: 'MEDIUM',
    }
    const thinBot: SrBand = {
      id: `sr_deal_lo_${Math.round(dLo * 1e6)}`,
      role: 'SUPPORT',
      source: 'DEALING',
      top: dLo + atr * 0.18,
      bottom: dLo - atr * 0.18,
      startTimeSec: tsSec(candles[Math.max(0, Math.floor(candles.length * 0.4))]),
      endTimeSec: tsSec(candles[candles.length - 1]),
      touches: 3,
      strength: 8,
      tier: 'MEDIUM',
    }
    raw.push(thinTop, thinBot)
  }

  const eqPad = Math.max(atr * 0.2, price * 0.0012)
  for (const eh of opts.equalHighs ?? []) {
    if (!eh.isActive || !(eh.price > 0)) continue
    raw.push({
      id: `sr_eqh_${Math.round(eh.price * 1e6)}`,
      role: 'RESISTANCE',
      source: 'EQUAL',
      top: eh.price + eqPad,
      bottom: eh.price - eqPad * 0.35,
      startTimeSec: tsSec(candles[Math.max(0, Math.floor(candles.length * 0.35))]),
      endTimeSec: tsSec(candles[candles.length - 1]),
      touches: eh.strength === 'STRONG' ? 5 : eh.strength === 'MEDIUM' ? 3 : 2,
      strength: eh.strength === 'STRONG' ? 11 : eh.strength === 'MEDIUM' ? 8 : 6,
      tier: eh.strength === 'STRONG' ? 'STRONG' : eh.strength === 'MEDIUM' ? 'MEDIUM' : 'WEAK',
    })
  }
  for (const el of opts.equalLows ?? []) {
    if (!el.isActive || !(el.price > 0)) continue
    raw.push({
      id: `sr_eql_${Math.round(el.price * 1e6)}`,
      role: 'SUPPORT',
      source: 'EQUAL',
      top: el.price + eqPad * 0.35,
      bottom: el.price - eqPad,
      startTimeSec: tsSec(candles[Math.max(0, Math.floor(candles.length * 0.35))]),
      endTimeSec: tsSec(candles[candles.length - 1]),
      touches: el.strength === 'STRONG' ? 5 : el.strength === 'MEDIUM' ? 3 : 2,
      strength: el.strength === 'STRONG' ? 11 : el.strength === 'MEDIUM' ? 8 : 6,
      tier: el.strength === 'STRONG' ? 'STRONG' : el.strength === 'MEDIUM' ? 'MEDIUM' : 'WEAK',
    })
  }

  const merged = mergeBands(raw, maxBands + 2).filter(
    (z) => z.top - z.bottom <= maxBandHeight(atr, price) * 1.15
  )
  assignTiers(merged, atr)
  for (const z of merged) {
    z.role = roleVsPrice(z, price)
    if (z.id.startsWith('sr_cong') || z.id.includes('cong')) {
      z.id = `sr_${z.role === 'SUPPORT' ? 'sup' : z.role === 'RESISTANCE' ? 'res' : 'rng'}_${z.startTimeSec}_${z.touches}`
    } else if (z.role === 'SUPPORT' && !z.id.includes('sup') && !z.id.includes('eql')) {
      z.id = z.id.replace('sr_res_', 'sr_sup_')
    } else if (z.role === 'RESISTANCE' && !z.id.includes('res') && !z.id.includes('eqh')) {
      z.id = z.id.replace('sr_sup_', 'sr_res_')
    }
  }

  return merged
    .sort((a, b) => {
      const da = Math.min(Math.abs(price - a.top), Math.abs(price - a.bottom), Math.abs(price - bandMid(a)))
      const db = Math.min(Math.abs(price - b.top), Math.abs(price - b.bottom), Math.abs(price - bandMid(b)))
      return da - db || b.strength - a.strength
    })
    .slice(0, maxBands)
}

export function buildZoneReactionBoard(opts: {
  candles: OhlcvCandle[]
  htfCandles?: OhlcvCandle[]
  candles1h?: OhlcvCandle[]
  candles4h?: OhlcvCandle[]
  tape?: OhlcvCandle[]
  price: number
  dealingHigh?: number | null
  dealingLow?: number | null
  structureHeld?: boolean
  preferredSide?: 'LONG' | 'SHORT' | null
  magnet?: { price: number; label: string } | null
  equalHighs?: Array<{ price: number; strength: string; isActive: boolean }>
  equalLows?: Array<{ price: number; strength: string; isActive: boolean }>
}): ZoneReactionBoard {
  const empty: ZoneReactionBoard = { bands: [], reactions: [], active: null, line: '' }
  const { price } = opts
  if (!(price > 0)) return empty
  const discoverSrc = opts.candles.length >= 12 ? opts.candles : opts.tape ?? []
  if (discoverSrc.length < 12) return empty

  const bands = discoverSrBands({
    candles: discoverSrc,
    htfCandles: opts.htfCandles,
    price,
    dealingHigh: opts.dealingHigh,
    dealingLow: opts.dealingLow,
    equalHighs: opts.equalHighs,
    equalLows: opts.equalLows,
    maxBands: 6,
  })
  if (!bands.length) return empty

  const classifySrc = discoverSrc
  const tapeSrc = opts.tape && opts.tape.length >= 6 ? opts.tape : discoverSrc
  const tape = readTape(tapeSrc)
  const atr = atrApprox(classifySrc)

  const reactions: ZoneReaction[] = bands.map((zone) => {
    const cls = classifyState(zone, classifySrc, price, tape, atr)
    let going = goingFrom(cls.state, tape, zone.role, opts.preferredSide)
    const holdProbability = scoreHold({
      state: cls.state,
      zone,
      tape,
      heldCloses: cls.heldCloses,
      reclaimed: cls.reclaimed,
      structureHeld: opts.structureHeld,
      preferredSide: opts.preferredSide,
    })
    const breakProbability = 100 - holdProbability
    let continueProbability = Math.round(clamp(holdProbability * 0.45, 20, 58))
    if (cls.state === 'CONSOLIDATING_UNDER' || cls.state === 'HOLDING_BELOW') {
      continueProbability = Math.round(
        clamp(
          holdProbability * 0.72 +
            (going === 'DOWN' ? 16 : 0) +
            (tape.displacement === 'DOWN' ? 8 : 0) +
            (tape.lowerHighs ? 6 : 0),
          24,
          78
        )
      )
    } else if (cls.state === 'CONSOLIDATING_OVER' || cls.state === 'HOLDING_ABOVE') {
      continueProbability = Math.round(
        clamp(
          holdProbability * 0.72 +
            (going === 'UP' ? 16 : 0) +
            (tape.displacement === 'UP' ? 8 : 0) +
            (tape.higherLows ? 6 : 0),
          24,
          78
        )
      )
    } else if (cls.state === 'INSIDE' || cls.state === 'APPROACHING') {
      continueProbability = Math.round(
        clamp(
          32 +
            (going === 'UP' || going === 'DOWN' ? 12 : 0) +
            (opts.preferredSide ? 6 : 0),
          22,
          62
        )
      )
    }

    const h1c = readTfZoneClose(
      opts.candles1h && opts.candles1h.length >= 2 ? opts.candles1h : discoverSrc,
      3_600_000,
      zone,
      '1h',
      atr
    )
    const h4c = readTfZoneClose(
      opts.candles4h && opts.candles4h.length >= 2
        ? opts.candles4h
        : opts.htfCandles && opts.htfCandles.length >= 2
          ? opts.htfCandles
          : undefined,
      14_400_000,
      zone,
      '4h',
      atrApprox(opts.candles4h ?? opts.htfCandles ?? classifySrc)
    )
    const closes = judgeCloses(h1c, h4c, zone, bands)
    if (closes.stance === 'HOLD_ABOVE' || closes.stance === 'BREAK_UP') going = 'UP'
    else if (closes.stance === 'HOLD_BELOW' || closes.stance === 'BREAK_DOWN') going = 'DOWN'
    else if (closes.stance === 'WAIT_4H') {
      going = h4c && isAbove(h4c.posture) ? 'UP' : h4c && isBelow(h4c.posture) ? 'DOWN' : 'CHOP'
    }

    const nextIfBreakUp = nextBand(bands, zone, 'UP')
    const nextIfBreakDown = nextBand(bands, zone, 'DOWN')
    const likelyBreak: 'UP' | 'DOWN' =
      cls.state === 'HOLDING_BELOW' || cls.state === 'CONSOLIDATING_UNDER'
        ? 'UP'
        : cls.state === 'HOLDING_ABOVE' || cls.state === 'CONSOLIDATING_OVER'
          ? 'DOWN'
          : going === 'UP' || opts.preferredSide === 'LONG'
            ? 'UP'
            : going === 'DOWN' || opts.preferredSide === 'SHORT'
              ? 'DOWN'
              : 'UP'
    const nextIfBreak = likelyBreak === 'UP' ? nextIfBreakUp : nextIfBreakDown
    const holdDir: 'UP' | 'DOWN' =
      zone.role === 'RESISTANCE' ||
      cls.state === 'HOLDING_BELOW' ||
      cls.state === 'CONSOLIDATING_UNDER'
        ? 'DOWN'
        : zone.role === 'SUPPORT' ||
            cls.state === 'HOLDING_ABOVE' ||
            cls.state === 'CONSOLIDATING_OVER'
          ? 'UP'
          : opts.preferredSide === 'SHORT'
            ? 'DOWN'
            : 'UP'

    let targetIfHold: { price: number; label: string } | null = null
    const mag = opts.magnet
    if (mag && mag.price > 0) {
      const aligned =
        (holdDir === 'UP' && mag.price > price) || (holdDir === 'DOWN' && mag.price < price)
      if (aligned) targetIfHold = mag
    }
    if (closes.destination) {
      targetIfHold = closes.destination
    } else if (!targetIfHold) {
      const nxt = nextBand(bands, zone, holdDir)
      if (nxt) {
        targetIfHold = {
          price: holdDir === 'UP' ? nxt.bottom : nxt.top,
          label: nxt.label,
        }
      }
    }

    const draft: Omit<ZoneReaction, 'narrative'> = {
      zone,
      state: cls.state,
      holdProbability,
      continueProbability,
      breakProbability,
      going,
      heldCloses: cls.heldCloses,
      consolidating: cls.consolidating,
      reclaimed: cls.reclaimed,
      nextIfBreak,
      nextIfBreakUp,
      nextIfBreakDown,
      targetIfHold,
      closes,
      destination: closes.destination ?? targetIfHold,
    }
    return { ...draft, narrative: closes.line || narrativeOf(draft) }
  })

  const active = pickActive(reactions, price, atr)

  return {
    bands,
    reactions,
    active,
    line: active?.closes?.line || active?.narrative || '',
  }
}

export function srBoardToLiquidityZones(
  board: ZoneReactionBoard | null | undefined,
  visibleEnd: Time
): LiquidityZone[] {
  if (!board?.reactions.length) return []
  return board.reactions.map((r) => {
    const z = r.zone
    const type: LiquidityZone['type'] =
      z.role === 'SUPPORT' ? 'SSL' : z.role === 'RESISTANCE' ? 'BSL' : 'VALUE_AREA'
    const side: LiquidityZone['side'] =
      z.role === 'SUPPORT' ? 'BULLISH' : z.role === 'RESISTANCE' ? 'BEARISH' : 'NEUTRAL'
    return {
      id: z.id,
      type,
      side,
      top: z.top,
      bottom: z.bottom,
      startTime: z.startTimeSec as Time,
      endTime: visibleEnd,
      strength: z.strength,
      strengthTier: z.tier,
      label: hintForReaction(r),
      contextHint: hintForReaction(r),
      invalidation: z.role === 'SUPPORT' ? z.bottom : z.top,
      target: r.destination?.price ?? r.targetIfHold?.price ?? (r.nextIfBreak ? bandMid({
        ...z,
        top: r.nextIfBreak.top,
        bottom: r.nextIfBreak.bottom,
      }) : undefined),
    }
  })
}

export function reactionForZone(
  board: ZoneReactionBoard | null | undefined,
  zone: { top: number; bottom: number; id?: string }
): ZoneReaction | null {
  if (!board?.reactions.length) return null
  const byId = zone.id ? board.reactions.find((r) => r.zone.id === zone.id) : null
  if (byId) return byId
  let best: ZoneReaction | null = null
  let bestOv = 0
  for (const r of board.reactions) {
    const ov = Math.min(r.zone.top, zone.top) - Math.max(r.zone.bottom, zone.bottom)
    const minH = Math.min(r.zone.top - r.zone.bottom, zone.top - zone.bottom)
    if (minH > 0 && ov > minH * 0.35 && ov > bestOv) {
      bestOv = ov
      best = r
    }
  }
  return best
}
