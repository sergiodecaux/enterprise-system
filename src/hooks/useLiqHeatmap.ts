import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchDepth,
  fetchRecentTrades,
  fetchTicker,
  type MexcTrade,
  type OhlcvCandle,
} from '../api/mexc'
import {
  buildLiqHeatmap,
  type LiqHeatmapModel,
} from '../engine/derivatives/liqHeatmap'
import type { OrderBookSnapshot } from '../engine/types'
import { logger } from '../utils/logger'

const FLOW_MS = 7_000
const OI_MS = 20_000

export function useLiqHeatmap(
  symbol: string,
  candles: OhlcvCandle[],
  currentPrice: number,
  enabled = true
): LiqHeatmapModel | null {
  const [trades, setTrades] = useState<MexcTrade[]>([])
  const [book, setBook] = useState<OrderBookSnapshot | null>(null)
  const [oi, setOi] = useState<number | null>(null)
  const oiAt = useRef(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setTrades([])
    setBook(null)

    const load = async () => {
      try {
        const needOi = Date.now() - oiAt.current > OI_MS
        const [tape, depth, ticker] = await Promise.all([
          fetchRecentTrades(symbol, 80),
          fetchDepth(symbol, 20),
          needOi ? fetchTicker(symbol) : Promise.resolve(null),
        ])
        if (cancelled) return
        setTrades(tape)
        setBook(depth)
        if (ticker?.openInterest != null) {
          setOi(ticker.openInterest)
          oiAt.current = Date.now()
        }
      } catch (err) {
        logger.warn('liq heatmap feed failed', err)
      }
    }

    void load()
    const id = window.setInterval(() => void load(), FLOW_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [symbol, enabled])

  return useMemo(
    () =>
      buildLiqHeatmap({
        candles,
        currentPrice,
        trades,
        book,
        openInterest: oi,
      }),
    [candles, currentPrice, trades, book, oi]
  )
}
