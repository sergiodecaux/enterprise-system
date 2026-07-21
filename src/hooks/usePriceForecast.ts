import { useMemo } from 'react'
import type { OhlcvCandle } from '../api/mexc'
import type {
  PriceForecast,
  MultiTFAlignment,
  LiquidityLevel,
} from '../engine/prediction/types'
import { buildScenarios } from '../engine/prediction/scenarioBuilder'

function getCandleSeconds(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
    '1d': 86400,
  }
  return map[tf] ?? 3600
}

/** Timestamp последней закрытой свечи (unix seconds) */
export function getLastCandleTimestamp(candles: OhlcvCandle[]): number {
  if (candles.length === 0) return Math.floor(Date.now() / 1000)
  const lastClosed = candles.length > 1 ? candles[candles.length - 2] : candles[0]
  return Math.floor(lastClosed[0] / 1000)
}

export function usePriceForecast(
  candles: OhlcvCandle[],
  alignment: MultiTFAlignment | null,
  liquidityMap: LiquidityLevel[],
  currentPrice: number,
  symbol: string,
  activeTimeframe: string,
  stopLoss?: number | null,
  invalidationPrice?: number | null
): PriceForecast | null {
  return useMemo(() => {
    if (!alignment || candles.length < 20 || currentPrice === 0) return null

    const lastCandleTs = getLastCandleTimestamp(candles)

    const scenarios = buildScenarios(
      candles,
      alignment,
      liquidityMap,
      currentPrice,
      activeTimeframe,
      lastCandleTs,
      { stopLoss, invalidationPrice }
    )

    return {
      symbol,
      currentPrice,
      scenarios,
      mtfAlignment: alignment,
      liquidityMap,
      dominantScenario: 'A' as const,
      generatedAt: Date.now(),
      candleTimeframeSeconds: getCandleSeconds(activeTimeframe),
      lastCandleTimestamp: lastCandleTs,
    }
  }, [
    candles,
    alignment,
    liquidityMap,
    currentPrice,
    symbol,
    activeTimeframe,
    stopLoss,
    invalidationPrice,
  ])
}
