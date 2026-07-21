import { useEffect, useRef, useCallback } from 'react'
import { fetchRecentTrades } from '../api/mexc'
import { detectBuyerAggression } from '../engine/aggression'
import { useAppStore } from '../store/useAppStore'
import { logger } from '../utils/logger'

const POLL_INTERVAL_MS = 10_000
const WINDOW_SEC = 20
const BUY_SELL_THRESHOLD = 3.0

/**
 * Опрашивает ленту сделок для открытого символа (только когда Drawer активен).
 */
export const useBuyerAggression = (internalSymbol: string | null) => {
  const setBuyerAggression = useAppStore((s) => s.setBuyerAggression)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMounted = useRef(true)

  const poll = useCallback(async () => {
    if (!internalSymbol || !isMounted.current) return

    try {
      const trades = await fetchRecentTrades(internalSymbol, 100)
      if (!isMounted.current) return

      const result = detectBuyerAggression(trades, WINDOW_SEC, BUY_SELL_THRESHOLD)
      setBuyerAggression(internalSymbol, result)

      if (result.detected) {
        logger.info(`[Aggression] ${internalSymbol} ${result.label}`)
      }
    } catch (err) {
      logger.warn(`[Aggression] poll failed for ${internalSymbol}`, err)
    }
  }, [internalSymbol, setBuyerAggression])

  useEffect(() => {
    isMounted.current = true

    if (!internalSymbol) return

    poll()

    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS)

    return () => {
      isMounted.current = false
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [internalSymbol, poll])
}
