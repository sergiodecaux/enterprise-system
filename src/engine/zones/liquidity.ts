import type { Time } from 'lightweight-charts'
import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone, PriceLevel } from '../indicators/types'
import { findOrderBlocks, findFvg, detectMarketStructure } from '../smc'

export function calculateOrderBlockZones(candles: OhlcvCandle[]): LiquidityZone[] {
  if (candles.length < 20) return []

  const structure = detectMarketStructure(candles)
  const orderBlocks = findOrderBlocks(candles, structure, 10)

  return orderBlocks.map((ob) => {
    const startCandle = candles[ob.index]
    const endCandle = candles[candles.length - 1]

    return {
      id: `ob_${ob.type}_${ob.index}`,
      type: 'ORDER_BLOCK' as const,
      side: ob.type,
      top: ob.top,
      bottom: ob.bottom,
      startTime: (startCandle[0] / 1000) as Time,
      endTime: (endCandle[0] / 1000) as Time,
      strength: ob.strength,
      label: `OB ${ob.type} ${ob.strength}/10`,
    }
  })
}

export function calculateFvgZones(candles: OhlcvCandle[]): LiquidityZone[] {
  if (candles.length < 5) return []

  const fvgList = findFvg(candles, 10)

  return fvgList.map((fvg) => {
    const startCandle = candles[fvg.index]
    const endCandle = candles[candles.length - 1]

    return {
      id: `fvg_${fvg.type}_${fvg.index}`,
      type: 'FVG' as const,
      side: fvg.type,
      top: fvg.top,
      bottom: fvg.bottom,
      startTime: (startCandle[0] / 1000) as Time,
      endTime: (endCandle[0] / 1000) as Time,
      strength: 5,
      label: `FVG ${fvg.type}`,
    }
  })
}

export function calculatePocLevel(candles: OhlcvCandle[]): LiquidityZone | null {
  if (candles.length === 0) return null

  let maxVolume = 0
  let maxIndex = 0

  candles.forEach((candle, i) => {
    if (candle[5] > maxVolume) {
      maxVolume = candle[5]
      maxIndex = i
    }
  })

  const pocCandle = candles[maxIndex]
  const pocPrice = (pocCandle[2] + pocCandle[3]) / 2

  return {
    id: 'poc_level',
    type: 'POC',
    side: 'NEUTRAL',
    top: pocPrice + pocPrice * 0.001,
    bottom: pocPrice - pocPrice * 0.001,
    startTime: (candles[0][0] / 1000) as Time,
    endTime: (candles[candles.length - 1][0] / 1000) as Time,
    strength: 10,
    label: `POC $${pocPrice.toFixed(2)}`,
  }
}

export function calculateValueArea(candles: OhlcvCandle[]): LiquidityZone | null {
  if (candles.length < 10) return null

  const volumes = candles.map((c) => c[5])
  const totalVolume = volumes.reduce((a, b) => a + b, 0)
  const target = totalVolume * 0.7

  const sorted = candles
    .map((c, i) => ({ candle: c, index: i }))
    .sort((a, b) => b.candle[5] - a.candle[5])

  let accumulated = 0
  const vaIndices: number[] = []

  for (const { candle, index } of sorted) {
    accumulated += candle[5]
    vaIndices.push(index)
    if (accumulated >= target) break
  }

  const vaPrices = vaIndices.map((i) => ({
    high: candles[i][2],
    low: candles[i][3],
  }))

  const vaHigh = Math.max(...vaPrices.map((p) => p.high))
  const vaLow = Math.min(...vaPrices.map((p) => p.low))

  return {
    id: 'value_area',
    type: 'VALUE_AREA',
    side: 'NEUTRAL',
    top: vaHigh,
    bottom: vaLow,
    startTime: (candles[0][0] / 1000) as Time,
    endTime: (candles[candles.length - 1][0] / 1000) as Time,
    strength: 7,
    label: 'Value Area (70%)',
  }
}

/** Previous completed candle high/low/close as daily-style levels */
export function calculateDailyPriceLevels(candles: OhlcvCandle[]): PriceLevel[] {
  if (candles.length < 2) return []

  const prev = candles[candles.length - 2]
  const high = prev[2]
  const low = prev[3]
  const close = prev[4]

  return [
    {
      id: 'daily_high',
      type: 'DAILY_HIGH',
      price: high,
      label: 'PDH',
      color: 'rgba(226, 232, 240, 0.55)',
      lineStyle: 2,
    },
    {
      id: 'daily_low',
      type: 'DAILY_LOW',
      price: low,
      label: 'PDL',
      color: 'rgba(226, 232, 240, 0.55)',
      lineStyle: 2,
    },
    {
      id: 'daily_close',
      type: 'DAILY_CLOSE',
      price: close,
      label: 'PDC',
      color: 'rgba(148, 163, 184, 0.5)',
      lineStyle: 1,
    },
  ]
}
