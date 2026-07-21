import { useMemo } from 'react'
import type { OhlcvCandle } from '../api/mexc'
import type {
  ChartZoneSettings,
  LiquidityZone,
  PriceLevel,
} from '../engine/indicators/types'
import {
  calculateOrderBlockZones,
  calculateFvgZones,
  calculatePocLevel,
  calculateValueArea,
  calculateDailyPriceLevels,
  calculateFibPriceLevels,
} from '../engine/zones'

export function useChartZones(candles: OhlcvCandle[], settings: ChartZoneSettings) {
  return useMemo(() => {
    if (candles.length === 0) {
      return {
        liquidityZones: [] as LiquidityZone[],
        priceLevels: [] as PriceLevel[],
      }
    }

    const liquidityZones: LiquidityZone[] = []
    const priceLevels: PriceLevel[] = []

    if (settings.orderBlocks) {
      liquidityZones.push(...calculateOrderBlockZones(candles))
    }

    if (settings.fvg) {
      liquidityZones.push(...calculateFvgZones(candles))
    }

    if (settings.poc) {
      const poc = calculatePocLevel(candles)
      if (poc) liquidityZones.push(poc)
    }

    if (settings.valueArea) {
      const va = calculateValueArea(candles)
      if (va) liquidityZones.push(va)
    }

    if (settings.fibonacci) {
      priceLevels.push(...calculateFibPriceLevels(candles))
    }

    if (settings.dailyLevels) {
      priceLevels.push(...calculateDailyPriceLevels(candles))
    }

    return { liquidityZones, priceLevels }
  }, [candles, settings])
}
