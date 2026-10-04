/**
 * Standard ICT / SMC geometry for the chart: swing vs internal pivots,
 * BOS vs CHoCH, displacement order blocks, 3-candle FVG, near-equal
 * pivots, premium/discount, and prior session levels.
 * Own definitions — not a port of any third-party Pine script.
 */

import type { OhlcvCandle } from '../../api/mexc'
import { aggregateMonthly } from './closeCascade'
import {
  aggregateWeekly,
  findSwings,
  type StructureSwing,
} from './structureRead'

export type IctTrend = 'BULLISH' | 'BEARISH' | 'RANGING'
export type IctBreakKind = 'BOS' | 'CHOCH'
export type IctScope = 'SWING' | 'INTERNAL'
export type IctPremiumBucket = 'PREMIUM' | 'EQ' | 'DISCOUNT'

export interface IctPivot {
  index: number
  timeSec: number
  price: number
  kind: 'HIGH' | 'LOW'
  scope: IctScope
}

export interface IctBreak {
  kind: IctBreakKind
  scope: IctScope
  side: 'UP' | 'DOWN'
  price: number
  timeSec: number
  index: number
  pivotIndex: number
}

export interface IctOrderBlock {
  side: 'BULLISH' | 'BEARISH'
  scope: IctScope
  top: number
  bottom: number
  timeSec: number
  index: number
  mitigated: boolean
}

export interface IctFvg {
  side: 'BULLISH' | 'BEARISH'
  top: number
  bottom: number
  timeSec: number
  index: number
  filled: boolean
}

export interface IctEqual {
  kind: 'EQH' | 'EQL'
  price: number
}

export interface IctSessionLevels {
  pdh: number | null
  pdl: number | null
  pwh: number | null
  pwl: number | null
  dayOpen: number | null
  weekOpen: number | null
  monthOpen: number | null
  pdhUsed: boolean
  pdlUsed: boolean
  pwhUsed: boolean
  pwlUsed: boolean
}

export interface IctStructure {
  swingTrend: IctTrend
  internalTrend: IctTrend
  lastSwingBreak: IctBreak | null
  lastInternalBreak: IctBreak | null
  strongHigh: IctPivot | null
  strongLow: IctPivot | null
  weakHigh: IctPivot | null
  weakLow: IctPivot | null
  orderBlocks: IctOrderBlock[]
  fvgs: IctFvg[]
  equals: IctEqual[]
  premiumBucket: IctPremiumBucket
  dealingHigh: number | null
  dealingLow: number | null
  equilibrium: number | null
  sessions: IctSessionLevels
}

export type IctOverlayKind =
  | 'BOS'
  | 'CHOCH'
  | 'FVG'
  | 'OB'
  | 'PDH'
  | 'PDL'
  | 'PWH'
  | 'PWL'
  | 'DO'
  | 'WO'
  | 'STRONG_HIGH'
  | 'STRONG_LOW'
  | 'WEAK_HIGH'
  | 'WEAK_LOW'
  | 'EQH'
  | 'EQL'

export interface IctOverlayMark {
  id: string
  kind: IctOverlayKind
  label: string
  price: number
  top?: number
  bottom?: number
  timeSec?: number
  color: string
  style: 'line' | 'box' | 'label'
  priority: number
}

const TEAL = 'rgba(45, 212, 191, 0.88)'
const ROSE = 'rgba(251, 113, 133, 0.88)'
const AMBER = 'rgba(251, 191, 36, 0.9)'
const BLUE = 'rgba(96, 165, 250, 0.72)'
const VIOLET = 'rgba(192, 132, 252, 0.72)'
const MUTED = 'rgba(148, 163, 184, 0.7)'

function emptySessions(): IctSessionLevels {
  return {
    pdh: null,
    pdl: null,
    pwh: null,
    pwl: null,
    dayOpen: null,
    weekOpen: null,
    monthOpen: null,
    pdhUsed: false,
    pdlUsed: false,
    pwhUsed: false,
    pwlUsed: false,
  }
}

