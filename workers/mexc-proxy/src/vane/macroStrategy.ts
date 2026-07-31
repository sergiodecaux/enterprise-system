/**
 * VANE MACRO v6.1 — catch real directional moves everywhere they start:
 *   ZONE (HTF), RANGE_BREAK (боковик → выход), MOMENTUM (impulse without strong zone).
 *
 * Accuracy > coverage spam:
 *   impulse band + 1m with us + book confirm + memory gate.
 *   Mid-range chop rejected. History cooldown after repeat losses.
 */

import type { MarketRegime } from '../regime'
import type { Candle, Side, ZoneGrade, VaneZoneGeom } from './types'
import type { MacroContext, MacroSymbolMemory } from './macroMemory'
import { memoryAllowsTrade } from './macroMemory'

export const MACRO_MIN_SCORE = 58
export const MACRO_MIN_RR = 1.5
export const MACRO_RISK_PCT = 0.85
export const MACRO_TP_MIN_PCT = 1.5
export const MACRO_TP_MAX_PCT = 3.8
export const MACRO_SL_MIN_PCT = 0.65
export const MACRO_SL_MAX_PCT = 1.2
export const MACRO_TP1_PCT = 0.9
export const MACRO_IMPULSE_MIN = 0.5
export const MACRO_IMPULSE_MAX = 2.4
export const MACRO_DIR_CONF_MIN = 48
export const MACRO_ZONE_STRENGTH = 4
export const MACRO_BE_MFE_PCT = 0.55
export const MACRO_BE_R = 0.45
export const MACRO_TRAIL_PCT = 0.008
export const MACRO_TRAIL_AFTER_TP1 = 0.0055

export interface LocalRange {
  low: number
  high: number
  mid: number
  widthPct: number
  /** Tight range → breakout setup */
  compressed: boolean
  touchesLow: number
  touchesHigh: number
}

export type RangePos =
  | 'INSIDE'
  | 'NEAR_LOW'
  | 'NEAR_HIGH'
  | 'BROKE_UP'
  | 'BROKE_DOWN'

export interface MacroQualifyInput {
  phase: 'FAR' | 'APPROACH' | 'TOUCH'
  earlyFavorPct: number
  bookGrade: ZoneGrade
  absorption: boolean
  cvdConfirm: boolean
  greenDeltaWeak: boolean
  aligns: boolean
  conflicts: boolean
  zoneStrength: number
  zoneTouches: number
  candle1mWithUs: boolean
  directionConfidence: number
  isInternal: boolean
  chg24Abs: number
  /** Signed 24h % in trade direction (positive = favors side) */
  chg24Favor: number
  regime: MarketRegime
  range: LocalRange | null
  rangePos: RangePos | null
  memory: MacroSymbolMemory
  side: Side
  /** 5m continuation in trade direction % */
  move5mFavor: number
}

export interface MacroQualifyResult {
  ok: boolean
  reason: string
  tags: string[]
  context: MacroContext | null
}

/** Detect 15m/1h local range (боковик) from recent highs/lows */
export function detectLocalRange(
  candles: Candle[],
  lookback = 24
): LocalRange | null {
  if (candles.length < lookback) return null
  const slice = candles.slice(-lookback)
  let low = Infinity
  let high = -Infinity
  for (const c of slice) {
    if (c[3] < low) low = c[3]
    if (c[2] > high) high = c[2]
  }
  if (!(low > 0) || !(high > low)) return null
  const mid = (low + high) / 2
  const widthPct = ((high - low) / mid) * 100
  if (widthPct < 0.6 || widthPct > 8) return null

  const band = (high - low) * 0.12
  let touchesLow = 0
  let touchesHigh = 0
  for (const c of slice) {
    if (c[3] <= low + band) touchesLow++
    if (c[2] >= high - band) touchesHigh++
  }
  const compressed = widthPct <= 2.8 && touchesLow >= 2 && touchesHigh >= 2
  return { low, high, mid, widthPct, compressed, touchesLow, touchesHigh }
}

export function rangePosition(price: number, range: LocalRange): RangePos {
  const pad = (range.high - range.low) * 0.08
  if (price > range.high + pad * 0.5) return 'BROKE_UP'
  if (price < range.low - pad * 0.5) return 'BROKE_DOWN'
  if (price <= range.low + pad * 2) return 'NEAR_LOW'
  if (price >= range.high - pad * 2) return 'NEAR_HIGH'
  return 'INSIDE'
}

