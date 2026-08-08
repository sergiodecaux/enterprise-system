/**
 * Market Regime Detector — prefers models, does NOT hard-kill the opposite side.
 *
 * EXPANSION  → bias PUMP_CONTINUE (SHORT still allowed if pierce score wins)
 * EXHAUSTION → bias PEAK / DUMP fade
 * RANGE      → only skip when ATR truly dead (quiet chop)
 */

import type { Candle } from './peakFuelFail'

export type MarketRegime = 'EXPANSION' | 'EXHAUSTION' | 'RANGE'

export interface RegimeResult {
  regime: MarketRegime
  atrPct: number
  rangeExp: number
  relVol: number
  oiVelocity: number | null
  reasons: string[]
}

const ATR_BARS = 14

/** Wilder-ish ATR% from 1m OHLC (index: o,h,l,c,vol). */
export function atrPct1m(candles: Candle[], bars = ATR_BARS): number {
  const closed = candles.slice(0, -1)
  if (closed.length < bars + 1) return 0
  const w = closed.slice(-bars)
  let sum = 0
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!
    const prev = closed[closed.length - bars + i - 1] ?? c
    const tr = Math.max(
      c[2] - c[3],
      Math.abs(c[2] - prev[4]),
      Math.abs(c[3] - prev[4])
    )
    sum += tr
  }
  const atr = sum / bars
  const px = w[w.length - 1]![4]
  return px > 0 ? (atr / px) * 100 : 0
}

/** SL distance = k * ATR, clamped for meme noise / high leverage. */
export function atrStopDistance(
  candles: Candle[],
  price: number,
  k = 1.2,
  minPct = 0.0045,
  maxPct = 0.011
): number {
  const atr = atrPct1m(candles) / 100
  if (!(price > 0) || !(atr > 0)) return price * 0.008
  const pct = Math.min(maxPct, Math.max(minPct, atr * k))
  return price * pct
}

/**
 * Build a liq-aware meme stop from ATR + micro structure only.
 * Never use deep swing lows/highs (those put SL beyond liquidation).
 * Returns null when structure risk > maxPct — skip the trade.
 */
export function memeRiskStop(
  entry: number,
  side: 'LONG' | 'SHORT',
  atrDist: number,
  microLevel: number,
  opts?: { minPct?: number; maxPct?: number }
): { sl: number; riskPct: number; reasons: string[] } | null {
  const minPct = opts?.minPct ?? 0.0045
  const maxPct = opts?.maxPct ?? 0.011
  if (!(entry > 0) || !(atrDist > 0)) return null
  const reasons: string[] = []

  if (side === 'LONG') {
    const atrSl = entry - atrDist
    const parts = [atrSl]
    if (microLevel > 0 && microLevel < entry) {
      parts.push(microLevel * 0.9985)
      reasons.push('sl:micro')
    } else {
      reasons.push('sl:atr')
    }
    // Highest SL below entry = tightest risk (NOT Math.min / deep swing)
    let sl = Math.max(...parts)
    let riskPct = (entry - sl) / entry
    if (riskPct > maxPct) {
      reasons.push(`sl_too_wide:${(riskPct * 100).toFixed(2)}`)
      return null
    }
    if (riskPct < minPct) {
      sl = entry * (1 - minPct)
      riskPct = minPct
      reasons.push('sl:min_pad')
    }
    reasons.push(`risk_pct:${(riskPct * 100).toFixed(2)}`)
    return { sl, riskPct, reasons }
  }

  const atrSl = entry + atrDist
  const parts = [atrSl]
  if (microLevel > entry) {
    parts.push(microLevel * 1.0015)
    reasons.push('sl:micro')
  } else {
    reasons.push('sl:atr')
  }
  // Lowest SL above entry = tightest risk
  let sl = Math.min(...parts)
  let riskPct = (sl - entry) / entry
  if (riskPct > maxPct) {
    reasons.push(`sl_too_wide:${(riskPct * 100).toFixed(2)}`)
    return null
  }
  if (riskPct < minPct) {
    sl = entry * (1 + minPct)
    riskPct = minPct
    reasons.push('sl:min_pad')
  }
  reasons.push(`risk_pct:${(riskPct * 100).toFixed(2)}`)
  return { sl, riskPct, reasons }
}

/** Last ~micro structure low/high from recent closed + forming bar. */
export function microStructureLevel(
  candles: Candle[],
  side: 'LONG' | 'SHORT'
): number {
  const w = candles.slice(-4)
  if (w.length < 2) return 0
  if (side === 'LONG') {
    let lo = Number.POSITIVE_INFINITY
    for (const c of w) lo = Math.min(lo, c[3])
    return Number.isFinite(lo) ? lo : 0
  }
  let hi = 0
  for (const c of w) hi = Math.max(hi, c[2])
  return hi
}