export function emptyIctStructure(): IctStructure {
  return {
    swingTrend: 'RANGING',
    internalTrend: 'RANGING',
    lastSwingBreak: null,
    lastInternalBreak: null,
    strongHigh: null,
    strongLow: null,
    weakHigh: null,
    weakLow: null,
    orderBlocks: [],
    fvgs: [],
    equals: [],
    premiumBucket: 'EQ',
    dealingHigh: null,
    dealingLow: null,
    equilibrium: null,
    sessions: emptySessions(),
  }
}

function atrApprox(candles: OhlcvCandle[], period = 14): number {
  if (candles.length < 3) return 0
  const n = Math.min(period, candles.length - 1)
  let sum = 0
  for (let i = candles.length - n; i < candles.length; i++) {
    const prev = candles[i - 1]
    const c = candles[i]
    if (!prev || !c) continue
    sum += Math.max(c[2] - c[3], Math.abs(c[2] - prev[4]), Math.abs(c[3] - prev[4]))
  }
  return n > 0 ? sum / n : 0
}

/** Pivot length follows the chart TF — not a fixed 50-bar TV lookback. */
export function swingPivotRadius(barSeconds: number): number {
  if (barSeconds <= 60) return 8
  if (barSeconds <= 300) return 7
  if (barSeconds <= 900) return 6
  if (barSeconds <= 3600) return 5
  if (barSeconds <= 14_400) return 4
  return 3
}

export function internalPivotRadius(): number {
  return 2
}

function lastOf(swings: StructureSwing[], kind: 'HIGH' | 'LOW'): StructureSwing | null {
  for (let i = swings.length - 1; i >= 0; i--) {
    if (swings[i].kind === kind) return swings[i]
  }
  return null
}

function trendFromSwings(highs: StructureSwing[], lows: StructureSwing[]): IctTrend {
  if (highs.length < 2 || lows.length < 2) return 'RANGING'
  const h = highs.slice(-3)
  const l = lows.slice(-3)
  const hh = h.length >= 2 && h[h.length - 1]!.price > h[h.length - 2]!.price
  const hl = l.length >= 2 && l[l.length - 1]!.price > l[l.length - 2]!.price
  const lh = h.length >= 2 && h[h.length - 1]!.price < h[h.length - 2]!.price
  const ll = l.length >= 2 && l[l.length - 1]!.price < l[l.length - 2]!.price
  if (hh && hl) return 'BULLISH'
  if (lh && ll) return 'BEARISH'
  return 'RANGING'
}

function closeThrough(close: number, level: number, side: 'UP' | 'DOWN', atr: number): boolean {
  const pad = Math.max(level * 0.00035, atr * 0.06)
  return side === 'UP' ? close > level + pad : close < level - pad
}

function toPivot(sw: StructureSwing, scope: IctScope): IctPivot {
  return {
    index: sw.index,
    timeSec: sw.timeSec,
    price: sw.price,
    kind: sw.kind,
    scope,
  }
}

function scanBreaks(
  candles: OhlcvCandle[],
  swings: StructureSwing[],
  atr: number,
  scope: IctScope
): { trend: IctTrend; last: IctBreak | null; events: IctBreak[] } {
  const highs = swings.filter((s) => s.kind === 'HIGH')
  const lows = swings.filter((s) => s.kind === 'LOW')
  let liveTrend = trendFromSwings(highs, lows)
  const events: IctBreak[] = []
  let last: IctBreak | null = null
  const consider = swings.slice(-14)

  for (const sw of consider) {
    const breakSide: 'UP' | 'DOWN' = sw.kind === 'HIGH' ? 'UP' : 'DOWN'
    for (let k = 1; sw.index + k < candles.length; k++) {
      const absIdx = sw.index + k
      const c = candles[absIdx]
      if (!c) continue
      if (!closeThrough(c[4], sw.price, breakSide, atr)) continue
      const against =
        (liveTrend === 'BULLISH' && breakSide === 'DOWN') ||
        (liveTrend === 'BEARISH' && breakSide === 'UP')
      const ev: IctBreak = {
        kind: against ? 'CHOCH' : 'BOS',
        scope,
        side: breakSide,
        price: sw.price,
        timeSec: Math.floor(c[0] / 1000),
        index: absIdx,
        pivotIndex: sw.index,
      }
      events.push(ev)
      last = ev
      liveTrend = breakSide === 'UP' ? 'BULLISH' : 'BEARISH'
      break
    }
  }

  return { trend: liveTrend, last, events }
}