/** Synthetic zone from local range edge / break for entries without HTF SSL */
export function syntheticRangeZone(
  side: Side,
  range: LocalRange,
  price: number
): VaneZoneGeom {
  if (side === 'LONG') {
    const low = range.low
    const high = Math.min(range.mid, price * 1.004)
    return {
      zoneLow: low,
      zoneHigh: Math.max(high, low * 1.002),
      mid: (low + high) / 2,
      limitEntry: Math.min(price, range.low * 1.002),
      source: 'FVG15',
      tf: '15m',
      strength: range.compressed ? 6 : 5,
      touches: range.touchesLow,
    }
  }
  const high = range.high
  const low = Math.max(range.mid, price * 0.996)
  return {
    zoneLow: Math.min(low, high * 0.998),
    zoneHigh: high,
    mid: (low + high) / 2,
    limitEntry: Math.max(price, range.high * 0.998),
    source: 'OB15',
    tf: '15m',
    strength: range.compressed ? 6 : 5,
    touches: range.touchesHigh,
  }
}

/** Momentum swing zone from recent 5m extreme (no HTF zone required) */
export function syntheticMomentumZone(
  side: Side,
  candles5m: Candle[],
  price: number
): VaneZoneGeom | null {
  if (candles5m.length < 8) return null
  const slice = candles5m.slice(-12)
  let extreme = side === 'LONG' ? Infinity : -Infinity
  for (const c of slice) {
    if (side === 'LONG' && c[3] < extreme) extreme = c[3]
    if (side === 'SHORT' && c[2] > extreme) extreme = c[2]
  }
  if (!(extreme > 0)) return null
  const pad = price * 0.004
  if (side === 'LONG') {
    const low = extreme
    const high = Math.min(price, extreme + pad * 2)
    if (price < low * 0.995) return null
    return {
      zoneLow: low,
      zoneHigh: high,
      mid: (low + high) / 2,
      limitEntry: Math.min(price, low * 1.003),
      source: 'FVG15',
      tf: '15m',
      strength: 5,
      touches: 1,
    }
  }
  const high = extreme
  const low = Math.max(price, extreme - pad * 2)
  if (price > high * 1.005) return null
  return {
    zoneLow: low,
    zoneHigh: high,
    mid: (low + high) / 2,
    limitEntry: Math.max(price, high * 0.997),
    source: 'OB15',
    tf: '15m',
    strength: 5,
    touches: 1,
  }
}

function bookConfirm(input: MacroQualifyInput, strict: boolean): boolean {
  if (input.bookGrade === 'WEAK') return false
  if (input.greenDeltaWeak) return false
  if (input.bookGrade === 'STRONG') return true
  if (input.absorption && input.cvdConfirm) return true
  if (!strict && input.absorption) return true
  if (!strict && input.cvdConfirm && input.candle1mWithUs) return true
  return false
}

function impulseOk(input: MacroQualifyInput): boolean {
  return (
    input.earlyFavorPct >= MACRO_IMPULSE_MIN &&
    input.earlyFavorPct <= MACRO_IMPULSE_MAX
  )
}

/**
 * Multi-context MACRO gate. Fail closed — accuracy over spam.
 */
