import type { Time } from 'lightweight-charts'
import type { OhlcvCandle } from '../../api/mexc'
import type { IndicatorPoint, BollingerBandsPoint } from './types'

export function calculateEmaSeries(
  candles: OhlcvCandle[],
  period: number
): IndicatorPoint[] {
  if (candles.length < period) return []

  const closes = candles.map((c) => c[4])
  const k = 2 / (period + 1)
  const result: IndicatorPoint[] = []

  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period

  for (let i = period - 1; i < candles.length; i++) {
    if (i > period - 1) {
      ema = closes[i] * k + ema * (1 - k)
    }
    result.push({
      time: (candles[i][0] / 1000) as Time,
      value: ema,
    })
  }

  return result
}

export function calculateSmaSeries(
  candles: OhlcvCandle[],
  period: number
): IndicatorPoint[] {
  if (candles.length < period) return []

  const closes = candles.map((c) => c[4])
  const result: IndicatorPoint[] = []

  for (let i = period - 1; i < candles.length; i++) {
    const sum = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0)
    result.push({
      time: (candles[i][0] / 1000) as Time,
      value: sum / period,
    })
  }

  return result
}

export function calculateBollingerBands(
  candles: OhlcvCandle[],
  period = 20,
  stdDev = 2
): BollingerBandsPoint[] {
  if (candles.length < period) return []

  const closes = candles.map((c) => c[4])
  const result: BollingerBandsPoint[] = []

  for (let i = period - 1; i < candles.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1)
    const sma = slice.reduce((a, b) => a + b, 0) / period
    const variance = slice.reduce((sum, val) => sum + (val - sma) ** 2, 0) / period
    const std = Math.sqrt(variance)

    result.push({
      time: (candles[i][0] / 1000) as Time,
      upper: sma + stdDev * std,
      middle: sma,
      lower: sma - stdDev * std,
    })
  }

  return result
}

/** ATR as series (Wilder-style rolling TR average) */
export function calculateAtrSeries(
  candles: OhlcvCandle[],
  period = 14
): IndicatorPoint[] {
  if (candles.length < period + 1) return []

  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2]
    const low = candles[i][3]
    const prevClose = candles[i - 1][4]
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }

  const result: IndicatorPoint[] = []
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period

  for (let i = period - 1; i < trs.length; i++) {
    if (i > period - 1) {
      atr = (atr * (period - 1) + trs[i]) / period
    }
    result.push({
      time: (candles[i + 1][0] / 1000) as Time,
      value: atr,
    })
  }

  return result
}
