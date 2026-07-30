import { useMemo } from 'react'
import type { OhlcvCandle } from '../api/mexc'
import type {
  PriceForecast,
  MultiTFAlignment,
  LiquidityLevel,
  PriceScenario,
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

/** Timestamp последней (формирующейся) свечи на графике — unix seconds */
export function getLastCandleTimestamp(candles: OhlcvCandle[]): number {
  if (candles.length === 0) return Math.floor(Date.now() / 1000)
  return Math.floor(candles[candles.length - 1][0] / 1000)
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

/** Bucket OBI (−1…+1) so tiny book ticks don't rebuild paths */
export function quantizeBookImbalance(
  book: number | null | undefined,
  step = 0.05
): number | null {
  if (book == null || !Number.isFinite(book)) return null
  return Math.round(book / step) * step
}

function pickDominantScenario(
  scenarios: PriceScenario[]
): 'A' | 'B' | 'C' {
  let best: PriceScenario | null = null
  for (const s of scenarios) {
    if (!best || (s.probability ?? 0) > (best.probability ?? 0)) best = s
  }
  const id = best?.id
  return id === 'B' || id === 'C' ? id : 'A'
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
  // Stabilize deps: tiny OBI ticks must not recreate the memo key
  const bookQ = quantizeBookImbalance(bookImbalance)
  const priceQ =
    currentPrice > 0 ? Number(currentPrice.toPrecision(6)) : 0
  const rsQ =
    btcRelativeStrengthPct != null && Number.isFinite(btcRelativeStrengthPct)
      ? Math.round(btcRelativeStrengthPct * 2) / 2
      : null
  const mmKey = mmHunt
    ? `${mmHunt.preferredSide ?? ''}:${mmHunt.microTarget ?? ''}:${mmHunt.macroTarget ?? ''}:${mmHunt.microIsStopHunt ? 1 : 0}`
    : ''

  return useMemo(() => {
    if (!alignment || priceQ === 0) return null

    const mode = normalizeHorizon(horizon)
    const momentumPct = calcMomentumPct(candles, mode === 'SCALP' ? 5 : 8)

    if (mode === 'SWING' || horizon === 'MACRO') {
      const daily = candles1d.length >= 20 ? candles1d : candles
      if (daily.length < 20) return null

      // Anchor to last daily bar — not wall-clock (avoids path crawl thrash)
      const lastCandleTs = getLastCandleTimestamp(daily)
      const scenarios = buildMacroScenarios(
        daily,
        alignment,
        liquidityMap,
        priceQ,
        newsBias,
        fearGreed
      )
      const ctx = buildMacroContext(
        daily,
        alignment,
        liquidityMap,
        priceQ,
        newsBias,
        newsScore
      )

      return {
        symbol,
        currentPrice: priceQ,
        scenarios,
        mtfAlignment: alignment,
        liquidityMap,
        dominantScenario: pickDominantScenario(scenarios),
        generatedAt: Date.now(),
        candleTimeframeSeconds: 86_400,
        lastCandleTimestamp: lastCandleTs,
        horizon: horizon === 'MACRO' ? ('MACRO' as const) : ('SWING' as const),
        macroSummary: ctx.summary,
      }
    }

    if (candles.length < 20) return null
    // Anchor to last chart candle so paths stay stable between bars.
    // Future offsets (path timeOffsetSeconds) still project ahead of that bar.
    const lastCandleTs = getLastCandleTimestamp(candles)
    const pathTimeScale = mode === 'SCALP' ? 0.32 : 1.15
    const scenarios = buildScenarios(
      candles,
      alignment,
      liquidityMap,
      priceQ,
      activeTimeframe,
      lastCandleTs,
      {
        stopLoss,
        invalidationPrice,
        newsBias,
        fearGreed,
        horizon: mode,
        pathTimeScale,
        bookImbalance: bookQ,
        btcRelativeStrengthPct: rsQ,
        momentumPct,
        mmHunt,
      }
    )

    return {
      symbol,
      currentPrice: priceQ,
      scenarios,
      mtfAlignment: alignment,
      liquidityMap,
      dominantScenario: pickDominantScenario(scenarios),
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
    priceQ,
    symbol,
    activeTimeframe,
    stopLoss,
    invalidationPrice,
    horizon,
    newsBias,
    newsScore,
    fearGreed,
    bookQ,
    rsQ,
    refreshKey,
    mmKey,
    mmHunt,
  ])
}
