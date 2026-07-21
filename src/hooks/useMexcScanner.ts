import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  CORE_WATCHLIST,
  fetchOhlcv,
  fetchTickers,
  sleep,
  toFlatSymbol,
} from '../api/mexc'
import {
  buildLiquidityMap,
  analyzePO3,
  calculateEma,
  detectMarketStructure,
  resolveDailyBias,
  type TrendDirection,
} from '../engine/smc'
import { analyzeSessionDNA } from '../engine/sessions/dnaAnalyzer'
import { analyzeSymbol, COOLDOWN_MS } from '../engine/ProbabilityEngine'
import type {
  CoinSignal,
  LiveTicker,
  LiquidityMap,
  MarketContext,
} from '../engine/types'
import { logger } from '../utils/logger'

const BTC = 'BTC/USDT:USDT'
const SCAN_PAUSE_MS = 120_000
const COIN_DELAY_MS = 300
const TICKER_POLL_MS = 5_000

/**
 * MEXC scanner — CORE_WATCHLIST + монеты из поиска (extraWatchlist).
 */
export const useMexcScanner = () => {
  const isMountedRef = useRef(true)
  const cooldownRef = useRef<Record<string, number>>({})
  const watchlistRef = useRef<string[]>([...CORE_WATCHLIST])
  const btc1hRef = useRef<import('../api/mexc').OhlcvCandle[]>([])

  const {
    updateTicker,
    updateSignals,
    setMarketContext,
    setScanning,
    setConnectionStatus,
    setLiquidityMap,
    setSessionDNA,
    setPO3Analysis,
  } = useAppStore()

  const syncWatchlist = useCallback(() => {
    const extra = useAppStore.getState().extraWatchlist
    const merged = Array.from(new Set<string>([...CORE_WATCHLIST, ...extra]))
    watchlistRef.current = merged
    return merged
  }, [])

  const refreshTickers = useCallback(async () => {
    try {
      const tickers = await fetchTickers()
      const watch = new Set(watchlistRef.current)
      let updated = 0
      for (const t of tickers) {
        if (!watch.has(t.symbol)) continue
        const live: LiveTicker = {
          symbol: toFlatSymbol(t.symbol),
          price: t.lastPrice,
          priceChange24h: t.priceChangePercent,
          volume24h: t.volume24h,
          high24h: t.high24h,
          low24h: t.low24h,
          timestamp: t.timestamp,
        }
        updateTicker(live)
        updated++
      }
      if (updated > 0) {
        setConnectionStatus('POLLING')
      }
    } catch (err) {
      logger.warn('Ticker poll failed', err)
      setConnectionStatus('OFFLINE')
    }
  }, [updateTicker, setConnectionStatus])

  const runScanCycle = useCallback(async () => {
    setScanning(true)
    syncWatchlist()

    try {
      // 0. Daily bias BTC 1D
      const candles1d = await fetchOhlcv(BTC, '1d', 60)
      const dailyBias = resolveDailyBias(candles1d)

      if (dailyBias.direction === 'NO_TRADE') {
        setMarketContext({
          dailyDirection: dailyBias.direction,
          dailyBias: dailyBias.bias,
          dailyConfidence: dailyBias.confidence,
          dailyPattern: dailyBias.dailyAnalysis?.pattern ?? '',
          dailyDetails: dailyBias.dailyAnalysis?.details ?? '',
          dailyAnalysis: dailyBias.dailyAnalysis,
          dailyLevels: dailyBias.dailyLevels,
          btcTrend: 'RANGING',
          emaConfirms: false,
          lastScanAt: Date.now(),
          watchlistSize: watchlistRef.current.length,
          scanProgress: 'Нет торговли — низкая уверенность дня',
        })
        logger.info('Daily bias NO_TRADE — skipping coin scan')
        return
      }

      await sleep(COIN_DELAY_MS)

      // 1. BTC structure 4H + EMA200 1H
      const btc4h = await fetchOhlcv(BTC, '4h', 100)
      await sleep(COIN_DELAY_MS)
      const btc1h = await fetchOhlcv(BTC, '1h', 300)
      // Сохраняем в ref чтобы передать в analyzeSymbol каждой монеты
      btc1hRef.current = btc1h

      const btcStructure = detectMarketStructure(btc4h, 50)
      const btcTrend: TrendDirection = btcStructure.trend
      const btcCloses1h = btc1h.map((c) => c[4])
      const btcEma200 = calculateEma(btcCloses1h, 200)
      const currentBtc = btcCloses1h[btcCloses1h.length - 1]
      let emaConfirms = false
      if (btcTrend === 'BULLISH' && btcEma200 && currentBtc > btcEma200) emaConfirms = true
      if (btcTrend === 'BEARISH' && btcEma200 && currentBtc < btcEma200) emaConfirms = true

      const ctxBase: Omit<MarketContext, 'scanProgress'> = {
        dailyDirection: dailyBias.direction,
        dailyBias: dailyBias.bias,
        dailyConfidence: dailyBias.confidence,
        dailyPattern: dailyBias.dailyAnalysis?.pattern ?? '',
        dailyDetails: dailyBias.dailyAnalysis?.details ?? '',
        dailyAnalysis: dailyBias.dailyAnalysis,
        dailyLevels: dailyBias.dailyLevels,
        btcTrend,
        emaConfirms,
        lastScanAt: Date.now(),
        watchlistSize: watchlistRef.current.length,
      }

      setMarketContext({ ...ctxBase, scanProgress: 'Сканирование...' })
      setConnectionStatus('POLLING')

      // Price map for 24h change
      const tickerMap = new Map<string, number>()
      try {
        const allTickers = await fetchTickers()
        for (const t of allTickers) {
          tickerMap.set(t.symbol, t.priceChangePercent)
          if (watchlistRef.current.includes(t.symbol)) {
            updateTicker({
              symbol: toFlatSymbol(t.symbol),
              price: t.lastPrice,
              priceChange24h: t.priceChangePercent,
              volume24h: t.volume24h,
              high24h: t.high24h,
              low24h: t.low24h,
              timestamp: t.timestamp,
            })
          }
        }
      } catch {
        /* non-fatal */
      }

      const results: CoinSignal[] = []
      const now = Date.now()

      for (let i = 0; i < watchlistRef.current.length; i++) {
        if (!isMountedRef.current) break
        const symbol = watchlistRef.current[i]

        setMarketContext({
          ...ctxBase,
          scanProgress: `${i + 1}/${watchlistRef.current.length} ${symbol}`,
        })

        const lastCd = cooldownRef.current[symbol] ?? 0
        const onCooldown = now - lastCd < COOLDOWN_MS

        try {
          await sleep(COIN_DELAY_MS)
          const ohlcv4h = await fetchOhlcv(symbol, '4h', 100)
          await sleep(200)
          const ohlcv1d = await fetchOhlcv(symbol, '1d', 120)
          await sleep(150)
          const ohlcv1h = await fetchOhlcv(symbol, '1h', 720)
          await sleep(200)
          const ohlcv15m = await fetchOhlcv(symbol, '15m', 50)
          await sleep(150)
          const ohlcv5m = await fetchOhlcv(symbol, '5m', 120)
          await sleep(150)
          const ohlcv1m = await fetchOhlcv(symbol, '1m', 100)

          const baseSym = symbol.split('/')[0]
          const newsBoost =
            useAppStore.getState().newsSettings.scoreInfluence
              ? useAppStore.getState().newsIntel.coinSentiments[baseSym]
                  ?.scoreBoost
              : undefined

          const currentPrice1h = ohlcv1h[ohlcv1h.length - 1]?.[4] ?? 0
          let liquidityMap: LiquidityMap | undefined
          try {
            if (ohlcv1h.length >= 30 && currentPrice1h > 0) {
              liquidityMap = buildLiquidityMap(
                ohlcv1h,
                currentPrice1h,
                symbol,
                '1h'
              )
            }
          } catch (liqErr) {
            logger.warn(`LiquidityMap error ${symbol}`, liqErr)
          }

          if (liquidityMap) {
            setLiquidityMap(symbol, liquidityMap)
          }

          // ── Session DNA ──────────────────────────────────────────────────
          try {
            if (ohlcv1h.length >= 200) {
              const dna = analyzeSessionDNA(ohlcv1h, symbol)
              setSessionDNA(symbol, dna)
            }
          } catch (dnaErr) {
            logger.warn(`SessionDNA error ${symbol}`, dnaErr)
          }

          // ── PO3 Analysis ─────────────────────────────────────────────────
          try {
            if (ohlcv1h.length >= 24 && currentPrice1h > 0) {
              const po3 = analyzePO3(ohlcv1h, currentPrice1h)
              setPO3Analysis(symbol, po3)
            }
          } catch (po3Err) {
            logger.warn(`PO3 error ${symbol}`, po3Err)
          }

          const { signal, triggered } = analyzeSymbol({
            internalSymbol: symbol,
            ohlcv4h,
            ohlcv1h,
            ohlcv15m,
            ohlcv1d: ohlcv1d.length >= 20 ? ohlcv1d : undefined,
            priceChange24h: tickerMap.get(symbol) ?? 0,
            dailyBias,
            btcTrend,
            newsSentimentBoost: newsBoost,
            liquidityMap,
            btcOhlcv1h:
              btc1hRef.current.length > 25 ? btc1hRef.current : undefined,
            ohlcv5m: ohlcv5m.length >= 15 ? ohlcv5m : undefined,
            ohlcv1m: ohlcv1m.length >= 20 ? ohlcv1m : undefined,
          })

          // Respect cooldown for triggered setups (still show soft rows)
          if (triggered && !onCooldown) {
            cooldownRef.current[symbol] = Date.now()
            logger.info(`Signal ${signal.direction} ${symbol} score=${signal.score}`)
          } else if (triggered && onCooldown) {
            signal.hasActiveSetup = false
          }

          results.push(signal)

          updateTicker({
            symbol: signal.symbol,
            price: signal.price,
            priceChange24h: signal.priceChange24h,
            volume24h: 0,
            high24h: signal.price,
            low24h: signal.price,
            timestamp: Date.now(),
          })
        } catch (err) {
          logger.warn(`Scan error ${symbol}`, err)
        }
      }

      // Sort: active setups first, then by probability
      results.sort((a, b) => {
        if (a.hasActiveSetup !== b.hasActiveSetup) return a.hasActiveSetup ? -1 : 1
        return b.probabilityPct - a.probabilityPct
      })

      updateSignals(results)
      setMarketContext({
        ...ctxBase,
        lastScanAt: Date.now(),
        scanProgress: `Готово — ${results.filter((r) => r.hasActiveSetup).length} сетапов`,
      })
      setConnectionStatus('POLLING')
    } catch (err) {
      logger.error('Scan cycle failed', err)
      setConnectionStatus('OFFLINE')
    } finally {
      setScanning(false)
    }
  }, [
    setScanning,
    setMarketContext,
    setConnectionStatus,
    updateSignals,
    updateTicker,
    syncWatchlist,
    setLiquidityMap,
    setSessionDNA,
    setPO3Analysis,
  ])

  useEffect(() => {
    isMountedRef.current = true
    let cancelled = false

    const boot = async () => {
      syncWatchlist()
      await refreshTickers()
      if (cancelled) return

      while (isMountedRef.current && !cancelled) {
        await runScanCycle()
        if (cancelled || !isMountedRef.current) break
        for (let s = 0; s < SCAN_PAUSE_MS / 1000; s++) {
          if (!isMountedRef.current || cancelled) break
          await sleep(1000)
        }
      }
    }

    boot()

    const tickerInterval = setInterval(() => {
      if (isMountedRef.current) {
        syncWatchlist()
        refreshTickers()
      }
    }, TICKER_POLL_MS)

    // When user adds a coin via search — include it ASAP on next ticker poll
    const unsub = useAppStore.subscribe(
      (s) => s.extraWatchlist,
      () => {
        syncWatchlist()
      }
    )

    return () => {
      cancelled = true
      isMountedRef.current = false
      clearInterval(tickerInterval)
      unsub()
    }
  }, [refreshTickers, runScanCycle, syncWatchlist])

  return {
    isScanning: useAppStore((s) => s.isScanning),
  }
}