function extremeBlock(
  candles: OhlcvCandle[],
  brk: IctBreak
): IctOrderBlock | null {
  const from = brk.pivotIndex + 1
  const to = brk.index
  if (to <= from) return null
  let best = from
  if (brk.side === 'UP') {
    for (let i = from + 1; i < to; i++) {
      if (candles[i]![3] < candles[best]![3]) best = i
    }
  } else {
    for (let i = from + 1; i < to; i++) {
      if (candles[i]![2] > candles[best]![2]) best = i
    }
  }
  const c = candles[best]
  if (!c) return null
  const bull = brk.side === 'UP'
  return {
    side: bull ? 'BULLISH' : 'BEARISH',
    scope: brk.scope,
    top: c[2],
    bottom: c[3],
    timeSec: Math.floor(c[0] / 1000),
    index: best,
    mitigated: false,
  }
}

function markMitigated(
  candles: OhlcvCandle[],
  block: IctOrderBlock,
  fromIdx: number
): IctOrderBlock {
  for (let i = fromIdx; i < candles.length; i++) {
    const close = candles[i]![4]
    if (block.side === 'BULLISH' && close < block.bottom) {
      return { ...block, mitigated: true }
    }
    if (block.side === 'BEARISH' && close > block.top) {
      return { ...block, mitigated: true }
    }
  }
  return block
}

function findFairValueGaps(candles: OhlcvCandle[], maxKeep = 10): IctFvg[] {
  if (candles.length < 5) return []
  const out: IctFvg[] = []
  const start = Math.max(2, candles.length - 90)
  for (let i = start; i < candles.length; i++) {
    const left = candles[i - 2]
    const mid = candles[i - 1]
    const right = candles[i]
    if (!left || !mid || !right) continue
    if (right[3] > left[2] && mid[4] > left[2]) {
      const gap: IctFvg = {
        side: 'BULLISH',
        top: right[3],
        bottom: left[2],
        timeSec: Math.floor(right[0] / 1000),
        index: i,
        filled: false,
      }
      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k]![3] <= gap.bottom) {
          gap.filled = true
          break
        }
      }
      out.push(gap)
    }
    if (right[2] < left[3] && mid[4] < left[3]) {
      const gap: IctFvg = {
        side: 'BEARISH',
        top: left[3],
        bottom: right[2],
        timeSec: Math.floor(right[0] / 1000),
        index: i,
        filled: false,
      }
      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k]![2] >= gap.top) {
          gap.filled = true
          break
        }
      }
      out.push(gap)
    }
  }
  return out.slice(-maxKeep)
}

function findEquals(
  highs: StructureSwing[],
  lows: StructureSwing[],
  atr: number
): IctEqual[] {
  const tol = Math.max(atr * 0.28, 1e-8)
  const out: IctEqual[] = []
  const recentH = highs.slice(-6)
  const recentL = lows.slice(-6)
  for (let i = 1; i < recentH.length; i++) {
    const a = recentH[i - 1]!
    const b = recentH[i]!
    if (Math.abs(a.price - b.price) <= tol) {
      out.push({ kind: 'EQH', price: (a.price + b.price) / 2 })
    }
  }
  for (let i = 1; i < recentL.length; i++) {
    const a = recentL[i - 1]!
    const b = recentL[i]!
    if (Math.abs(a.price - b.price) <= tol) {
      out.push({ kind: 'EQL', price: (a.price + b.price) / 2 })
    }
  }
  return out.slice(-4)
}