export function qualifyMacro(input: MacroQualifyInput): MacroQualifyResult {
  const tags: string[] = []
  const mem = memoryAllowsTrade(input.memory, input.side)
  if (!mem.ok) {
    return { ok: false, reason: mem.reason, tags: mem.tags, context: null }
  }
  tags.push(...mem.tags)

  if (!input.candle1mWithUs) {
    return { ok: false, reason: '1m_against', tags, context: null }
  }
  if (!impulseOk(input)) {
    return {
      ok: false,
      reason:
        input.earlyFavorPct < MACRO_IMPULSE_MIN
          ? 'impulse_too_early'
          : 'impulse_extended',
      tags,
      context: null,
    }
  }
  tags.push(`IMP+${input.earlyFavorPct.toFixed(2)}`)

  // --- RANGE_BREAK (боковик → выход) — HTF WITH optional ---
  const ranging =
    input.regime === 'RANGING' ||
    input.regime === 'VOLATILE_CHOP' ||
    (input.range?.compressed ?? false)
  if (ranging && input.range && input.rangePos) {
    const pos = input.rangePos
    const longBreak =
      input.side === 'LONG' &&
      (pos === 'BROKE_UP' || (pos === 'NEAR_HIGH' && input.move5mFavor >= 0.35))
    const shortBreak =
      input.side === 'SHORT' &&
      (pos === 'BROKE_DOWN' || (pos === 'NEAR_LOW' && input.move5mFavor >= 0.35))
    const edgeLong =
      input.side === 'LONG' &&
      pos === 'NEAR_LOW' &&
      input.earlyFavorPct >= 0.55 &&
      bookConfirm(input, true)
    const edgeShort =
      input.side === 'SHORT' &&
      pos === 'NEAR_HIGH' &&
      input.earlyFavorPct >= 0.55 &&
      bookConfirm(input, true)

    if (pos === 'INSIDE') {
      // Mid-range chop — never
      tags.push('MID_RANGE')
    } else if (
      (longBreak || shortBreak || edgeLong || edgeShort) &&
      bookConfirm(input, ranging && input.regime === 'VOLATILE_CHOP')
    ) {
      // Against HTF only if break is clean + 24h/5m agree
      if (input.conflicts && input.chg24Favor < 0.8 && input.move5mFavor < 0.5) {
        return { ok: false, reason: 'range_vs_htf', tags, context: null }
      }
      tags.push('RANGE_BREAK', `W${input.range.widthPct.toFixed(1)}%`)
      if (input.range.compressed) tags.push('COMPRESSED')
      if (input.bookGrade === 'STRONG') tags.push('BOOK_STRONG')
      if (input.absorption) tags.push('ABS')
      return { ok: true, reason: 'macro_range', tags, context: 'RANGE_BREAK' }
    }
  }

  // --- ZONE (HTF / internal) ---
  if (input.phase !== 'FAR') {
    tags.push(input.phase)
    if (input.zoneStrength >= MACRO_ZONE_STRENGTH && !input.conflicts) {
      if (
        input.aligns &&
        input.directionConfidence >= MACRO_DIR_CONF_MIN - 5 &&
        bookConfirm(input, false)
      ) {
        if (input.isInternal && input.zoneStrength < MACRO_ZONE_STRENGTH + 1) {
          /* fall through to momentum */
        } else {
          tags.push('ZONE')
          if (input.bookGrade === 'STRONG') tags.push('BOOK_STRONG')
          if (input.absorption) tags.push('ABS')
          if (input.cvdConfirm) tags.push('CVD')
          if (!input.isInternal) tags.push('HTF_ZONE')
          return { ok: true, reason: 'macro_zone', tags, context: 'ZONE' }
        }
      }
    }
  }

  // --- MOMENTUM (нет сильной зоны, но ход уже идёт) ---
  const momOk =
    input.earlyFavorPct >= 0.65 &&
    input.earlyFavorPct <= MACRO_IMPULSE_MAX &&
    bookConfirm(input, true) &&
    input.move5mFavor >= 0.25 &&
    (input.chg24Favor >= 0.5 || input.directionConfidence >= MACRO_DIR_CONF_MIN) &&
    !input.greenDeltaWeak

  if (momOk) {
    // Hard conflict with HTF + 24h against = skip
    if (input.conflicts && input.chg24Favor < 0) {
      return { ok: false, reason: 'mom_vs_htf', tags, context: null }
    }
    tags.push('MOMENTUM')
    if (input.chg24Abs >= 3) tags.push('HOT24')
    if (input.bookGrade === 'STRONG') tags.push('BOOK_STRONG')
    if (input.absorption) tags.push('ABS')
    return { ok: true, reason: 'macro_momentum', tags, context: 'MOMENTUM' }
  }

  return { ok: false, reason: 'no_macro_context', tags, context: null }
}

export function isMacroSetup(setup: string | null | undefined): boolean {
  return Boolean(setup && setup.startsWith('VANE_MACRO_'))
}

export function moveFavorPct(
  candles: Candle[],
  side: Side,
  bars: number
): number {
  if (candles.length < bars + 1) return 0
  const a = candles[candles.length - 1 - bars]![4]
  const b = candles[candles.length - 1]![4]
  if (!(a > 0) || !(b > 0)) return 0
  const pct = ((b - a) / a) * 100
  return side === 'LONG' ? pct : -pct
}
