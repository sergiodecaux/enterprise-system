import type { OhlcvCandle } from '../../api/mexc'
import { calculateAtr, detectMarketStructure } from '../smc'

export type HtfTrendBias = 'BULLISH' | 'BEARISH' | 'RANGING'
export type HtfStrengthLabel = 'WEAK' | 'MEDIUM' | 'STRONG'

export interface HtfTrendSnapshot {
  bias: HtfTrendBias
  /** 0–100 composite strength */
  strength: number
  label: HtfStrengthLabel
  /** Consecutive structure legs in bias direction */
  impulseLegs: number
  avgPullbackPct: number
  /** Dominant HTF used for bias */
  primaryTf: '1h' | '4h'
  bias1h: HtfTrendBias
  bias4h: HtfTrendBias
  strength1h: number
  strength4h: number
  reasons: string[]
  updatedAt: number
}

function biasFromStructure(
  trend: 'BULLISH' | 'BEARISH' | 'RANGING'
): HtfTrendBias {
  return trend
}

function scoreTf(candles: OhlcvCandle[], lookback: number): {
  bias: HtfTrendBias
  strength: number
  impulseLegs: number
  avgPullbackPct: number
  reasons: string[]
} {
  const reasons: string[] = []
  if (candles.length < Math.min(lookback, 30)) {
    return {
      bias: 'RANGING',
      strength: 35,
      impulseLegs: 0,
      avgPullbackPct: 0,
      reasons: ['Недостаточно свечей'],
    }
  }

  const structure = detectMarketStructure(
    candles,
    Math.min(lookback, candles.length)
  )
  const bias = biasFromStructure(structure.trend)
  const atr = calculateAtr(candles, 14) ?? candles[candles.length - 1][4] * 0.01
  const price = candles[candles.length - 1][4]

  // Count HH/HL or LH/LL legs from last swings
  const highs = structure.swingHighs.slice(-6).map((s) => s[1])
  const lows = structure.swingLows.slice(-6).map((s) => s[1])
  let impulseLegs = 0
  if (bias === 'BULLISH') {
    for (let i = 1; i < highs.length; i++) {
      if (highs[i] >= highs[i - 1]) impulseLegs++
    }
    for (let i = 1; i < lows.length; i++) {
      if (lows[i] >= lows[i - 1]) impulseLegs++
    }
  } else if (bias === 'BEARISH') {
    for (let i = 1; i < highs.length; i++) {
      if (highs[i] <= highs[i - 1]) impulseLegs++
    }
    for (let i = 1; i < lows.length; i++) {
      if (lows[i] <= lows[i - 1]) impulseLegs++
    }
  }

  // Average pullback depth vs ATR (shallower = stronger trend)
  const pulls: number[] = []
  if (bias === 'BULLISH' && lows.length >= 2) {
    for (let i = 1; i < lows.length; i++) {
      const prevHigh = highs[Math.min(i, highs.length - 1)] ?? price
      if (prevHigh > 0) {
        pulls.push(((prevHigh - lows[i]) / prevHigh) * 100)
      }
    }
  } else if (bias === 'BEARISH' && highs.length >= 2) {
    for (let i = 1; i < highs.length; i++) {
      const prevLow = lows[Math.min(i, lows.length - 1)] ?? price
      if (prevLow > 0) {
        pulls.push(((highs[i] - prevLow) / prevLow) * 100)
      }
    }
  }
  const avgPullbackPct =
    pulls.length > 0 ? pulls.reduce((a, b) => a + b, 0) / pulls.length : 0

  let strength = 40
  if (bias === 'RANGING') {
    strength = 30 + Math.min(15, impulseLegs * 2)
    reasons.push('Range / нет чёткой структуры')
  } else {
    strength = 45
    strength += Math.min(25, impulseLegs * 5)
    // Shallow pullbacks boost
    const atrPct = (atr / price) * 100
    if (avgPullbackPct > 0 && atrPct > 0) {
      if (avgPullbackPct < atrPct * 1.2) strength += 15
      else if (avgPullbackPct < atrPct * 2) strength += 8
      else strength -= 8
    }
    if (structure.lastBos === 'UP' && bias === 'BULLISH') {
      strength += 8
      reasons.push('BOS вверх')
    }
    if (structure.lastBos === 'DOWN' && bias === 'BEARISH') {
      strength += 8
      reasons.push('BOS вниз')
    }
    reasons.push(
      `${bias === 'BULLISH' ? 'Бычья' : 'Медвежья'} структура · ${impulseLegs} ног`
    )
    if (avgPullbackPct > 0) {
      reasons.push(`Ср. откат ${avgPullbackPct.toFixed(2)}%`)
    }
  }

  // Distance from last swing — stretched = slightly weaker for entries
  if (bias === 'BULLISH' && structure.lastSwingLow != null) {
    const dist =
      ((price - structure.lastSwingLow) / structure.lastSwingLow) * 100
    if (dist > atrPctSafe(atr, price) * 3) {
      strength -= 6
      reasons.push('Растянут от swing low')
    }
  }
  if (bias === 'BEARISH' && structure.lastSwingHigh != null) {
    const dist =
      ((structure.lastSwingHigh - price) / structure.lastSwingHigh) * 100
    if (dist > atrPctSafe(atr, price) * 3) {
      strength -= 6
      reasons.push('Растянут от swing high')
    }
  }

  strength = Math.max(0, Math.min(100, Math.round(strength)))
  return { bias, strength, impulseLegs, avgPullbackPct, reasons }
}