function tradedThrough(
  candles: OhlcvCandle[],
  afterMs: number,
  price: number,
  side: 'HIGH' | 'LOW'
): boolean {
  for (const c of candles) {
    if (c[0] <= afterMs) continue
    if (side === 'HIGH' && c[2] >= price) return true
    if (side === 'LOW' && c[3] <= price) return true
  }
  return false
}

function lastClosed(candles: OhlcvCandle[] | undefined, barMs: number): OhlcvCandle | null {
  if (!candles?.length) return null
  const now = Date.now()
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i]!
    if (now >= c[0] + barMs - 1200) return c
  }
  return candles.length >= 2 ? candles[candles.length - 2] ?? null : null
}

function currentOpen(candles: OhlcvCandle[] | undefined): number | null {
  const last = candles?.[candles.length - 1]
  return last && last[1] > 0 ? last[1] : null
}

export function readSessionLevels(opts: {
  candles: OhlcvCandle[]
  candles1d?: OhlcvCandle[]
  candles1w?: OhlcvCandle[]
  price: number
}): IctSessionLevels {
  const daily = opts.candles1d?.length ? opts.candles1d : []
  const weekly = opts.candles1w?.length ? opts.candles1w : daily.length ? aggregateWeekly(daily) : []
  const monthly = daily.length ? aggregateMonthly(daily) : []
  const prevDay = lastClosed(daily, 86_400_000)
  const prevWeek = lastClosed(weekly, 604_800_000)
  const sessions = emptySessions()
  if (prevDay) {
    sessions.pdh = prevDay[2]
    sessions.pdl = prevDay[3]
    sessions.pdhUsed = tradedThrough(opts.candles, prevDay[0], prevDay[2], 'HIGH')
    sessions.pdlUsed = tradedThrough(opts.candles, prevDay[0], prevDay[3], 'LOW')
  }
  if (prevWeek) {
    sessions.pwh = prevWeek[2]
    sessions.pwl = prevWeek[3]
    sessions.pwhUsed = tradedThrough(opts.candles, prevWeek[0], prevWeek[2], 'HIGH')
    sessions.pwlUsed = tradedThrough(opts.candles, prevWeek[0], prevWeek[3], 'LOW')
  }
  sessions.dayOpen = currentOpen(daily)
  sessions.weekOpen = currentOpen(weekly)
  sessions.monthOpen = currentOpen(monthly)
  if (opts.price > 0) {
    if (sessions.pdh != null && opts.price >= sessions.pdh) sessions.pdhUsed = true
    if (sessions.pdl != null && opts.price <= sessions.pdl) sessions.pdlUsed = true
    if (sessions.pwh != null && opts.price >= sessions.pwh) sessions.pwhUsed = true
    if (sessions.pwl != null && opts.price <= sessions.pwl) sessions.pwlUsed = true
  }
  return sessions
}

function strengthPair(
  trend: IctTrend,
  lastHigh: StructureSwing | null,
  lastLow: StructureSwing | null
): Pick<IctStructure, 'strongHigh' | 'strongLow' | 'weakHigh' | 'weakLow'> {
  if (trend === 'BULLISH') {
    return {
      strongHigh: null,
      strongLow: lastLow ? toPivot(lastLow, 'SWING') : null,
      weakHigh: lastHigh ? toPivot(lastHigh, 'SWING') : null,
      weakLow: null,
    }
  }
  if (trend === 'BEARISH') {
    return {
      strongHigh: lastHigh ? toPivot(lastHigh, 'SWING') : null,
      strongLow: null,
      weakHigh: null,
      weakLow: lastLow ? toPivot(lastLow, 'SWING') : null,
    }
  }
  return {
    strongHigh: lastHigh ? toPivot(lastHigh, 'SWING') : null,
    strongLow: lastLow ? toPivot(lastLow, 'SWING') : null,
    weakHigh: null,
    weakLow: null,
  }
}

