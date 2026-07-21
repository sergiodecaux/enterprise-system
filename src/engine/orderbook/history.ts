import type {
  OrderBookMetrics,
  ImbalanceSnapshot,
  OrderBookHistory,
  ImbalanceStats,
} from '../types'

const MAX_HISTORY_SIZE = 150 // ~5 мин при интервале 2с

export function createHistory(): OrderBookHistory {
  return {
    imbalanceHistory: [],
    maxHistorySize: MAX_HISTORY_SIZE,
    startTime: Date.now(),
  }
}

export function addSnapshot(
  history: OrderBookHistory,
  metrics: OrderBookMetrics
): OrderBookHistory {
  const snapshot: ImbalanceSnapshot = {
    timestamp: Date.now(),
    imbalance: metrics.imbalance,
    bidVolume: metrics.bidVolume,
    askVolume: metrics.askVolume,
    pressure: metrics.pressure,
    spread: metrics.spread,
  }

  const newHistory = [...history.imbalanceHistory, snapshot]
  if (newHistory.length > history.maxHistorySize) {
    newHistory.shift()
  }

  return {
    ...history,
    imbalanceHistory: newHistory,
  }
}

export function calculateImbalanceStats(
  history: OrderBookHistory
): ImbalanceStats | null {
  const { imbalanceHistory } = history
  if (imbalanceHistory.length < 5) return null

  const current = imbalanceHistory[imbalanceHistory.length - 1].imbalance
  const values = imbalanceHistory.map((s) => s.imbalance)

  const avg5min = values.reduce((sum, v) => sum + v, 0) / values.length

  const mid = Math.floor(values.length / 2)
  const firstHalf = values.slice(0, mid).reduce((s, v) => s + v, 0) / Math.max(1, mid)
  const secondHalf =
    values.slice(mid).reduce((s, v) => s + v, 0) / Math.max(1, values.length - mid)

  let trend: ImbalanceStats['trend'] = 'STABLE'
  if (secondHalf - firstHalf > 10) trend = 'RISING'
  else if (secondHalf - firstHalf < -10) trend = 'FALLING'

  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - avg5min, 2), 0) / values.length
  const volatility = Math.sqrt(variance)

  return {
    current,
    avg5min,
    trend,
    volatility,
    peakBuyers: Math.max(...values),
    peakSellers: Math.min(...values),
  }
}

export function getChartData(
  history: OrderBookHistory,
  pointsCount = 60
): Array<{ time: number; imbalance: number }> {
  return history.imbalanceHistory.slice(-pointsCount).map((s) => ({
    time: s.timestamp,
    imbalance: s.imbalance,
  }))
}
