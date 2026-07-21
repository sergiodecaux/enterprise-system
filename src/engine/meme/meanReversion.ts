import type { OhlcvCandle } from '../../api/mexc'
import { calculateRsi } from '../smc'

export interface MeanReversionResult {
  detected: boolean
  type: 'OVEREXTENDED_UP' | 'OVEREXTENDED_DOWN' | 'NONE'
  rsi: number | null
  outsideBollinger: boolean
  deviationPct: number
  hasLongWick: boolean
  recommendedDirection: 'SHORT' | 'LONG' | null
  expectedRetracePct: number
  quality: 'STRONG' | 'MODERATE' | 'WEAK'
  label: string
  emoji: string
}

function calculateBollingerBands(
  closes: number[],
  period = 20,
  stdDev = 2
): {
  upper: number[]
  middle: number[]
  lower: number[]
} {
  if (closes.length < period) {
    return { upper: [], middle: [], lower: [] }
  }

  const upper: number[] = []
  const middle: number[] = []
  const lower: number[] = []

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = slice.reduce((sum, val) => sum + val, 0) / period
    const variance =
      slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period
    const std = Math.sqrt(variance)

    middle.push(mean)
    upper.push(mean + std * stdDev)
    lower.push(mean - std * stdDev)
  }

  return { upper, middle, lower }
}

export function detectMeanReversion(
  candles: OhlcvCandle[],
  rsiThresholdHigh = 85,
  rsiThresholdLow = 15
): MeanReversionResult {
  const empty: MeanReversionResult = {
    detected: false,
    type: 'NONE',
    rsi: null,
    outsideBollinger: false,
    deviationPct: 0,
    hasLongWick: false,
    recommendedDirection: null,
    expectedRetracePct: 0,
    quality: 'WEAK',
    label: '',
    emoji: '',
  }

  if (candles.length < 30) return empty

  const closes = candles.map((c) => c[4])
  const rsi = calculateRsi(closes)

  const bb = calculateBollingerBands(closes, 20, 3)

  if (!bb.upper.length) return empty

  const currentPrice = closes[closes.length - 1]
  const bbUpper = bb.upper[bb.upper.length - 1]
  const bbMiddle = bb.middle[bb.middle.length - 1]
  const bbLower = bb.lower[bb.lower.length - 1]

  const outsideBollingerUp = currentPrice > bbUpper
  const outsideBollingerDown = currentPrice < bbLower
  const outsideBollinger = outsideBollingerUp || outsideBollingerDown

  const deviationPct = ((currentPrice - bbMiddle) / bbMiddle) * 100

  const lastCandle = candles[candles.length - 1]
  const [, open, high, low, close] = lastCandle
  const bodyTop = Math.max(open, close)
  const bodyBottom = Math.min(open, close)
  const totalRange = high - low
  const upperWick = high - bodyTop
  const lowerWick = bodyBottom - low

  const upperWickRatio = totalRange > 0 ? upperWick / totalRange : 0
  const lowerWickRatio = totalRange > 0 ? lowerWick / totalRange : 0

  const hasLongWick = upperWickRatio > 0.4 || lowerWickRatio > 0.4

  if (rsi > rsiThresholdHigh && outsideBollingerUp) {
    const quality: MeanReversionResult['quality'] =
      hasLongWick && upperWickRatio > 0.5 ? 'STRONG' : 'MODERATE'

    const expectedRetracePct = Math.min(Math.abs(deviationPct) * 0.5, 5)

    return {
      detected: true,
      type: 'OVEREXTENDED_UP',
      rsi,
      outsideBollinger: true,
      deviationPct,
      hasLongWick,
      recommendedDirection: 'SHORT',
      expectedRetracePct,
      quality,
      label: `Перекупленность | RSI ${rsi.toFixed(0)} | Откат ${expectedRetracePct.toFixed(1)}% ожидается`,
      emoji: '🔻',
    }
  }

  if (rsi < rsiThresholdLow && outsideBollingerDown) {
    const quality: MeanReversionResult['quality'] =
      hasLongWick && lowerWickRatio > 0.5 ? 'STRONG' : 'MODERATE'

    const expectedRetracePct = Math.min(Math.abs(deviationPct) * 0.5, 5)

    return {
      detected: true,
      type: 'OVEREXTENDED_DOWN',
      rsi,
      outsideBollinger: true,
      deviationPct,
      hasLongWick,
      recommendedDirection: 'LONG',
      expectedRetracePct,
      quality,
      label: `Перепроданность | RSI ${rsi.toFixed(0)} | Откат ${expectedRetracePct.toFixed(1)}% ожидается`,
      emoji: '🔼',
    }
  }

  return {
    ...empty,
    rsi,
    outsideBollinger,
    deviationPct,
    hasLongWick,
  }
}