export function detectMarketRegime(
  candles: Candle[],
  opts?: { oiChangePct?: number | null; spreadBps?: number | null }
): RegimeResult {
  const reasons: string[] = []
  const closed = candles.slice(0, -1)
  if (closed.length < 30) {
    return {
      regime: 'RANGE',
      atrPct: 0,
      rangeExp: 1,
      relVol: 1,
      oiVelocity: opts?.oiChangePct ?? null,
      reasons: ['regime:cold_candles'],
    }
  }

  const atrPct = atrPct1m(candles)
  const recent = closed.slice(-5)
  const prior = closed.slice(-25, -5)
  const recentRange =
    Math.max(...recent.map((c) => c[2])) - Math.min(...recent.map((c) => c[3]))
  const priorRange =
    Math.max(...prior.map((c) => c[2])) - Math.min(...prior.map((c) => c[3]))
  const priorNorm = priorRange / Math.max(prior.length / 5, 1)
  const rangeExp = priorNorm > 0 ? recentRange / priorNorm : 1

  const recentVol = recent.reduce((s, c) => s + (c[5] || 0), 0) / recent.length
  const priorVol = prior.reduce((s, c) => s + (c[5] || 0), 0) / prior.length
  const relVol = priorVol > 0 ? recentVol / priorVol : 1

  const last3 = closed.slice(-3)
  const prev3 = closed.slice(-6, -3)
  const lastNet =
    last3.reduce((s, c) => s + (c[4] - c[1]), 0) /
    Math.max(last3[0]![1], 1e-12)
  const prevNet =
    prev3.reduce((s, c) => s + (c[4] - c[1]), 0) /
    Math.max(prev3[0]![1], 1e-12)
  const slowing =
    Math.abs(lastNet) < Math.abs(prevNet) * 0.55 && Math.abs(prevNet) > 0

  const oiVelocity = opts?.oiChangePct ?? null
  const spreadWide = opts?.spreadBps != null && opts.spreadBps >= 12

  reasons.push(`atr:${atrPct.toFixed(3)}`)
  reasons.push(`rangeExp:${rangeExp.toFixed(2)}`)
  reasons.push(`relVol:${relVol.toFixed(2)}`)
  if (oiVelocity != null) reasons.push(`oiVel:${oiVelocity.toFixed(2)}`)
  if (spreadWide) reasons.push('spread_wide')
  if (slowing) reasons.push('slowing')

  // Elevated ATR never = dead RANGE (that blocked JIMOTHY at atr 2.36%)
  if (atrPct >= 0.12) {
    if (slowing || (rangeExp < 0.95 && Math.abs(prevNet) * 100 >= 0.25)) {
      reasons.push('regime:exhaustion')
      return {
        regime: 'EXHAUSTION',
        atrPct,
        rangeExp,
        relVol,
        oiVelocity,
        reasons,
      }
    }
    reasons.push('regime:expansion')
    return {
      regime: 'EXPANSION',
      atrPct,
      rangeExp,
      relVol,
      oiVelocity,
      reasons,
    }
  }

  // Soft expansion
  if (atrPct >= 0.08 && rangeExp >= 1.15 && Math.abs(lastNet) * 100 >= 0.15) {
    reasons.push(slowing ? 'regime:exhaustion_soft' : 'regime:expansion_soft')
    return {
      regime: slowing ? 'EXHAUSTION' : 'EXPANSION',
      atrPct,
      rangeExp,
      relVol,
      oiVelocity,
      reasons,
    }
  }

  // True quiet chop only
  reasons.push('regime:range')
  return {
    regime: 'RANGE',
    atrPct,
    rangeExp,
    relVol,
    oiVelocity,
    reasons,
  }
}

/**
 * Hard block only truly dead RANGE.
 * EXPANSION/EXHAUSTION allow BOTH long continue and short fade —
 * preference is applied via regimeScoreBias + pickPumpLane.
 */
export function regimeAllowsSetup(
  regime: MarketRegime,
  setup: 'PUMP_CONTINUE' | 'PEAK_FUEL_FAIL' | 'DUMP_FUEL_FAIL',
  atrPct = 0
): boolean {
  if (regime === 'RANGE') {
    // Allow trade if ATR still alive (misclassified quiet-ish meme)
    if (atrPct >= 0.1) return true
    return false
  }
  // Both sides on pumps; dump reclaim always ok outside dead range
  if (setup === 'DUMP_FUEL_FAIL') return true
  if (setup === 'PUMP_CONTINUE' || setup === 'PEAK_FUEL_FAIL') return true
  return false
}

/** Score bias — prefer model, don't forbid opposite. */
export function regimeScoreBias(
  regime: MarketRegime,
  setup: 'PUMP_CONTINUE' | 'PEAK_FUEL_FAIL' | 'DUMP_FUEL_FAIL'
): number {
  if (regime === 'EXPANSION') {
    if (setup === 'PUMP_CONTINUE') return 2
    if (setup === 'PEAK_FUEL_FAIL') return 0 // was -∞ hard block
    if (setup === 'DUMP_FUEL_FAIL') return 0
  }
  if (regime === 'EXHAUSTION') {
    if (setup === 'PEAK_FUEL_FAIL') return 2
    if (setup === 'DUMP_FUEL_FAIL') return 2
    if (setup === 'PUMP_CONTINUE') return 0
  }
  return 0
}
