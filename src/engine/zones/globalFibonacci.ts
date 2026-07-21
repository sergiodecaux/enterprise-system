/**
 * Global Fibonacci — HTF swing grid for long & short reversals.
 * Levels match trader Fib Retracement presets (percent style):
 * 0, 23.6, 38.2, 50, 61.8, 78.6, 100, 141.4, 161.8, 200, 241.4, 261.8, 300
 *
 * Two geometries (same swing):
 * - Retracement (0@impulse end → 1@start): golden pocket pullbacks with trend
 * - Extension beyond impulse end: 141–161 etc. as reversal magnets
 *   (как на скрине — отскок от зоны 141)
 *
 * When price sits in a reaction zone, bias entry search and wait for LTF confirmation.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone, PriceLevel } from '../indicators/types'

/** Active levels from the user's TradingView-style Fib settings */
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
  /** LONG = expect bounce up · SHORT = expect rejection down */
  bias: 'LONG' | 'SHORT'
  top: number
  bottom: number
  label: string
  strength: number
  /** Price currently inside this zone */
  active: boolean
  ratios: [number, number]
}

export interface GlobalFibonacciMap {
  swingHigh: number
  swingLow: number
  highIdx: number
  lowIdx: number
  /** Last major impulse direction */
  impulse: 'UP' | 'DOWN'
  levels: GlobalFibLevel[]
  reactionZones: GlobalFibReactionZone[]
  /** Strongest zone containing price, if any */
  activeZone: GlobalFibReactionZone | null
  entryBias: 'LONG' | 'SHORT' | null
  chartZones: LiquidityZone[]
  priceLevels: PriceLevel[]
}

/** Percent label like on trader charts: 141.4 → "141" */
export function fibPercentLabel(ratio: number): string {
  if (ratio === 0) return '0'
  if (ratio === 1) return '100'
  const pct = Math.round(ratio * 1000) / 10
  return Number.isInteger(pct) ? String(pct) : String(pct)
}

/**
 * Retracement: 0 at impulse end, 1 at impulse start (classic pullback grid).
 * Extension (>1): continues past the impulse end in the impulse direction
 * — e.g. UP impulse → 141 sits ABOVE swing high (зона отскока в шорт).
 */
function levelPrice(
  swingHigh: number,
  swingLow: number,
  impulse: 'UP' | 'DOWN',
  ratio: number
): number {
  const diff = swingHigh - swingLow
  if (impulse === 'UP') {
    // 0 = high, 1 = low for retrace; >1 extends ABOVE high
    if (ratio <= 1) return swingHigh - diff * ratio
    return swingHigh + diff * (ratio - 1)
  }
  // DOWN: 0 = low, 1 = high for retrace; >1 extends BELOW low
  if (ratio <= 1) return swingLow + diff * ratio
  return swingLow - diff * (ratio - 1)
}

/**
 * Major swing on HTF candles (prefer 1d).
 */
