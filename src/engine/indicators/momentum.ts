import type { Time } from 'lightweight-charts'
import type { OhlcvCandle } from '../../api/mexc'
import type { IndicatorPoint, MACDPoint } from './types'

function emaFromIndex(data: number[], period: number): number[] {
  if (data.length < period) return []
  const k = 2 / (period + 1)
  const result: number[] = new Array(data.length).fill(NaN)
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period
  result[period - 1] = ema
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k)
    result[i] = ema
  }
  return result
}

export function calculateRsiSeries(
  candles: OhlcvCandle[],
  period = 14
): IndicatorPoint[] {
  if (candles.length < period + 1) return []

  const closes = candles.map((c) => c[4])
  const result: IndicatorPoint[] = []

  let avgGain = 0
  let avgLoss = 0

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) avgGain += change
    else avgLoss += Math.abs(change)
  }
  avgGain /= period
  avgLoss /= period

  for (let i = period; i < candles.length; i++) {
    if (i > period) {
      const change = closes[i] - closes[i - 1]
      const gain = change > 0 ? change : 0
      const loss = change < 0 ? Math.abs(change) : 0
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    const rsi = 100 - 100 / (1 + rs)

    result.push({
      time: (candles[i][0] / 1000) as Time,
      value: rsi,
    })
  }

  return result
}

export function calculateMacdSeries(
  candles: OhlcvCandle[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MACDPoint[] {
  if (candles.length < slowPeriod + signalPeriod) return []

  const closes = candles.map((c) => c[4])
  const fastEma = emaFromIndex(closes, fastPeriod)
  const slowEma = emaFromIndex(closes, slowPeriod)

  const macdLine: Array<number | null> = closes.map((_, i) => {
    if (Number.isNaN(fastEma[i]) || Number.isNaN(slowEma[i])) return null
    return fastEma[i] - slowEma[i]
  })

  const macdValues = macdLine.map((v) => (v == null ? 0 : v))
  // Build signal only on valid MACD points
  const validStart = slowPeriod - 1
  const macdSlice = macdValues.slice(validStart)
  const signalEma = emaFromIndex(macdSlice, signalPeriod)

  const result: MACDPoint[] = []
  for (let i = 0; i < signalEma.length; i++) {
    if (Number.isNaN(signalEma[i])) continue
    const candleIndex = validStart + i
    if (candleIndex >= candles.length) break
    const macdValue = macdSlice[i]
    const signalValue = signalEma[i]
    result.push({
      time: (candles[candleIndex][0] / 1000) as Time,
      macd: macdValue,
      signal: signalValue,
      histogram: macdValue - signalValue,
    })
  }

  return result
}

export function calculateStochasticRsiSeries(
  candles: OhlcvCandle[],
  rsiPeriod = 14,
  stochPeriod = 14
): IndicatorPoint[] {
  const rsiSeries = calculateRsiSeries(candles, rsiPeriod)
  if (rsiSeries.length < stochPeriod) return []

  const rsiValues = rsiSeries.map((p) => p.value)
  const result: IndicatorPoint[] = []

  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod + 1, i + 1)
    const max = Math.max(...slice)
    const min = Math.min(...slice)
    const current = rsiValues[i]
    const stochRsi = max === min ? 50 : ((current - min) / (max - min)) * 100

    result.push({
      time: rsiSeries[i].time,
      value: stochRsi,
    })
  }

  return result
}