function atrPctSafe(atr: number, price: number): number {
  return price > 0 ? (atr / price) * 100 : 1
}

export function labelFromStrength(strength: number): HtfStrengthLabel {
  if (strength >= 70) return 'STRONG'
  if (strength >= 50) return 'MEDIUM'
  return 'WEAK'
}

/**
 * Сила тренда 1H + 4H: структура, ноги импульса, глубина откатов.
 */
export function computeHtfTrendStrength(
  ohlcv1h: OhlcvCandle[],
  ohlcv4h: OhlcvCandle[]
): HtfTrendSnapshot {
  const h1 = scoreTf(ohlcv1h, 50)
  const h4 = scoreTf(ohlcv4h, 40)

  // 4H weight heavier for bias
  let bias: HtfTrendBias = h4.bias
  if (h4.bias === 'RANGING') bias = h1.bias
  else if (h1.bias !== 'RANGING' && h1.bias !== h4.bias) {
    // Conflict → weaker ranging bias
    bias = h4.strength >= h1.strength + 10 ? h4.bias : 'RANGING'
  }

  const strength = Math.round(h4.strength * 0.55 + h1.strength * 0.45)
  const primaryTf: '1h' | '4h' =
    h4.bias !== 'RANGING' && h4.strength >= h1.strength ? '4h' : '1h'

  const reasons = [
    `4H: ${h4.bias} ${h4.strength}`,
    `1H: ${h1.bias} ${h1.strength}`,
    ...(primaryTf === '4h' ? h4.reasons : h1.reasons).slice(0, 3),
  ]

  return {
    bias,
    strength,
    label: labelFromStrength(strength),
    impulseLegs: Math.max(h1.impulseLegs, h4.impulseLegs),
    avgPullbackPct:
      h4.avgPullbackPct > 0 ? h4.avgPullbackPct : h1.avgPullbackPct,
    primaryTf,
    bias1h: h1.bias,
    bias4h: h4.bias,
    strength1h: h1.strength,
    strength4h: h4.strength,
    reasons,
    updatedAt: Date.now(),
  }
}

/** True if HTF strength fights the trade side (weak counter-trend ok; strong oppose = bad) */
export function htfOpposesSide(
  htf: HtfTrendSnapshot | null | undefined,
  side: 'LONG' | 'SHORT'
): boolean {
  if (!htf || htf.label === 'WEAK') return false
  if (side === 'LONG' && htf.bias === 'BEARISH' && htf.strength >= 55) return true
  if (side === 'SHORT' && htf.bias === 'BULLISH' && htf.strength >= 55) return true
  return false
}
