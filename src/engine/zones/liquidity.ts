import type { Time } from 'lightweight-charts'
import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone, PriceLevel } from '../indicators/types'
import { findOrderBlocks, findFvg, detectMarketStructure } from '../smc'
import {
  calculateVolumeProfile,
  volumeProfileToZones,
} from '../volumeProfile'

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
  const profile = calculateVolumeProfile(candles, 48, true)
  if (!profile) return null

  const zones = volumeProfileToZones(
    profile,
    candles[0][0],
    candles[candles.length - 1][0]
  )
  return zones.find((z) => z.type === 'POC') ?? null
}

export function calculateValueArea(candles: OhlcvCandle[]): LiquidityZone | null {
  const profile = calculateVolumeProfile(candles, 48, true)
  if (!profile) return null

  const zones = volumeProfileToZones(
    profile,
    candles[0][0],
    candles[candles.length - 1][0]
  )
  return zones.find((z) => z.type === 'VALUE_AREA') ?? null
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
