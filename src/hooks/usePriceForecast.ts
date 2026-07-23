import { useMemo } from 'react'
import type { OhlcvCandle } from '../api/mexc'
import type {
  PriceForecast,
  MultiTFAlignment,
  LiquidityLevel,
} from '../engine/prediction/types'
import { buildScenarios } from '../engine/prediction/scenarioBuilder'
import {
  buildMacroContext,
  buildMacroScenarios,
  type ForecastHorizon,
} from '../engine/prediction/macroOutlook'

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

function normalizeHorizon(
  horizon: ForecastHorizon
): 'SCALP' | 'INTRA' | 'SWING' | 'MACRO' {
  if (horizon === 'MACRO') return 'SWING'
  return horizon
}

function calcMomentumPct(candles: OhlcvCandle[], lookback = 8): number {
  if (candles.length < lookback + 1) return 0
  const end = candles[candles.length - 1][4]
  const start = candles[candles.length - 1 - lookback][4]
  if (start <= 0) return 0
  return ((end - start) / start) * 100
}

export function usePriceForecast(
  candles: OhlcvCandle[],
  alignment: MultiTFAlignment | null,
  liquidityMap: LiquidityLevel[],
  currentPrice: number,
  symbol: string,
  activeTimeframe: string,
  stopLoss?: number | null,
  invalidationPrice?: number | null,
  horizon: ForecastHorizon = 'INTRA',
  candles1d: OhlcvCandle[] = [],
  newsBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL',
  newsScore = 0,
  fearGreed: number | null = null,
  /** −1…+1 from order book */
  bookImbalance: number | null = null,
  /** coin − btc RS % */
  btcRelativeStrengthPct: number | null = null,
  /** force refresh tick (e.g. ticker updates) */
  refreshKey = 0,
  mmHunt: {
    microTarget: number | null
    macroTarget: number | null
    microIsStopHunt: boolean
    preferredSide: 'LONG' | 'SHORT' | null
  } | null = null
): PriceForecast | null {
  return useMemo(() => {
    if (!alignment || currentPrice === 0) return null

    const mode = normalizeHorizon(horizon)
    const momentumPct = calcMomentumPct(candles, mode === 'SCALP' ? 5 : 8)

    if (mode === 'SWING' || horizon === 'MACRO') {
      const daily = candles1d.length >= 20 ? candles1d : candles
      if (daily.length < 20) return null

      const lastCandleTs = Math.floor(Date.now() / 1000)
      const scenarios = buildMacroScenarios(
        daily,
        alignment,
        liquidityMap,
        currentPrice,
        newsBias,
        fearGreed
      )
      const ctx = buildMacroContext(
        daily,
        alignment,
        liquidityMap,
        currentPrice,
        newsBias,
        newsScore
      )

      return {
        symbol,
        currentPrice,
        scenarios,
        mtfAlignment: alignment,
        liquidityMap,
        dominantScenario: 'A' as const,
        generatedAt: Date.now(),
        candleTimeframeSeconds: 86_400,
        lastCandleTimestamp: lastCandleTs,
        horizon: horizon === 'MACRO' ? ('MACRO' as const) : ('SWING' as const),
        macroSummary: ctx.summary,
      }
    }

    if (candles.length < 20) return null
    // Anchor paths to "now" so scenarios crawl forward instead of freezing
    // on the last closed HTF bar for hours.
    const lastCandleTs = Math.floor(Date.now() / 1000)
    const pathTimeScale = mode === 'SCALP' ? 0.32 : 1.15
    const scenarios = buildScenarios(
      candles,
      alignment,
      liquidityMap,
      currentPrice,
      activeTimeframe,
      lastCandleTs,
      {
        stopLoss,
        invalidationPrice,
        newsBias,
        fearGreed,
        horizon: mode,
        pathTimeScale,
        bookImbalance,
        btcRelativeStrengthPct,
        momentumPct,
        mmHunt,
      }
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
      horizon: mode,
    }
  }, [
    candles,
    candles1d,
    alignment,
    liquidityMap,
    currentPrice,
    symbol,
    activeTimeframe,
    stopLoss,
    invalidationPrice,
    horizon,
    newsBias,
    newsScore,
    fearGreed,
    bookImbalance,
    btcRelativeStrengthPct,
    refreshKey,
    mmHunt,
  ])
}
