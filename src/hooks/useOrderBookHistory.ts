import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  OrderBookMetrics,
  OrderBookHistory,
  ImbalanceStats,
} from '../engine/types'
import {
  createHistory,
  addSnapshot,
  calculateImbalanceStats,
} from '../engine/orderbook/history'

export function useOrderBookHistory(metrics: OrderBookMetrics | null) {
  const [history, setHistory] = useState<OrderBookHistory>(createHistory)
  const [stats, setStats] = useState<ImbalanceStats | null>(null)
  const lastMetricsRef = useRef<OrderBookMetrics | null>(null)

  useEffect(() => {
    if (!metrics) return

    if (
      lastMetricsRef.current &&
      lastMetricsRef.current.imbalance === metrics.imbalance &&
      lastMetricsRef.current.bidVolume === metrics.bidVolume &&
      lastMetricsRef.current.askVolume === metrics.askVolume
    ) {
      return
    }

    lastMetricsRef.current = metrics

    setHistory((prev) => {
      const updated = addSnapshot(prev, metrics)
      setStats(calculateImbalanceStats(updated))
      return updated
    })
  }, [metrics])

  const resetHistory = useCallback(() => {
    lastMetricsRef.current = null
    setHistory(createHistory())
    setStats(null)
  }, [])

  return { history, stats, resetHistory }
}
