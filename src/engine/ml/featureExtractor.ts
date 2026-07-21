import type {
  OrderBookHistory,
  ImbalanceStats,
  WallTrackerState,
  LiveTicker,
} from '../types'
import type { MLFeatures } from './types'

/**
 * Извлечь признаки из текущего состояния стакана / истории
 */
export function extractFeatures(
  history: OrderBookHistory,
  stats: ImbalanceStats | null,
  wallTracker: WallTrackerState,
  ticker: LiveTicker | null
): MLFeatures | null {
  if (!stats || history.imbalanceHistory.length < 10) {
    return null
  }

  const recent = history.imbalanceHistory.slice(-15)
  const current = recent[recent.length - 1]
  const prev = recent[Math.max(0, recent.length - 2)]

  const currentImbalance = current.imbalance
  const avgImbalance5min = stats.avg5min
  const imbalanceTrend =
    stats.trend === 'RISING' ? 1 : stats.trend === 'FALLING' ? -1 : 0
  const imbalanceVolatility = stats.volatility

  const totalVolume = current.bidVolume + current.askVolume
  const bidVolumeRatio = totalVolume > 0 ? current.bidVolume / totalVolume : 0.5
  const askVolumeRatio = totalVolume > 0 ? current.askVolume / totalVolume : 0.5

  const prevTotalVolume = prev.bidVolume + prev.askVolume
  const volumeChange =
    prevTotalVolume > 0 ? ((totalVolume - prevTotalVolume) / prevTotalVolume) * 100 : 0

  const activeWalls = Array.from(wallTracker.walls.values()).filter((w) => w.isActive)
  const activeBidWalls = activeWalls.filter((w) => w.side === 'BID').length
  const activeAskWalls = activeWalls.filter((w) => w.side === 'ASK').length

  const now = Date.now()
  const recentEaten = wallTracker.events.filter(
    (e) => e.type === 'EATEN' && now - e.timestamp < 30_000
  )
  const wallEatenRecently = recentEaten.length > 0 ? 1 : 0
  const wallEatenSide = recentEaten.length > 0 ? recentEaten[0].wall.side : null

  const spreadPercent = current.spread ?? 0
  const prevSpread = prev.spread ?? 0
  const spreadTrend = prevSpread > 0 ? (spreadPercent - prevSpread) / prevSpread : 0

  let priceChange1min = 0
  let priceVolatility = imbalanceVolatility

  if (ticker) {
    priceChange1min = ticker.priceChange24h / (24 * 60)
    priceVolatility = imbalanceVolatility
  }

  return {
    currentImbalance,
    avgImbalance5min,
    imbalanceTrend,
    imbalanceVolatility,
    bidVolumeRatio,
    askVolumeRatio,
    volumeChange,
    activeBidWalls,
    activeAskWalls,
    wallEatenRecently,
    wallEatenSide,
    spreadPercent,
    spreadTrend,
    priceChange1min,
    priceVolatility,
  }
}

export function normalizeFeatures(features: MLFeatures): number[] {
  return [
    features.currentImbalance / 100,
    features.avgImbalance5min / 100,
    features.imbalanceTrend,
    features.imbalanceVolatility / 50,
    features.bidVolumeRatio * 2 - 1,
    features.askVolumeRatio * 2 - 1,
    Math.tanh(features.volumeChange / 50),
    Math.min(features.activeBidWalls / 5, 1),
    Math.min(features.activeAskWalls / 5, 1),
    features.wallEatenRecently,
    features.wallEatenSide === 'BID' ? -1 : features.wallEatenSide === 'ASK' ? 1 : 0,
    Math.tanh(features.spreadPercent * 10),
    Math.tanh(features.spreadTrend),
    Math.tanh(features.priceChange1min / 10),
    features.priceVolatility / 50,
  ]
}