export function findMajorSwing(candles: OhlcvCandle[]): {
  swingHigh: number
  swingLow: number
  highIdx: number
  lowIdx: number
  impulse: 'UP' | 'DOWN'
} | null {
  if (candles.length < 20) return null
  const window = candles.slice(-90)
  let highIdx = 0
  let lowIdx = 0
  let swingHigh = -Infinity
  let swingLow = Infinity

  for (let i = 0; i < window.length; i++) {
    if (window[i][2] >= swingHigh) {
      swingHigh = window[i][2]
      highIdx = i
    }
    if (window[i][3] <= swingLow) {
      swingLow = window[i][3]
      lowIdx = i
    }
  }

  if (!(swingHigh > swingLow) || swingHigh <= 0) return null

  // Require meaningful range (≥ 3%)
  if ((swingHigh - swingLow) / swingLow < 0.03) return null

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

/**
 * Reaction bands traders watch for reversals (both ways relative to impulse).
 */
function buildReactionZones(
  levels: GlobalFibLevel[],
  impulse: 'UP' | 'DOWN',
  currentPrice: number,
  startTime: number,
  endTime: number
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
    // Slight pad; for thin 141 magnet use ATR-like min width via 0.15% of mid
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

  const r618 = byRatio(0.618)
  const r786 = byRatio(0.786)
  const r5 = byRatio(0.5)
  const r382 = byRatio(0.382)
  const r1 = byRatio(1)
  const r1414 = byRatio(1.414)
  const r1618 = byRatio(1.618)
  const r2 = byRatio(2)
  const r2414 = byRatio(2.414)
  const r2618 = byRatio(2.618)
  const r3 = byRatio(3)

  // Golden pocket / OTE — pullback with trend (ratios %, not prices)
  if (r618 != null && r786 != null) {
    zones.push(
      mk(
        'fib_golden',
        impulse === 'UP' ? 'LONG' : 'SHORT',
        r618,
        r786,
        'Golden Pocket 61.8%–78.6%',
        11,
        [0.618, 0.786]
      )
    )
  }

  if (r5 != null && r618 != null) {
    zones.push(
      mk(
        'fib_mid',
        impulse === 'UP' ? 'LONG' : 'SHORT',
        r5,
        r618,
        'Fib mid 50%–61.8%',
        8,
        [0.5, 0.618]
      )
    )
  }

  if (r382 != null && r5 != null) {
    zones.push(
      mk(
        'fib_shallow',
        impulse === 'UP' ? 'LONG' : 'SHORT',
        r382,
        r5,
        'Fib 38.2%–50%',
        6,
        [0.382, 0.5]
      )
    )
  }

  // ── Extension magnets beyond impulse end (counter-trend reversal) ────────
  // Primary: зона 141–161 — как на скрине «идеальный отскок от 141»
  // UP impulse → zone above high → SHORT | DOWN impulse → zone below low → LONG
  if (r1414 != null && r1618 != null) {
    zones.push(
      mk(
        'fib_ext_141',
        impulse === 'UP' ? 'SHORT' : 'LONG',
        r1414,
        r1618,
        'Зона 141–161 (разворот)',
        13,
        [1.414, 1.618]
      )
    )
  }

  // Narrow magnet right at 141 — catches wick taps / first touch
  if (r1414 != null && r1 != null) {
    const midGap = Math.abs(r1414 - (byRatio(1.618) ?? r1414)) * 0.25
    const half = Math.max(midGap, Math.abs(r1414) * 0.002)
    zones.push(
      mk(
        'fib_magnet_141',
        impulse === 'UP' ? 'SHORT' : 'LONG',
        r1414 + half,
        r1414 - half,
        '141 магнит (отскок)',
        14,
        [1.414, 1.414]
      )
    )
  }

  if (r2 != null && r2414 != null) {
    zones.push(
      mk(
        'fib_ext_241',
        impulse === 'UP' ? 'SHORT' : 'LONG',
        r2,
        r2414,
        'Зона 200–241 (разворот)',
        9,
        [2, 2.414]
      )
    )
  }

  if (r2414 != null && r2618 != null) {
    zones.push(
      mk(
        'fib_ext_261',
        impulse === 'UP' ? 'SHORT' : 'LONG',
        r2414,
        r2618,
        'Зона 241–261 (глубокий разворот)',
        9,
        [2.414, 2.618]
      )
    )
  }

  if (r2618 != null && r3 != null) {
    zones.push(
      mk(
        'fib_ext_300',
        impulse === 'UP' ? 'SHORT' : 'LONG',
        r2618,
        r3,
        'Зона 261–300 (экстрем)',
        8,
        [2.618, 3]
      )
    )
  }

  void startTime
  void endTime
  return zones
}

function toChartZones(
  zones: GlobalFibReactionZone[],
  startTime: number,
  endTime: number
): LiquidityZone[] {
  return zones.map((z) => ({
    id: z.id,
    type: 'FIBONACCI' as const,
    side: z.bias === 'LONG' ? ('BULLISH' as const) : ('BEARISH' as const),
    top: z.top,
    bottom: z.bottom,
    startTime: startTime as LiquidityZone['startTime'],
    endTime: endTime as LiquidityZone['endTime'],
    strength: z.strength + (z.active ? 4 : 0),
    label: z.active ? `◎ ${z.label} · ищем вход ${z.bias}` : z.label,
  }))
}

function toPriceLevels(levels: GlobalFibLevel[]): PriceLevel[] {
  // Always show 141 — primary bounce magnet from trader setups
  const highlight = new Set([0, 0.5, 0.618, 0.786, 1, 1.414, 1.618, 2, 2.414, 2.618, 3])
  return levels
    .filter((l) => highlight.has(l.ratio))
    .map((l) => {
      const is141 = l.ratio === 1.414
      const is161 = l.ratio === 1.618
      const isGolden = l.ratio === 0.618 || l.ratio === 0.786
      const isExt = l.ratio > 1
      return {
        id: `gfib_${l.ratio}`,
        type: is141 || is161 || isGolden ? ('FIB_OTE' as const) : ('FIB_618' as const),
        price: l.price,
        label: is141 ? '141' : is161 ? '161' : `F${fibPercentLabel(l.ratio)}`,
        color: is141
          ? 'rgba(251, 191, 36, 0.95)'
          : is161
            ? 'rgba(251, 191, 36, 0.75)'
            : isGolden
              ? 'rgba(34, 197, 94, 0.7)'
              : isExt
                ? 'rgba(168, 85, 247, 0.65)'
                : 'rgba(148, 163, 184, 0.55)',
        lineStyle: (is141 ? 0 : is161 || isGolden ? 0 : 2) as 0 | 1 | 2,
      }
    })
}

/**
 * Full global fib map from HTF candles.
 */
export function buildGlobalFibonacci(
  candles: OhlcvCandle[],
  currentPrice: number
): GlobalFibonacciMap | null {
  const swing = findMajorSwing(candles)
  if (!swing || !(currentPrice > 0)) return null

  const { swingHigh, swingLow, highIdx, lowIdx, impulse } = swing
  const levels = buildLevels(swingHigh, swingLow, impulse)

  const startCandle = candles[Math.max(0, candles.length - 90)]
  const endCandle = candles[candles.length - 1]
  const startTime = Math.floor(startCandle[0] / 1000)
  const endTime = Math.floor(endCandle[0] / 1000) + 86400 * 5

  const reactionZones = buildReactionZones(
    levels,
    impulse,
    currentPrice,
    startTime,
    endTime
  )

  const activeZone =
    reactionZones
      .filter((z) => z.active)
      .sort((a, b) => b.strength - a.strength)[0] ?? null

  return {
    swingHigh,
    swingLow,
    highIdx,
    lowIdx,
    impulse,
    levels,
    reactionZones,
    activeZone,
    entryBias: activeZone?.bias ?? null,
    chartZones: toChartZones(reactionZones, startTime, endTime),
    priceLevels: toPriceLevels(levels),
  }
}
