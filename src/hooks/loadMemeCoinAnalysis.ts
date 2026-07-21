import {
  fetchOhlcv,
  fetchDepth,
  fetchRecentTrades,
  sleep,
  toFlatSymbol,
  toDisplayName,
} from '../api/mexc'
import { analyzeSymbol } from '../engine/ProbabilityEngine'
import { buildLiquidityMap, analyzePO3 } from '../engine/smc'
import { analyzeSessionDNA } from '../engine/sessions/dnaAnalyzer'
import { analyzeMemeMarketData } from '../engine/meme/analyzer'
import { buildMemeCoinSignal } from '../engine/meme/memeSignalBuilder'
import type { CoinSignal, MemeSignal } from '../engine/types'
import { useAppStore } from '../store/useAppStore'
import { logger } from '../utils/logger'

/**
 * Полный анализ мем-коина: SMC + Meme Pulse → CoinSignal в store.
 * Вызывается при клике на карточку и после сканирования топ-10.
 */
export async function loadMemeCoinAnalysis(
  meme: MemeSignal
): Promise<CoinSignal> {
  const {
    marketContext,
    upsertSignal,
    setLiquidityMap,
    setSessionDNA,
    setPO3Analysis,
    updateTicker,
  } = useAppStore.getState()

  const internalSymbol = meme.internalSymbol

  try {
    await sleep(120)
    const ohlcv4h = await fetchOhlcv(internalSymbol, '4h', 100)
    await sleep(120)
    const ohlcv1h = await fetchOhlcv(internalSymbol, '1h', 720)
    await sleep(120)
    const ohlcv15m = await fetchOhlcv(internalSymbol, '15m', 50)
    await sleep(120)
    const ohlcv5m = await fetchOhlcv(internalSymbol, '5m', 120)
    await sleep(120)
    const ohlcv1m = await fetchOhlcv(internalSymbol, '1m', 60)

    const depth = await fetchDepth(internalSymbol, 20)
    const trades = await fetchRecentTrades(internalSymbol, 100)

    const currentPrice = ohlcv1h[ohlcv1h.length - 1]?.[4] ?? meme.price

    const freshMeme = analyzeMemeMarketData(
      internalSymbol,
      toDisplayName(internalSymbol),
      toFlatSymbol(internalSymbol),
      currentPrice,
      meme.priceChange24h,
      ohlcv1m,
      depth,
      trades
    )

    const dailyBias = marketContext
      ? {
          direction: marketContext.dailyDirection,
          bias: marketContext.dailyBias as 'BULLISH' | 'BEARISH' | 'NEUTRAL',
          confidence: marketContext.dailyConfidence,
          dailyAnalysis: marketContext.dailyAnalysis,
          dailyLevels: marketContext.dailyLevels,
        }
      : {
          direction: 'BOTH' as const,
          bias: 'NEUTRAL' as const,
          confidence: 0,
          dailyAnalysis: null,
          dailyLevels: null,
        }

    let liquidityMap
    try {
      if (ohlcv1h.length >= 30 && currentPrice > 0) {
        liquidityMap = buildLiquidityMap(ohlcv1h, currentPrice, internalSymbol, '1h')
        setLiquidityMap(internalSymbol, liquidityMap)
      }
    } catch (err) {
      logger.warn(`Meme liquidity map error ${internalSymbol}`, err)
    }

    try {
      if (ohlcv1h.length >= 200) {
        setSessionDNA(internalSymbol, analyzeSessionDNA(ohlcv1h, internalSymbol))
      }
    } catch (err) {
      logger.warn(`Meme SessionDNA error ${internalSymbol}`, err)
    }

    try {
      if (ohlcv1h.length >= 24 && currentPrice > 0) {
        setPO3Analysis(internalSymbol, analyzePO3(ohlcv1h, currentPrice))
      }
    } catch (err) {
      logger.warn(`Meme PO3 error ${internalSymbol}`, err)
    }

    const baseSym = internalSymbol.split('/')[0]
    const newsBoost = useAppStore.getState().newsSettings.scoreInfluence
      ? useAppStore.getState().newsIntel.coinSentiments[baseSym]?.scoreBoost
      : undefined

    const { signal: smcSignal } = analyzeSymbol({
      internalSymbol,
      ohlcv4h,
      ohlcv1h,
      ohlcv15m,
      priceChange24h: meme.priceChange24h,
      dailyBias,
      btcTrend: marketContext?.btcTrend ?? 'RANGING',
      newsSentimentBoost: newsBoost,
      liquidityMap,
      ohlcv5m: ohlcv5m.length >= 15 ? ohlcv5m : undefined,
      ohlcv1m: ohlcv1m.length >= 20 ? ohlcv1m : undefined,
    })

    const coinSignal = buildMemeCoinSignal(freshMeme, marketContext, smcSignal)
    upsertSignal(coinSignal)

    updateTicker({
      symbol: coinSignal.symbol,
      price: coinSignal.price,
      priceChange24h: coinSignal.priceChange24h,
      volume24h: 0,
      high24h: coinSignal.price,
      low24h: coinSignal.price,
      timestamp: Date.now(),
    })

    return coinSignal
  } catch (err) {
    logger.warn(`Meme full analysis failed ${internalSymbol}`, err)
    const fallback = buildMemeCoinSignal(meme, marketContext)
    upsertSignal(fallback)
    return fallback
  }
}
