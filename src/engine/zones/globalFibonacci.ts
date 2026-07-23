/**
 * Global Fibonacci — как в TradingView на скринах трейдера.
 *
 * Растяжка по импульсу (не «откат с хая»):
 *   0%   = начало импульса
 *   100% = конец импульса
 *   141% / 161% = extension ЗА концом → зона разворота
 *
 * SHORT: импульс ↑ (low→high) → зона 141–161 ВЫШЕ хая → отскок вниз
 * LONG:  импульс ↓ (high→low) → зона 141–161 НИЖЕ лоу → отскок вверх
 *
 * Уровни: 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.414, 1.618, 2, 2.414, 2.618, 3
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone, PriceLevel } from '../indicators/types'

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
}

export interface GlobalFibonacciMap {
  swingHigh: number
  swingLow: number
  highIdx: number
  lowIdx: number
  /** UP = low then high · DOWN = high then low */
  impulse: 'UP' | 'DOWN'
  /** 0% anchor (start of impulse) */
  fib0: number
  /** 100% anchor (end of impulse) */
  fib100: number
  levels: GlobalFibLevel[]
  reactionZones: GlobalFibReactionZone[]
  /** Always the 141–161 band — главный магнит */
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
}

export function fibPercentLabel(ratio: number): string {
  if (ratio === 0) return '0'
  if (ratio === 1) return '100'
  const pct = Math.round(ratio * 1000) / 10
  return Number.isInteger(pct) ? String(pct) : String(pct)
}

/**
 * Как на скрине: 0% = старт импульса, 100% = финиш, >100% = extension дальше.
 * UP:  price = low + diff * ratio   → 141 выше хая
 * DOWN: price = high − diff * ratio → 141 ниже лоу
 */
export function levelPrice(
  swingHigh: number,
  swingLow: number,
  impulse: 'UP' | 'DOWN',
  ratio: number
): number {
  const diff = swingHigh - swingLow
  if (impulse === 'UP') {
    return swingLow + diff * ratio
  }
  return swingHigh - diff * ratio
}

/**
 * Последний подтверждённый swing high + swing low (пивоты), не сырой max/min окна.
 * Импульс = от более раннего пивота к более позднему → extension «куда пойдёт» дальше.
 */
export function findMajorSwing(candles: OhlcvCandle[]): {
  swingHigh: number
  swingLow: number
  highIdx: number
  lowIdx: number
  impulse: 'UP' | 'DOWN'
} | null {
  if (candles.length < 25) return null

  const window = candles.slice(-120)
  const pivotR = 2
  const highs: Array<{ i: number; price: number }> = []
  const lows: Array<{ i: number; price: number }> = []

  for (let i = pivotR; i < window.length - pivotR; i++) {
    const h = window[i][2]
    const l = window[i][3]
    let isHigh = true
    let isLow = true
    for (let k = 1; k <= pivotR; k++) {
      if (h < window[i - k][2] || h < window[i + k][2]) isHigh = false
      if (l > window[i - k][3] || l > window[i + k][3]) isLow = false
    }
    if (isHigh) highs.push({ i, price: h })
    if (isLow) lows.push({ i, price: l })
  }

  if (highs.length < 1 || lows.length < 1) {
    // Fallback: raw extrema in last 40 bars (still «recent»)
    const recent = window.slice(-40)
    let highIdx = 0
    let lowIdx = 0
    let swingHigh = -Infinity
    let swingLow = Infinity
    for (let i = 0; i < recent.length; i++) {
      if (recent[i][2] >= swingHigh) {
        swingHigh = recent[i][2]
        highIdx = i
      }
      if (recent[i][3] <= swingLow) {
        swingLow = recent[i][3]
        lowIdx = i
      }
    }
    if (!(swingHigh > swingLow) || swingLow <= 0) return null
    if ((swingHigh - swingLow) / swingLow < 0.008) return null
    const base = window.length - recent.length
    return {
      swingHigh,
      swingLow,
      highIdx: base + highIdx,
      lowIdx: base + lowIdx,
      impulse: highIdx > lowIdx ? 'UP' : 'DOWN',
    }
  }

  // Prefer the most recent high and most recent low that form a meaningful range
  const lastHigh = highs[highs.length - 1]
  const lastLow = lows[lows.length - 1]

  // If they are too close in time, walk back to get a cleaner impulse leg
  let hi = lastHigh
  let lo = lastLow
  const minSep = 3
  if (Math.abs(hi.i - lo.i) < minSep) {
    if (hi.i >= lo.i && lows.length >= 2) lo = lows[lows.length - 2]
    else if (lo.i > hi.i && highs.length >= 2) hi = highs[highs.length - 2]
  }

  // Also prefer the swing pair spanning the last impulse (later pivot = end)
  let swingHigh = hi.price
  let swingLow = lo.price
  let highIdx = hi.i
  let lowIdx = lo.i

  // If last high is after last low but there was a higher high earlier in the leg, keep last pair
  // Ensure high > low
  if (!(swingHigh > swingLow)) {
    // pick max of last 3 highs / min of last 3 lows
    const hs = highs.slice(-3)
    const ls = lows.slice(-3)
    const bestH = hs.reduce((a, b) => (a.price >= b.price ? a : b))
    const bestL = ls.reduce((a, b) => (a.price <= b.price ? a : b))
    swingHigh = bestH.price
    swingLow = bestL.price
    highIdx = bestH.i
    lowIdx = bestL.i
  }

  if (!(swingHigh > swingLow) || swingLow <= 0) return null
  const rangePct = ((swingHigh - swingLow) / swingLow) * 100
  if (rangePct < 0.8) return null

  const impulse: 'UP' | 'DOWN' = highIdx > lowIdx ? 'UP' : 'DOWN'
  return { swingHigh, swingLow, highIdx, lowIdx, impulse }
}