export function readIctStructure(opts: {
  candles: OhlcvCandle[]
  candles1d?: OhlcvCandle[]
  candles1w?: OhlcvCandle[]
  barSeconds: number
  price?: number
}): IctStructure {
  const { candles, barSeconds } = opts
  const empty = emptyIctStructure()
  if (candles.length < 16) return empty
  const atr = atrApprox(candles)
  const price = opts.price && opts.price > 0 ? opts.price : candles[candles.length - 1]![4]
  const swingR = swingPivotRadius(barSeconds)
  const swing = findSwings(candles, swingR)
  const internal = findSwings(candles, internalPivotRadius())
  const swingScan = scanBreaks(candles, swing, atr, 'SWING')
  const internalScan = scanBreaks(candles, internal, atr, 'INTERNAL')

  const blocks: IctOrderBlock[] = []
  const seen = new Set<string>()
  for (const ev of [...swingScan.events.slice(-4), ...internalScan.events.slice(-5)]) {
    const raw = extremeBlock(candles, ev)
    if (!raw) continue
    const key = `${raw.scope}:${raw.index}:${raw.side}`
    if (seen.has(key)) continue
    seen.add(key)
    blocks.push(markMitigated(candles, raw, ev.index + 1))
  }

  const swingHighs = swing.filter((s) => s.kind === 'HIGH')
  const swingLows = swing.filter((s) => s.kind === 'LOW')
  const lastHigh = lastOf(swing, 'HIGH')
  const lastLow = lastOf(swing, 'LOW')
  const dealingHigh = lastHigh?.price ?? null
  const dealingLow = lastLow?.price ?? null
  const equilibrium =
    dealingHigh != null && dealingLow != null && dealingHigh > dealingLow
      ? (dealingHigh + dealingLow) / 2
      : null
  let premiumBucket: IctPremiumBucket = 'EQ'
  if (equilibrium != null && dealingHigh != null && dealingLow != null) {
    const span = dealingHigh - dealingLow
    if (span > 0) {
      const pos = (price - dealingLow) / span
      premiumBucket = pos >= 0.55 ? 'PREMIUM' : pos <= 0.45 ? 'DISCOUNT' : 'EQ'
    }
  }

  return {
    swingTrend: swingScan.trend,
    internalTrend: internalScan.trend,
    lastSwingBreak: swingScan.last,
    lastInternalBreak: internalScan.last,
    ...strengthPair(swingScan.trend, lastHigh, lastLow),
    orderBlocks: blocks,
    fvgs: findFairValueGaps(candles),
    equals: findEquals(swingHighs, swingLows, atr),
    premiumBucket,
    dealingHigh,
    dealingLow,
    equilibrium,
    sessions: readSessionLevels({
      candles,
      candles1d: opts.candles1d,
      candles1w: opts.candles1w,
      price,
    }),
  }
}

export function chochFlipOf(
  ict: IctStructure | null,
  side: 'LONG' | 'SHORT' | null,
  lastIndex: number
): { against: boolean; aligned: boolean; recent: boolean } {
  const brk = ict?.lastSwingBreak
  if (!brk || brk.kind !== 'CHOCH' || !side) {
    return { against: false, aligned: false, recent: false }
  }
  const want = side === 'LONG' ? 'UP' : 'DOWN'
  const aligned = brk.side === want
  return {
    against: !aligned,
    aligned,
    recent: lastIndex - brk.index <= 12,
  }
}

function midOf(top: number, bottom: number): number {
  return (top + bottom) / 2
}

function between(a: number, x: number, b: number): boolean {
  return (x - a) * (b - x) > 0
}

function nearPrice(price: number, level: number, atr: number, mult: number): boolean {
  return Math.abs(level - price) <= Math.max(atr * mult, price * 0.002)
}

