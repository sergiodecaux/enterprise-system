import type { MexcTrade, OhlcvCandle } from '../../api/mexc'
import { detectCvdDivergence, computeCvdSeries } from './cvd'

export type CvdTrend = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

export interface EnhancedCvdSnapshot {
  /** Source of delta series */
  source: 'TRADES' | 'OHLCV_PROXY'
  trend: CvdTrend
  /** Buy share 0–100 over recent trades window */
  aggression: number
  divergence: boolean
  divergenceType: 'BULLISH' | 'BEARISH' | 'NONE'
  cumulativeDelta: number
  buyVolume: number
  sellVolume: number
  tradeCount: number
  updatedAt: number
}

/**
 * Real CVD from trade feed (BUY +, SELL −). Falls back to OHLCV proxy.
 */
export function buildEnhancedCvd(params: {
  trades?: MexcTrade[] | null
  candles1m?: OhlcvCandle[] | null
  windowMs?: number
}): EnhancedCvdSnapshot {
  const windowMs = params.windowMs ?? 5 * 60_000
  const now = Date.now()
  const trades = (params.trades ?? []).filter(
    (t) => now - t.timestamp <= windowMs
  )

  if (trades.length >= 8) {
    let buyVolume = 0
    let sellVolume = 0
    let cvd = 0
    for (const t of trades) {
      if (t.side === 'BUY') {
        buyVolume += t.volume
        cvd += t.volume
      } else {
        sellVolume += t.volume
        cvd -= t.volume
      }
    }
    const total = buyVolume + sellVolume
    const aggression = total > 0 ? (buyVolume / total) * 100 : 50

    let trend: CvdTrend = 'NEUTRAL'
    if (cvd > total * 0.08 || aggression >= 58) trend = 'BULLISH'
    else if (cvd < -total * 0.08 || aggression <= 42) trend = 'BEARISH'

    // Price vs CVD divergence using last trades as pseudo series
    const mid = Math.floor(trades.length / 2)
    const firstHalf = trades.slice(0, mid)
    const secondHalf = trades.slice(mid)
    const priceFirst =
      firstHalf.reduce((s, t) => s + t.price, 0) / (firstHalf.length || 1)
    const priceLast =
      secondHalf.reduce((s, t) => s + t.price, 0) / (secondHalf.length || 1)
    let cvdFirst = 0
    let cvdSecond = 0
    for (const t of firstHalf) cvdFirst += t.side === 'BUY' ? t.volume : -t.volume
    for (const t of secondHalf)
      cvdSecond += t.side === 'BUY' ? t.volume : -t.volume

    let divergence = false
    let divergenceType: EnhancedCvdSnapshot['divergenceType'] = 'NONE'
    if (priceLast < priceFirst * 0.998 && cvdSecond > cvdFirst) {
      divergence = true
      divergenceType = 'BULLISH'
    } else if (priceLast > priceFirst * 1.002 && cvdSecond < cvdFirst) {
      divergence = true
      divergenceType = 'BEARISH'
    }

    return {
      source: 'TRADES',
      trend,
      aggression,
      divergence,
      divergenceType,
      cumulativeDelta: cvd,
      buyVolume,
      sellVolume,
      tradeCount: trades.length,
      updatedAt: now,
    }
  }

  // Fallback: OHLCV proxy
  const candles = params.candles1m ?? []
  if (candles.length >= 15) {
    const series = computeCvdSeries(candles)
    const last = series[series.length - 1]?.cvd ?? 0
    const prev = series[Math.max(0, series.length - 10)]?.cvd ?? 0
    const delta = last - prev
    let trend: CvdTrend = 'NEUTRAL'
    if (delta > 0) trend = 'BULLISH'
    else if (delta < 0) trend = 'BEARISH'

    const div = detectCvdDivergence(candles, 20)
    const buyish = candles
      .slice(-20)
      .filter((c) => c[4] >= c[1])
      .reduce((s, c) => s + c[5], 0)
    const sellish = candles
      .slice(-20)
      .filter((c) => c[4] < c[1])
      .reduce((s, c) => s + c[5], 0)
    const tot = buyish + sellish
    const aggression = tot > 0 ? (buyish / tot) * 100 : 50

    return {
      source: 'OHLCV_PROXY',
      trend,
      aggression,
      divergence: div.detected,
      divergenceType: div.type,
      cumulativeDelta: last,
      buyVolume: buyish,
      sellVolume: sellish,
      tradeCount: 0,
      updatedAt: now,
    }
  }

  return {
    source: 'OHLCV_PROXY',
    trend: 'NEUTRAL',
    aggression: 50,
    divergence: false,
    divergenceType: 'NONE',
    cumulativeDelta: 0,
    buyVolume: 0,
    sellVolume: 0,
    tradeCount: 0,
    updatedAt: now,
  }
}
