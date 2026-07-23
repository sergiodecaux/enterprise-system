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
  MEME_BATCH_SIZE,
  MEME_SIGNAL_TTL_MS,
  filterMemeTickers,
  prioritizeMemeBatch,
  summarizeMemeUniverse,
  analyzeMemeMarketData,
  buildMemeCoinSignal,
} from '../engine/meme'
import { recordMemeSignal } from '../engine/journal'
import type { MemeSignal } from '../engine/types'
import { loadMemeCoinAnalysis } from './loadMemeCoinAnalysis'
import { logger } from '../utils/logger'
import { useTelegramWebApp } from './useTelegramWebApp'

const SCAN_INTERVAL_MS = 22_000
const COIN_DELAY_MS = 120

export const useMemePulseScanner = () => {
  const updateMemeSignals = useAppStore((s) => s.updateMemeSignals)
  const setMemeUniverse = useAppStore((s) => s.setMemeUniverse)
  const upsertSignal = useAppStore((s) => s.upsertSignal)
  const { haptic, showAlert } = useTelegramWebApp()

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMounted = useRef(true)
  const alertedRef = useRef<Set<string>>(new Set())
  const offsetRef = useRef(0)
  /** Rolling cache: не теряем монеты между батчами round-robin */
  const cacheRef = useRef<Map<string, MemeSignal>>(new Map())
  const scannedSymbolsRef = useRef<Set<string>>(new Set())
  const rotationIdRef = useRef(0)

  const scanMemeDeep = useCallback(
    async (
      internalSymbol: string,
      tickerPrice: number,
      priceChange24h: number,
      fundingRate?: number,
      openInterest?: number
    ): Promise<MemeSignal | null> => {
      try {
        const ohlcv1m = await fetchOhlcv(internalSymbol, '1m', 180)
        if (!ohlcv1m.length || !isMounted.current) return null

        await new Promise((resolve) => setTimeout(resolve, COIN_DELAY_MS))

        const depth = await fetchDepth(internalSymbol, 20)
        if (!isMounted.current) return null

        await new Promise((resolve) => setTimeout(resolve, COIN_DELAY_MS))

        const trades = await fetchRecentTrades(internalSymbol, 100)
        const currentPrice = ohlcv1m[ohlcv1m.length - 1][4] || tickerPrice

        let ohlcv5m = null
        try {
          ohlcv5m = await fetchOhlcv(internalSymbol, '5m', 60)
        } catch {
          /* optional */
        }

        const signal = analyzeMemeMarketData(
          internalSymbol,
          toDisplayName(internalSymbol),
          toFlatSymbol(internalSymbol),
          currentPrice,
          priceChange24h,
          ohlcv1m,
          depth,
          trades,
          { fundingRate, openInterest, ohlcv5m }
        )

        if (
          signal.criticalAlert &&
          !alertedRef.current.has(`${internalSymbol}:${signal.setupTag}`)
        ) {
          alertedRef.current.add(`${internalSymbol}:${signal.setupTag}`)
          haptic.notification('warning')
          showAlert(
            `${signal.criticalAlert}\n${signal.displayName}\nHeat: ${signal.heatScore}/100`
          )
        } else if (
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

  const publishCache = useCallback(
    (universeSymbols: Set<string>) => {
      const now = Date.now()
      for (const [sym, sig] of cacheRef.current) {
        if (now - sig.updatedAt > MEME_SIGNAL_TTL_MS) {
          cacheRef.current.delete(sym)
          continue
        }
        if (!universeSymbols.has(sig.internalSymbol)) {
          cacheRef.current.delete(sym)
        }
      }

      const merged = Array.from(cacheRef.current.values()).sort((a, b) => {
        const qualityOrder = { CRITICAL: 0, STRONG: 1, MODERATE: 2, WEAK: 3 }
        if (a.quality !== b.quality) {
          return qualityOrder[a.quality] - qualityOrder[b.quality]
        }
        return b.heatScore - a.heatScore
      })

      const top = merged.slice(0, TOP_MEME_COUNT)
      updateMemeSignals(top)

      const marketContext = useAppStore.getState().marketContext
      for (const meme of top.slice(0, 15)) {
        const coinSignal = buildMemeCoinSignal(meme, marketContext)
        upsertSignal(coinSignal)
      }

      return top
    },
    [updateMemeSignals, upsertSignal]
  )

  const scanAll = useCallback(async () => {
    try {
      const allTickers = await fetchTickers()
      if (!isMounted.current) return

      const memeTickers = filterMemeTickers(allTickers)
      const stats = summarizeMemeUniverse(allTickers)
      const universeSymbols = new Set(memeTickers.map((t) => t.symbol))

      // Новый полный оборот — сбрасываем покрытие
      if (offsetRef.current === 0) {
        rotationIdRef.current += 1
        scannedSymbolsRef.current = new Set()
      }

      const { batch, nextOffset } = prioritizeMemeBatch(
        memeTickers,
        offsetRef.current,
        MEME_BATCH_SIZE
      )
      offsetRef.current = nextOffset

      for (const t of batch) {
        if (!isMounted.current) break
        scannedSymbolsRef.current.add(t.symbol)
        const signal = await scanMemeDeep(
          t.symbol,
          t.lastPrice,
          t.priceChangePercent,
          t.fundingRate,
          t.openInterest
        )
        if (signal) {
          cacheRef.current.set(signal.symbol, signal)
        }
        await new Promise((resolve) => setTimeout(resolve, COIN_DELAY_MS))
      }

      if (!isMounted.current) return

      const top = publishCache(universeSymbols)

      // Журнал: логируем сильные мем-сигналы для статистики отработок
      const marketContext = useAppStore.getState().marketContext
      for (const meme of top) {
        if (meme.heatScore < 55) continue
        const coin = buildMemeCoinSignal(meme, marketContext)
        if (!coin.direction || coin.sl == null || coin.tp1 == null) continue
        recordMemeSignal(
          meme,
          {
            direction: coin.direction,
            sl: coin.sl,
            tp1: coin.tp1,
            tp2: coin.tp2,
          },
          Math.max(meme.heatScore, coin.styleConfidence ?? coin.probabilityPct)
        )
      }
      useAppStore.getState().bumpJournalVersion()

      setMemeUniverse({
        totalTickers: stats.totalTickers,
        memeCount: stats.memeCount,
        scannedCount: scannedSymbolsRef.current.size,
        batchSize: batch.length,
        rotation: rotationIdRef.current,
        lastScanAt: Date.now(),
        rejectedLowVolume: stats.rejected.low_volume,
        rejectedBlueChip: stats.rejected.blue_chip,
      })

      // Полный SMC только для самых горячих из кэша
      for (const meme of top.slice(0, 3)) {
        if (!isMounted.current) break
        await loadMemeCoinAnalysis(meme)
        await new Promise((resolve) => setTimeout(resolve, 250))
      }

      logger.info(
        `[MemePulse] universe=${stats.memeCount} scanned=${scannedSymbolsRef.current.size}/${stats.memeCount} batch=${batch.length} radar=${top.length}`
      )
    } catch (err) {
      logger.warn('MemePulse scan failed', err)
    }
  }, [scanMemeDeep, publishCache, setMemeUniverse])

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