export function selectIctOverlayMarks(
  ict: IctStructure,
  opts: {
    clean: boolean
    price: number
    atr: number
    fuelPrice?: number | null
    targetPrice?: number | null
    spent?: { ssl?: { price: number } | null; bsl?: { price: number } | null } | null
  }
): IctOverlayMark[] {
  const { clean, price, atr } = opts
  if (!(price > 0)) return []
  const spentSkip = (p: number) => {
    const ssl = opts.spent?.ssl?.price
    const bsl = opts.spent?.bsl?.price
    const tol = Math.max(atr * 0.35, price * 0.0012)
    if (ssl && Math.abs(p - ssl) <= tol) return true
    if (bsl && Math.abs(p - bsl) <= tol) return true
    return false
  }

  const marks: IctOverlayMark[] = []
  const push = (m: IctOverlayMark) => {
    if (!(m.price > 0) || !Number.isFinite(m.price)) return
    if (spentSkip(m.price)) return
    marks.push(m)
  }

  const brk = ict.lastSwingBreak
  if (brk) {
    push({
      id: `brk_${brk.kind}_${brk.index}`,
      kind: brk.kind,
      label: brk.kind === 'CHOCH' ? 'CHoCH' : 'BOS',
      price: brk.price,
      timeSec: brk.timeSec,
      color: brk.kind === 'CHOCH' ? AMBER : brk.side === 'UP' ? TEAL : ROSE,
      style: 'label',
      priority: 100,
    })
  }

  const liveFvg = ict.fvgs.filter((g) => !g.filled)
  const fuelish = liveFvg.filter((g) => {
    const m = midOf(g.top, g.bottom)
    if (opts.fuelPrice && Math.abs(m - opts.fuelPrice) <= Math.max(atr * 0.45, price * 0.0015)) {
      return true
    }
    if (opts.targetPrice && between(price, m, opts.targetPrice)) return true
    return false
  })
  const fvgPick = clean ? fuelish.slice(0, 1) : [...fuelish, ...liveFvg.filter((g) => !fuelish.includes(g))].slice(0, 2)
  for (const g of fvgPick) {
    push({
      id: `fvg_${g.index}`,
      kind: 'FVG',
      label: 'FVG',
      price: midOf(g.top, g.bottom),
      top: g.top,
      bottom: g.bottom,
      timeSec: g.timeSec,
      color: g.side === 'BULLISH' ? BLUE : VIOLET,
      style: 'box',
      priority: 86,
    })
  }

  const sess = ict.sessions
  const dailyNear = clean ? 4.5 : 6
  if (sess.pdh && !sess.pdhUsed && nearPrice(price, sess.pdh, atr, dailyNear)) {
    push({
      id: 'pdh',
      kind: 'PDH',
      label: 'PDH',
      price: sess.pdh,
      color: ROSE,
      style: 'line',
      priority: 92,
    })
  }
  if (sess.pdl && !sess.pdlUsed && nearPrice(price, sess.pdl, atr, dailyNear)) {
    push({
      id: 'pdl',
      kind: 'PDL',
      label: 'PDL',
      price: sess.pdl,
      color: TEAL,
      style: 'line',
      priority: 92,
    })
  }

  const weekNear = clean ? 2.2 : 4
  if (sess.pwh && !sess.pwhUsed && nearPrice(price, sess.pwh, atr, weekNear)) {
    push({
      id: 'pwh',
      kind: 'PWH',
      label: 'PWH',
      price: sess.pwh,
      color: ROSE,
      style: 'line',
      priority: 70,
    })
  }
  if (sess.pwl && !sess.pwlUsed && nearPrice(price, sess.pwl, atr, weekNear)) {
    push({
      id: 'pwl',
      kind: 'PWL',
      label: 'PWL',
      price: sess.pwl,
      color: TEAL,
      style: 'line',
      priority: 70,
    })
  }

  const swingNear = clean ? 5.5 : 8
  if (ict.strongHigh && nearPrice(price, ict.strongHigh.price, atr, swingNear)) {
    push({
      id: 'strong_high',
      kind: 'STRONG_HIGH',
      label: 'сильный хай',
      price: ict.strongHigh.price,
      timeSec: ict.strongHigh.timeSec,
      color: ROSE,
      style: 'line',
      priority: 80,
    })
  }
  if (ict.strongLow && nearPrice(price, ict.strongLow.price, atr, swingNear)) {
    push({
      id: 'strong_low',
      kind: 'STRONG_LOW',
      label: 'сильный лой',
      price: ict.strongLow.price,
      timeSec: ict.strongLow.timeSec,
      color: TEAL,
      style: 'line',
      priority: 80,
    })
  }
  if (ict.weakHigh && nearPrice(price, ict.weakHigh.price, atr, swingNear)) {
    push({
      id: 'weak_high',
      kind: 'WEAK_HIGH',
      label: 'слабый хай',
      price: ict.weakHigh.price,
      timeSec: ict.weakHigh.timeSec,
      color: 'rgba(251, 113, 133, 0.55)',
      style: 'line',
      priority: 74,
    })
  }
  if (ict.weakLow && nearPrice(price, ict.weakLow.price, atr, swingNear)) {
    push({
      id: 'weak_low',
      kind: 'WEAK_LOW',
      label: 'слабый лой',
      price: ict.weakLow.price,
      timeSec: ict.weakLow.timeSec,
      color: 'rgba(45, 212, 191, 0.55)',
      style: 'line',
      priority: 74,
    })
  }

  const obs = ict.orderBlocks
    .filter((o) => !o.mitigated && nearPrice(price, midOf(o.top, o.bottom), atr, 1.8))
    .sort((a, b) => {
      const da = Math.abs(midOf(a.top, a.bottom) - price)
      const db = Math.abs(midOf(b.top, b.bottom) - price)
      if (a.scope !== b.scope) return a.scope === 'INTERNAL' ? -1 : 1
      return da - db
    })
    .slice(0, 2)
  for (const o of obs) {
    push({
      id: `ob_${o.scope}_${o.index}`,
      kind: 'OB',
      label: 'OB',
      price: midOf(o.top, o.bottom),
      top: o.top,
      bottom: o.bottom,
      timeSec: o.timeSec,
      color: o.side === 'BULLISH' ? TEAL : ROSE,
      style: 'box',
      priority: 68,
    })
  }

  if (!clean) {
    for (const eq of ict.equals.slice(0, 2)) {
      push({
        id: `eq_${eq.kind}_${eq.price}`,
        kind: eq.kind,
        label: eq.kind,
        price: eq.price,
        color: eq.kind === 'EQH' ? ROSE : TEAL,
        style: 'line',
        priority: 58,
      })
    }
    if (sess.dayOpen && nearPrice(price, sess.dayOpen, atr, 2.4)) {
      push({
        id: 'day_open',
        kind: 'DO',
        label: 'открытие дня',
        price: sess.dayOpen,
        color: MUTED,
        style: 'line',
        priority: 48,
      })
    }
    if (sess.weekOpen && nearPrice(price, sess.weekOpen, atr, 3.2)) {
      push({
        id: 'week_open',
        kind: 'WO',
        label: 'открытие недели',
        price: sess.weekOpen,
        color: MUTED,
        style: 'line',
        priority: 44,
      })
    }
  }

  marks.sort((a, b) => b.priority - a.priority)
  const cap = clean ? 8 : 12
  const seenPx: number[] = []
  const out: IctOverlayMark[] = []
  for (const m of marks) {
    if (seenPx.some((p) => Math.abs(p - m.price) <= Math.max(atr * 0.18, price * 0.0006))) {
      continue
    }
    seenPx.push(m.price)
    out.push(m)
    if (out.length >= cap) break
  }
  return out
}

/** Urgent PNG: PDH/PDL + last BOS only. */
export function snapshotIctMarks(
  ict: IctStructure,
  opts: { price: number; atr: number }
): IctOverlayMark[] {
  return selectIctOverlayMarks(ict, {
    clean: true,
    price: opts.price,
    atr: opts.atr,
    fuelPrice: null,
    targetPrice: null,
    spent: null,
  }).filter((m) => m.kind === 'PDH' || m.kind === 'PDL' || m.kind === 'BOS' || m.kind === 'CHOCH')
}
