import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  fetchOhlcv,
  fetchDepth,
  fetchRecentTrades,
  fetchTickers,
  toFlatSymbol,
  toDisplayName,
} from '../api/mexc'
import {
  TOP_MEME_COUNT,
  filterMemeTickers,
  analyzeMemeMarketData,
  buildMemeCoinSignal,
} from '../engine/meme'
import type { MemeSignal } from '../engine/types'
import { loadMemeCoinAnalysis } from './loadMemeCoinAnalysis'
import { logger } from '../utils/logger'
import { useTelegramWebApp } from './useTelegramWebApp'

const SCAN_INTERVAL_MS = 20_000
const COIN_DELAY_MS = 150
const DEEP_SCAN_CANDIDATES = 12

export const useMemePulseScanner = () => {
  const updateMemeSignals = useAppStore((s) => s.updateMemeSignals)
  const upsertSignal = useAppStore((s) => s.upsertSignal)
  const { haptic, showAlert } = useTelegramWebApp()

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMounted = useRef(true)
  const alertedRef = useRef<Set<string>>(new Set())

  const scanMemeDeep = useCallback(
    async (
      internalSymbol: string,
      tickerPrice: number,
      priceChange24h: number
    ): Promise<MemeSignal | null> => {
      try {
        const ohlcv1m = await fetchOhlcv(internalSymbol, '1m', 60)
        if (!ohlcv1m.length || !isMounted.current) return null

        await new Promise((resolve) => setTimeout(resolve, COIN_DELAY_MS))

        const depth = await fetchDepth(internalSymbol, 20)
        if (!isMounted.current) return null

        await new Promise((resolve) => setTimeout(resolve, COIN_DELAY_MS))

        const trades = await fetchRecentTrades(internalSymbol, 100)
        const currentPrice = ohlcv1m[ohlcv1m.length - 1][4] || tickerPrice

        const signal = analyzeMemeMarketData(
          internalSymbol,
          toDisplayName(internalSymbol),
          toFlatSymbol(internalSymbol),
          currentPrice,
          priceChange24h,
          ohlcv1m,
          depth,
          trades
        )

        if (
          signal.quality === 'CRITICAL' &&
          signal.volumeSpike.detected &&
          !alertedRef.current.has(internalSymbol)
        ) {
          alertedRef.current.add(internalSymbol)
          haptic.notification('warning')
          showAlert(
            `🔥 MEME ALERT!\n${signal.displayName}\n${signal.volumeSpike.label}\nHeat: ${signal.heatScore}/100`
          )
        }

        return signal
      } catch (err) {
        logger.warn(`MemePulse scan error ${internalSymbol}`, err)
        return null
      }
    },
    [haptic, showAlert]
  )

  const scanAll = useCallback(async () => {
    try {
      const allTickers = await fetchTickers()
      if (!isMounted.current) return

      const memeTickers = filterMemeTickers(allTickers)
      const candidates = memeTickers.slice(0, DEEP_SCAN_CANDIDATES)

      const results: MemeSignal[] = []

      for (const t of candidates) {
        if (!isMounted.current) break
        const signal = await scanMemeDeep(
          t.symbol,
          t.lastPrice,
          t.priceChangePercent
        )
        if (signal) results.push(signal)
        await new Promise((resolve) => setTimeout(resolve, COIN_DELAY_MS))
      }

      if (!isMounted.current || !results.length) return

      results.sort((a, b) => {
        const qualityOrder = { CRITICAL: 0, STRONG: 1, MODERATE: 2, WEAK: 3 }
        if (a.quality !== b.quality) {
          return qualityOrder[a.quality] - qualityOrder[b.quality]
        }
        return b.heatScore - a.heatScore
      })

      const top10 = results.slice(0, TOP_MEME_COUNT)
      updateMemeSignals(top10)

      const marketContext = useAppStore.getState().marketContext
      for (const meme of top10) {
        const coinSignal = buildMemeCoinSignal(meme, marketContext)
        upsertSignal(coinSignal)
      }

      // Полный SMC-анализ для топ-3 (график + панели в drawer)
      const top3 = top10.slice(0, 3)
      for (const meme of top3) {
        if (!isMounted.current) break
        await loadMemeCoinAnalysis(meme)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    } catch (err) {
      logger.warn('MemePulse scan failed', err)
    }
  }, [scanMemeDeep, updateMemeSignals, upsertSignal])

  useEffect(() => {
    isMounted.current = true
    scanAll()
    intervalRef.current = setInterval(scanAll, SCAN_INTERVAL_MS)

    return () => {
      isMounted.current = false
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [scanAll])

  return { isScanning: true }
}
