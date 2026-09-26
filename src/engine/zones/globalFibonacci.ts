/**
 * Global Fibonacci — зона 141–161 по методу из урока «141».
 *
 * Сетка тянется как в TradingView без «Переворот»:
 *   0%   = последний экстремум (E), по фитилю
 *   100% = важный пивот (P), от которого этот экстремум построился, по телу свечи
 *   141% / 161% = extension ЗА пивотом P → зона реакции (блок заказов)
 *
 * Слом структуры = закрытие за фитилём P. Выбирается последний слом; при
 * одновременном сломе нескольких пивотов — ближайший к E.
 *
 * Лой P → хай E: зона 141–161 НИЖЕ лоя P → реакция вверх (LONG)
 * Хай P → лой E: зона 141–161 ВЫШЕ хая P → реакция вниз (SHORT)
 *
 * mode = 'BREAK'    — P уже пробит закрытием (слом структуры), цена идёт в зону.
 * mode = 'EXPECTED' — слома нет (или зона последнего слома прошита): зона по
 *                     текущей ноге, станет рабочей, если P пробьют.
 * Прошитая закрытием зона игнорируется.
 *
 * Уровни: 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.414, 1.618, 2, 2.414, 2.618, 3
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone, PriceLevel } from '../indicators/types'
import { findFvg, findOrderBlocks, type MarketStructure } from '../smc'

export const GLOBAL_FIB_RATIOS = [
  0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.414, 1.618, 2, 2.414, 2.618, 3,
] as const

export type FibRatio = (typeof GLOBAL_FIB_RATIOS)[number]

export interface GlobalFibLevel {
  ratio: number
  price: number
  kind: 'RETRACE' | 'EXT' | 'ORIGIN' | 'END'
  label: string
}

export interface GlobalFibReactionZone {
  id: string
  /** LONG = bounce up · SHORT = rejection down */
  bias: 'LONG' | 'SHORT'
  top: number
  bottom: number
  label: string
  strength: number
  active: boolean
  ratios: [number, number]
  /** Совпадения с OB / FVG / горизонталями */
  confluence?: string[]
}

export type GlobalFibMode = 'BREAK' | 'EXPECTED'

export interface GlobalFibonacciMap {
  swingHigh: number
  swingLow: number
  highIdx: number
  lowIdx: number
  /** Нога P → E: UP = лой P → хай E · DOWN = хай P → лой E */
  impulse: 'UP' | 'DOWN'
  /** 0% — последний экстремум E */
  fib0: number
  /** 100% — важный пивот P */
  fib100: number
  levels: GlobalFibLevel[]
  reactionZones: GlobalFibReactionZone[]
  /** Always the 141–161 band — главная зона */
  zone141: GlobalFibReactionZone | null
  price141: number | null
  price161: number | null
  in141: boolean
  near141: boolean
  distTo141Pct: number | null
  /** Active zone preferring 141 over secondary retrace */
  activeZone: GlobalFibReactionZone | null
  /** Bias for entry hunt (141 first) */
  entryBias: 'LONG' | 'SHORT' | null
  chartZones: LiquidityZone[]
  priceLevels: PriceLevel[]
  mode?: GlobalFibMode
  /** Цена пивота P (100%) */
  brokenPivot?: number
  /** Индекс свечи слома P (mode BREAK) */
  breakIdx?: number | null
  /** Зона последнего слома была прошита закрытием — её игнорируем */
  lastBreakPierced?: boolean
  confluence?: string[]
  /** Время (ms) свечи экстремума E — касания зоны раньше не считаются */
  legEndTime?: number
}

export interface GlobalFibOptions {
  /** Внешние зоны/уровни для проверки совпадения (OB, S/R …) */
  confluenceZones?: Array<{ top: number; bottom: number; label?: string }>
}

export function fibPercentLabel(ratio: number): string {
  if (ratio === 0) return '0'
  if (ratio === 1) return '100'
  const pct = Math.round(ratio * 1000) / 10
  return String(pct)
}

/**
 * 0% = экстремум E, 100% = пивот P, >100% = за пивотом P.
 * UP (лой P → хай E):   price = high − diff * ratio → 141 ниже лоя
 * DOWN (хай P → лой E): price = low + diff * ratio  → 141 выше хая
 */
export function levelPrice(
  swingHigh: number,
  swingLow: number,
  impulse: 'UP' | 'DOWN',
  ratio: number
): number {
  const diff = swingHigh - swingLow
  if (impulse === 'UP') {
    return swingHigh - diff * ratio
  }
  return swingLow + diff * ratio
}

