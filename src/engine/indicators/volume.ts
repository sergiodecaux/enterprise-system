import type { Time } from 'lightweight-charts'
import type { OhlcvCandle } from '../../api/mexc'
import type { IndicatorPoint, VolumePoint } from './types'

export function calculateVwap(candles: OhlcvCandle[]): IndicatorPoint[] {
  if (candles.length === 0) return []

  let cumulativeTPV = 0
  let cumulativeVolume = 0
  const result: IndicatorPoint[] = []

  for (const candle of candles) {
    const [timestamp, , high, low, close, volume] = candle
    const typicalPrice = (high + low + close) / 3
    cumulativeTPV += typicalPrice * volume
    cumulativeVolume += volume
    const vwap = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : close

    result.push({
      time: (timestamp / 1000) as Time,
      value: vwap,
    })
  }

  return result
}

export function calculateVolumeSeries(candles: OhlcvCandle[]): VolumePoint[] {
  return candles.map((candle) => {
    const [timestamp, open, , , close, volume] = candle
    const isBullish = close >= open

    return {
      time: (timestamp / 1000) as Time,
      value: volume,
      color: isBullish ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)',
    }
  })
}
