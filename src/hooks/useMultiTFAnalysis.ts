import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchOhlcv, type OhlcvCandle } from '../api/mexc'
import {
  analyzeTFSnapshot,
  calculateMTFAlignment,
} from '../engine/prediction/multiTFAnalyzer'
import { buildLiquidityMap } from '../engine/prediction/liquidityMap'
import type { MultiTFAlignment, LiquidityLevel } from '../engine/prediction/types'
import { logger } from '../utils/logger'

interface MultiTFData {
  alignment: MultiTFAlignment | null
  liquidityMap: LiquidityLevel[]
  candles1d: OhlcvCandle[]
  candles4h: OhlcvCandle[]
  candles1h: OhlcvCandle[]
  isLoading: boolean
  error: string | null
  lastUpdate: number
}

const REFRESH_INTERVAL = 5 * 60 * 1000
const empty: MultiTFData = {
  alignment: null,
  liquidityMap: [],
  candles1d: [],
  candles4h: [],
  candles1h: [],
  isLoading: false,
  error: null,
  lastUpdate: 0,
}

export function useMultiTFAnalysis(
  symbol: string,
  currentPrice: number,
  enabled = true
): MultiTFData {
  const [data, setData] = useState<MultiTFData>(empty)
  const priceRef = useRef(currentPrice)
  priceRef.current = currentPrice

  const load = useCallback(async () => {
    if (!enabled || !symbol) return
    const price = priceRef.current
    if (!price) return

    setData((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const [candles1d, candles4h, candles1h] = await Promise.all([
        fetchOhlcv(symbol, '1d', 60),
        fetchOhlcv(symbol, '4h', 100),
        fetchOhlcv(symbol, '1h', 120),
      ])

      const daily = analyzeTFSnapshot(candles1d, '1d')
      const h4 = analyzeTFSnapshot(candles4h, '4h')
      const h1 = analyzeTFSnapshot(candles1h, '1h')
      const alignment = calculateMTFAlignment(daily, h4, h1, price)
      const liquidityMap = buildLiquidityMap(candles1d, candles4h, candles1h, price)

      setData({
        alignment,
        liquidityMap,
        candles1d,
        candles4h,
        candles1h,
        isLoading: false,
        error: null,
        lastUpdate: Date.now(),
      })
    } catch (err) {
      logger.warn('[MultiTF] Load error:', err)
      setData((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Ошибка загрузки',
      }))
    }
  }, [symbol, enabled])

  useEffect(() => {
    setData(empty)
  }, [symbol])

  useEffect(() => {
    load()
    const interval = setInterval(load, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [load])

  return data
}