function buildLevels(
  swingHigh: number,
  swingLow: number,
  impulse: 'UP' | 'DOWN'
): GlobalFibLevel[] {
  return GLOBAL_FIB_RATIOS.map((ratio) => {
    const price = levelPrice(swingHigh, swingLow, impulse, ratio)
    let kind: GlobalFibLevel['kind'] = 'RETRACE'
    if (ratio === 0) kind = 'ORIGIN'
    else if (ratio === 1) kind = 'END'
    else if (ratio > 1) kind = 'EXT'

    return {
      ratio,
      price,
      kind,
      label: fibPercentLabel(ratio),
    }
  })
}

function is141Zone(z: GlobalFibReactionZone): boolean {
  return z.id.includes('141') || z.ratios[0] === 1.414
}

/**
 * Главное — зона 141–161 (отскок). Остальное — вторичные уровни сетки.
 */
function buildReactionZones(
  levels: GlobalFibLevel[],
  impulse: 'UP' | 'DOWN',
  currentPrice: number
): GlobalFibReactionZone[] {
  const byRatio = (r: number) => levels.find((l) => l.ratio === r)?.price
  const zones: GlobalFibReactionZone[] = []

  const mk = (
    id: string,
    bias: 'LONG' | 'SHORT',
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

  // Bias at extension: fade the impulse (как «отскок от 141–161»)
  const extBias: 'LONG' | 'SHORT' = impulse === 'UP' ? 'SHORT' : 'LONG'

  // ★ PRIMARY — зона 141–161
  if (r1414 != null && r1618 != null) {
    zones.push(
      mk(
        'fib_ext_141',
        extBias,
        r1414,
        r1618,
        'Зона 141%–161% (разворот)',
        16,
        [1.414, 1.618]
      )
    )
  }

  if (r1414 != null) {
    const half = Math.max(
      Math.abs((r1618 ?? r1414) - r1414) * 0.2,
      Math.abs(r1414) * 0.0025
    )
    zones.push(
      mk(
        'fib_magnet_141',
        extBias,
        r1414 + half,
        r1414 - half,
        '141% магнит',
        18,
        [1.414, 1.414]
      )
    )
  }

  // Deeper extensions — weaker magnets
  if (r2 != null && r2414 != null) {
    zones.push(
      mk('fib_ext_241', extBias, r2, r2414, 'Зона 200%–241%', 8, [2, 2.414])
    )
  }
  if (r2414 != null && r2618 != null) {
    zones.push(
      mk('fib_ext_261', extBias, r2414, r2618, 'Зона 241%–261%', 7, [2.414, 2.618])
    )
  }
  if (r2618 != null && r3 != null) {
    zones.push(
      mk('fib_ext_300', extBias, r2618, r3, 'Зона 261%–300%', 6, [2.618, 3])
    )
  }

  return zones
}

function toChartZones(
  zones: GlobalFibReactionZone[],
  startTime: number,
  endTime: number,
  in141: boolean,
  near141: boolean
): LiquidityZone[] {
  return zones.map((z) => {
    const primary = is141Zone(z)
    let label = z.label
    if (primary) {
      if (z.active || in141) {
        label = `◎ ${z.label} · ищем ${z.bias}`
      } else if (near141) {
        label = `◎ ${z.label} · рядом · ${z.bias}`
      } else {
        label = `★ ${z.label} · главный магнит`
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
      strength: z.strength + (z.active ? 4 : 0) + (primary ? 20 : 0),
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
          ? 'rgba(251, 191, 36, 0.98)'
          : is161
            ? 'rgba(251, 191, 36, 0.8)'
            : isExt
              ? 'rgba(168, 85, 247, 0.55)'
              : 'rgba(148, 163, 184, 0.4)',
        lineStyle: (is141 || is161 ? 0 : 2) as 0 | 1 | 2,
      }
    })
}

export function buildGlobalFibonacci(
  candles: OhlcvCandle[],
  currentPrice: number
): GlobalFibonacciMap | null {
  const swing = findMajorSwing(candles)
  if (!swing || !(currentPrice > 0)) return null

  const { swingHigh, swingLow, highIdx, lowIdx, impulse } = swing
  const levels = buildLevels(swingHigh, swingLow, impulse)
  const fib0 = impulse === 'UP' ? swingLow : swingHigh
  const fib100 = impulse === 'UP' ? swingHigh : swingLow

  const startCandle = candles[Math.max(0, candles.length - 90)]
  const endCandle = candles[candles.length - 1]
  const startTime = Math.floor(startCandle[0] / 1000)
  const endTime = Math.floor(endCandle[0] / 1000) + 86400 * 5

  const reactionZones = buildReactionZones(levels, impulse, currentPrice)

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

  // Primary active = 141 only for "FIB ZONE" semantics; else null (ждём 141)
  const activeZone = active141 ?? (near141 ? zone141 : null)

  let entryBias: 'LONG' | 'SHORT' | null = null
  if (active141) entryBias = active141.bias
  else if (near141 && zone141) entryBias = zone141.bias
  else if (zone141) entryBias = zone141.bias // structural: куда бить при касании 141
  else if (activeOther) entryBias = activeOther.bias

  return {
    swingHigh,
    swingLow,
    highIdx,
    lowIdx,
    impulse,
    fib0,
    fib100,
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
    chartZones: toChartZones(reactionZones, startTime, endTime, in141, near141),
    priceLevels: toPriceLevels(levels),
  }
}