interface Pivot {
  i: number
  /** Фитиль — по нему считается слом */
  price: number
  /** Тело свечи пивота — якорь 100% («не от фитиля») */
  anchor: number
  kind: 'HIGH' | 'LOW'
}

const PIVOT_R = 2

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

/** Экстремум E после пивота P до индекса end (не включая). */
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

interface FibLeg {
  pivot: Pivot
  extreme: { i: number; price: number }
  breakIdx: number | null
}

function legOk(leg: FibLeg, minLeg: number): boolean {
  return Math.abs(leg.extreme.price - leg.pivot.anchor) >= minLeg
}

/** Последний слом структуры: закрытие за пивотом P, от которого построился экстремум E. */
function findLastBreak(window: OhlcvCandle[], pivots: Pivot[], minLeg: number): FibLeg | null {
  let best: FibLeg | null = null
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
    const leg: FibLeg = { pivot: p, extreme, breakIdx: j }
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

/** Текущая нога без слома: последний экстремум E и важный пивот P перед ним. */
function findCurrentLeg(window: OhlcvCandle[], pivots: Pivot[], minLeg: number): FibLeg | null {
  if (!pivots.length) return null
  const last = pivots[pivots.length - 1]
  const eKind = last.kind
  for (let idx = pivots.length - 1; idx >= 0; idx--) {
    const p = pivots[idx]
    if (p.kind === eKind) continue
    const extreme = extremeAfter(window, p, window.length)
    if (!extreme) continue
    const leg: FibLeg = { pivot: p, extreme, breakIdx: null }
    if (legOk(leg, minLeg)) return leg
  }
  return null
}

function buildLevels(fib0: number, fib100: number): GlobalFibLevel[] {
  return GLOBAL_FIB_RATIOS.map((ratio) => {
    const price = fib0 + (fib100 - fib0) * ratio
    let kind: GlobalFibLevel['kind'] = 'RETRACE'
    if (ratio === 0) kind = 'END'
    else if (ratio === 1) kind = 'ORIGIN'
    else if (ratio > 1) kind = 'EXT'
    return { ratio, price, kind, label: fibPercentLabel(ratio) }
  })
}

function is141Zone(z: GlobalFibReactionZone): boolean {
  return z.id.includes('141') || z.ratios[0] === 1.414
}

function buildReactionZones(
  levels: GlobalFibLevel[],
  bias: 'LONG' | 'SHORT',
  currentPrice: number
): GlobalFibReactionZone[] {
  const byRatio = (r: number) => levels.find((l) => l.ratio === r)?.price
  const zones: GlobalFibReactionZone[] = []

  const mk = (
    id: string,
    a: number,
    b: number,
    label: string,
    strength: number,
    ratios: [number, number]
  ): GlobalFibReactionZone => {
    const top = Math.max(a, b)
    const bottom = Math.min(a, b)
    const span = top - bottom
    const pad = Math.max(span * 0.02, ((top + bottom) / 2) * 0.0015)
    return {
      id,
      bias,
      top: top + pad,
      bottom: bottom - pad,
      label,
      strength,
      active: currentPrice <= top + pad && currentPrice >= bottom - pad,
      ratios,
    }
  }

  const r1414 = byRatio(1.414)
  const r1618 = byRatio(1.618)
  const r2 = byRatio(2)
  const r2414 = byRatio(2.414)
  const r2618 = byRatio(2.618)
  const r3 = byRatio(3)

  if (r1414 != null && r1618 != null) {
    zones.push(mk('fib_ext_141', r1414, r1618, 'Зона 141%–161% (реакция)', 16, [1.414, 1.618]))
  }
  if (r1414 != null) {
    const half = Math.max(Math.abs((r1618 ?? r1414) - r1414) * 0.2, Math.abs(r1414) * 0.0025)
    zones.push(mk('fib_magnet_141', r1414 + half, r1414 - half, '141% магнит', 18, [1.414, 1.414]))
  }
  if (r2 != null && r2414 != null) {
    zones.push(mk('fib_ext_241', r2, r2414, 'Зона 200%–241%', 8, [2, 2.414]))
  }
  if (r2414 != null && r2618 != null) {
    zones.push(mk('fib_ext_261', r2414, r2618, 'Зона 241%–261%', 7, [2.414, 2.618]))
  }
  if (r2618 != null && r3 != null) {
    zones.push(mk('fib_ext_300', r2618, r3, 'Зона 261%–300%', 6, [2.618, 3]))
  }
  return zones
}

const NO_STRUCTURE: MarketStructure = {
  trend: 'RANGING',
  lastBos: null,
  swingHighs: [],
  swingLows: [],
  lastSwingHigh: null,
  lastSwingLow: null,
}

/** OB / FVG той же стороны, горизонтали прошлых пивотов и внешние зоны внутри полосы. */
function findConfluence(
  window: OhlcvCandle[],
  pivots: Pivot[],
  zone: GlobalFibReactionZone,
  extra: GlobalFibOptions['confluenceZones']
): string[] {
  const tol = (zone.top - zone.bottom) * 0.25
  const lo = zone.bottom - tol
  const hi = zone.top + tol
  const overlaps = (t: number, b: number) => Math.min(hi, t) >= Math.max(lo, b)
  const side = zone.bias === 'LONG' ? 'BULLISH' : 'BEARISH'
  const out: string[] = []

  if (findOrderBlocks(window, NO_STRUCTURE, 20).some((ob) => ob.type === side && overlaps(ob.top, ob.bottom))) {
    out.push('OB')
  }
  if (findFvg(window, 10).some((g) => g.type === side && overlaps(g.top, g.bottom))) {
    out.push('FVG')
  }
  if (pivots.some((p) => p.price >= lo && p.price <= hi)) {
    out.push('уровень')
  }
  for (const z of extra ?? []) {
    if (overlaps(Math.max(z.top, z.bottom), Math.min(z.top, z.bottom))) {
      out.push(z.label ?? 'зона')
      break
    }
  }
  return out
}

function isPierced(window: OhlcvCandle[], zone: GlobalFibReactionZone, fromIdx: number): boolean {
  for (let k = fromIdx; k < window.length; k++) {
    const close = window[k][4]
    if (zone.bias === 'LONG' ? close < zone.bottom : close > zone.top) return true
  }
  return false
}

function toChartZones(
  zones: GlobalFibReactionZone[],
  startTime: number,
  endTime: number,
  in141: boolean,
  near141: boolean,
  mode: GlobalFibMode,
  pivotPrice: number
): LiquidityZone[] {
  const px = pivotPrice.toPrecision(6)
  return zones.map((z) => {
    const primary = is141Zone(z)
    const conf = z.confluence?.length ? ` · ${z.confluence.join('+')}` : ''
    let label = z.label
    if (primary) {
      if (mode === 'EXPECTED') {
        label = `☆ ${z.label} · ожидаемая (слом ${px}) · ${z.bias}${conf}`
      } else if (z.active || in141) {
        label = `◎ ${z.label} · ищем ${z.bias}${conf}`
      } else if (near141) {
        label = `◎ ${z.label} · рядом · ${z.bias}${conf}`
      } else {
        label = `★ ${z.label} · после слома ${px} · ${z.bias}${conf}`
      }
    } else if (z.active) {
      label = `◎ ${z.label}`
    }

    return {
      id: z.id,
      type: 'FIBONACCI' as const,
      side: z.bias === 'LONG' ? ('BULLISH' as const) : ('BEARISH' as const),
      top: z.top,
      bottom: z.bottom,
      startTime: startTime as LiquidityZone['startTime'],
      endTime: endTime as LiquidityZone['endTime'],
      strength:
        z.strength + (z.active ? 4 : 0) + (primary ? (mode === 'BREAK' ? 20 : 8) : 0),
      label,
    }
  })
}

function toPriceLevels(levels: GlobalFibLevel[]): PriceLevel[] {
  // Fewer lines on chart — only key magnets (avoids crowding SL/TP axis labels)
  const highlight = new Set([0, 0.618, 1, 1.414, 1.618, 2])
  return levels
    .filter((l) => highlight.has(l.ratio))
    .map((l) => {
      const is141 = l.ratio === 1.414
      const is161 = l.ratio === 1.618
      const isExt = l.ratio > 1
      return {
        id: `gfib_${l.ratio}`,
        type: is141 || is161 ? ('FIB_OTE' as const) : ('FIB_618' as const),
        price: l.price,
        label: is141 ? '141' : is161 ? '161' : `${fibPercentLabel(l.ratio)}%`,
        color: is141
          ? 'rgba(251, 191, 36, 0.45)'
          : is161
            ? 'rgba(251, 191, 36, 0.32)'
            : isExt
              ? 'rgba(168, 85, 247, 0.4)'
              : 'rgba(148, 163, 184, 0.35)',
        lineStyle: (is141 || is161 ? 0 : 2) as 0 | 1 | 2,
      }
    })
}

export function buildGlobalFibonacci(
  candles: OhlcvCandle[],
  currentPrice: number,
  opts?: GlobalFibOptions
): GlobalFibonacciMap | null {
  if (candles.length < 25 || !(currentPrice > 0)) return null

  const window = candles.slice(-160)
  const base = candles.length - window.length
  const pivots = findPivots(window)
  if (pivots.length < 2) return null
  const minLeg = Math.max(currentPrice * 0.008, atrOf(window) * 1.5)

  let mode: GlobalFibMode = 'BREAK'
  let lastBreakPierced = false
  let leg = findLastBreak(window, pivots, minLeg)
  let levels: GlobalFibLevel[] = []
  let reactionZones: GlobalFibReactionZone[] = []

  const assemble = (l: FibLeg) => {
    levels = buildLevels(l.extreme.price, l.pivot.anchor)
    reactionZones = buildReactionZones(
      levels,
      l.pivot.kind === 'LOW' ? 'LONG' : 'SHORT',
      currentPrice
    )
  }

  if (leg) {
    assemble(leg)
    const primary = reactionZones.find((z) => z.id === 'fib_ext_141')
    if (primary && leg.breakIdx != null && isPierced(window, primary, leg.breakIdx)) {
      lastBreakPierced = true
      leg = null
    }
  }
  if (!leg) {
    mode = 'EXPECTED'
    leg = findCurrentLeg(window, pivots, minLeg)
    if (!leg) return null
    assemble(leg)
  }

  const conf141 = (() => {
    const z = reactionZones.find((r) => r.id === 'fib_ext_141')
    return z ? findConfluence(window, pivots, z, opts?.confluenceZones) : []
  })()
  for (const z of reactionZones) {
    if (!is141Zone(z)) continue
    z.confluence = conf141
    z.strength += Math.min(10, conf141.length * 4)
    if (mode === 'EXPECTED') z.strength -= 6
  }

  const pivot = leg.pivot
  const extreme = leg.extreme
  const impulse: 'UP' | 'DOWN' = pivot.kind === 'LOW' ? 'UP' : 'DOWN'
  const swingHigh = impulse === 'UP' ? extreme.price : pivot.anchor
  const swingLow = impulse === 'UP' ? pivot.anchor : extreme.price
  const highIdx = base + (impulse === 'UP' ? extreme.i : pivot.i)
  const lowIdx = base + (impulse === 'UP' ? pivot.i : extreme.i)

  const startCandle = candles[Math.max(0, candles.length - 90)]
  const endCandle = candles[candles.length - 1]
  const startTime = Math.floor(startCandle[0] / 1000)
  const endTime = Math.floor(endCandle[0] / 1000) + 86400 * 5

  const zone141 =
    reactionZones.find((z) => z.id === 'fib_ext_141') ??
    reactionZones.find((z) => z.id === 'fib_magnet_141') ??
    null

  const price141 = levels.find((l) => l.ratio === 1.414)?.price ?? null
  const price161 = levels.find((l) => l.ratio === 1.618)?.price ?? null
  const in141 = reactionZones.some((z) => z.active && is141Zone(z))
  const distTo141Pct =
    price141 != null && price141 > 0
      ? ((currentPrice - price141) / price141) * 100
      : null
  const near141 =
    distTo141Pct != null && Math.abs(distTo141Pct) <= 3 && zone141 != null

  const active141 =
    reactionZones
      .filter((z) => z.active && is141Zone(z))
      .sort((a, b) => b.strength - a.strength)[0] ?? null
  const activeOther =
    reactionZones
      .filter((z) => z.active && !is141Zone(z))
      .sort((a, b) => b.strength - a.strength)[0] ?? null

  const activeZone = active141 ?? (near141 ? zone141 : null)

  let entryBias: 'LONG' | 'SHORT' | null = null
  if (active141) entryBias = active141.bias
  else if (zone141) entryBias = zone141.bias
  else if (activeOther) entryBias = activeOther.bias

  return {
    swingHigh,
    swingLow,
    highIdx,
    lowIdx,
    impulse,
    fib0: extreme.price,
    fib100: pivot.anchor,
    levels,
    reactionZones,
    zone141,
    price141,
    price161,
    in141,
    near141,
    distTo141Pct,
    activeZone,
    entryBias,
    chartZones: toChartZones(
      reactionZones,
      startTime,
      endTime,
      in141,
      near141,
      mode,
      pivot.anchor
    ),
    priceLevels: toPriceLevels(levels),
    mode,
    brokenPivot: pivot.anchor,
    breakIdx: leg.breakIdx != null ? base + leg.breakIdx : null,
    lastBreakPierced,
    confluence: conf141,
    legEndTime: window[extreme.i][0],
  }
}
