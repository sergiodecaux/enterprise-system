import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, Plus, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  PINNED_WATCHLIST,
  fetchOhlcv,
  fetchTickers,
  filterTickersByQuery,
  sleep,
  toDisplayName,
  toFlatSymbol,
  toRadarLabel,
  type MexcTicker,
} from '../../api/mexc'
import { useAppStore } from '../../store/useAppStore'
import { MAX_RADAR_FAVORITES } from '../../engine/telegram/types'
import { analyzeSymbol } from '../../engine/ProbabilityEngine'
import { resolveDailyBias, detectMarketStructure } from '../../engine/smc'
import { logger } from '../../utils/logger'
import { buildMarketContextBoost, pushSignalSnapshot } from '../../engine/analysis'
import {
  getCachedWorkerMarketContext,
  loadWorkerMarketContext,
} from '../../hooks/useWorkerMarketContext'

const BTC = 'BTC/USDT:USDT'

interface CoinSearchProps {
  /** Внешние отступы; по умолчанию — мобильный вариант. */
  className?: string
  /** id поля, чтобы на него можно было повесить горячую клавишу. */
  inputId?: string
}

const CoinSearch = ({ className = 'px-4 pb-3', inputId }: CoinSearchProps) => {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<MexcTicker[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const extraWatchlist = useAppStore((s) => s.extraWatchlist)
  const addToWatchlist = useAppStore((s) => s.addToWatchlist)
  const toggleRadarFavorite = useAppStore((s) => s.toggleRadarFavorite)
  const radarFavorites = useAppStore((s) => s.radarFavorites)
  const upsertSignal = useAppStore((s) => s.upsertSignal)
  const updateTicker = useAppStore((s) => s.updateTicker)
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const marketContext = useAppStore((s) => s.marketContext)

  const known = useMemo(() => {
    return new Set<string>([...PINNED_WATCHLIST, ...extraWatchlist])
  }, [extraWatchlist])

  const results = useMemo(() => {
    if (query.trim().length < 1) return []
    return filterTickersByQuery(catalog, query, 10)
  }, [catalog, query])

  const loadCatalog = useCallback(async () => {
    if (catalog.length > 0) return
    setCatalogLoading(true)
    try {
      const tickers = await fetchTickers()
      setCatalog(tickers)
    } catch (err) {
      logger.warn('Coin search catalog failed', err)
    } finally {
      setCatalogLoading(false)
    }
  }, [catalog.length])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const analyzeAndAdd = async (ticker: MexcTicker) => {
    if (known.has(ticker.symbol) || adding) return
    setAdding(ticker.symbol)
    try {
      void loadWorkerMarketContext()
      addToWatchlist(ticker.symbol)
      if (
        !radarFavorites.includes(ticker.symbol) &&
        radarFavorites.length < MAX_RADAR_FAVORITES
      ) {
        toggleRadarFavorite(ticker.symbol)
      }

      updateTicker({
        symbol: toFlatSymbol(ticker.symbol),
        price: ticker.lastPrice,
        priceChange24h: ticker.priceChangePercent,
        volume24h: ticker.volume24h,
        high24h: ticker.high24h,
        low24h: ticker.low24h,
        timestamp: ticker.timestamp,
      })

      // One-shot SMC analysis so coin appears immediately
      const [btc1d, coin1d, c4h, c1h, c15m] = await Promise.all([
        marketContext?.dailyAnalysis
          ? Promise.resolve(null)
          : fetchOhlcv(BTC, '1d', 60),
        fetchOhlcv(ticker.symbol, '1d', 120),
        fetchOhlcv(ticker.symbol, '4h', 100),
        fetchOhlcv(ticker.symbol, '1h', 100),
        fetchOhlcv(ticker.symbol, '15m', 50),
      ])
      await sleep(50)

      let dailyBias = {
        direction: marketContext?.dailyDirection ?? ('BOTH' as const),
        confidence: marketContext?.dailyConfidence ?? 50,
        bias: (marketContext?.dailyBias as 'BULLISH' | 'BEARISH' | 'NEUTRAL') ?? 'NEUTRAL',
        dailyAnalysis: marketContext?.dailyAnalysis ?? null,
        dailyLevels: marketContext?.dailyLevels ?? null,
      }

      if (btc1d) {
        dailyBias = resolveDailyBias(btc1d)
      }

      let btcTrend = marketContext?.btcTrend ?? 'RANGING'
      if (!marketContext?.btcTrend) {
        try {
          const btc4h = await fetchOhlcv(BTC, '4h', 100)
          btcTrend = detectMarketStructure(btc4h, 50).trend
        } catch {
          /* keep */
        }
      }

      const baseSym = ticker.symbol.split('/')[0]
      const localNews =
        useAppStore.getState().newsSettings.scoreInfluence
          ? useAppStore.getState().newsIntel.coinSentiments[baseSym]?.scoreBoost
          : undefined
      const sideHint =
        dailyBias.bias === 'BULLISH'
          ? 'LONG'
          : dailyBias.bias === 'BEARISH'
            ? 'SHORT'
            : null
      const ctxBoost = buildMarketContextBoost({
        internalSymbol: ticker.symbol,
        side: sideHint,
        workerCtx: getCachedWorkerMarketContext(),
        localNewsBoost: localNews,
      })

      const { signal } = analyzeSymbol({
        internalSymbol: ticker.symbol,
        ohlcv4h: c4h,
        ohlcv1h: c1h,
        ohlcv15m: c15m,
        ohlcv1d: coin1d.length >= 20 ? coin1d : undefined,
        priceChange24h: ticker.priceChangePercent,
        dailyBias,
        btcTrend,
        newsSentimentBoost: ctxBoost.newsSentimentBoost || undefined,
        marketCtxBoost: ctxBoost.marketCtxBoost || undefined,
        marketCtxNotes: ctxBoost.notes.length ? ctxBoost.notes : undefined,
      })

      upsertSignal(signal)
      pushSignalSnapshot(signal)
      setQuery('')
      setOpen(false)
      selectCoin(signal.symbol)
      setDrawerOpen(true)
    } catch (err) {
      logger.warn('Add coin failed', err)
    } finally {
      setAdding(null)
    }
  }

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-holo/35" />
        <input
          id={inputId}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setOpen(true)
            loadCatalog()
          }}
          placeholder={t('search_placeholder')}
          className="w-full rounded-xl border border-hull-border/90 bg-black/25 py-2.5 pl-9 pr-16 font-sans text-[13px] text-holo placeholder:text-holo/30 transition-colors focus:border-matrix/50 focus:bg-black/35 focus:outline-none"
        />
        {!query && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 items-center rounded-md border border-hull-border/80 bg-hull/70 px-1.5 py-0.5 font-mono text-[9px] text-holo/30 sm:flex">
            Ctrl K
          </span>
        )}
        {query && (
          <button
            type="button"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-holo/40 hover:text-holo"
            onClick={() => {
              setQuery('')
              setOpen(false)
            }}
            aria-label="Очистить поиск"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && query.trim().length > 0 && (
        <div className="absolute inset-x-0 top-full z-40 mt-1.5 max-h-72 overflow-y-auto rounded-xl border border-hull-border bg-hull shadow-panel">
          {catalogLoading && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-holo/50 font-mono">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t('search_loading')}
            </div>
          )}

          {!catalogLoading && results.length === 0 && (
            <div className="px-3 py-3 text-xs text-holo/50 font-mono">
              {t('search_empty')}
            </div>
          )}

          {results.map((ticker) => {
            const inList = known.has(ticker.symbol)
            const isAdding = adding === ticker.symbol
            const label = toRadarLabel(ticker.symbol)
            return (
              <button
                key={ticker.symbol}
                type="button"
                disabled={inList || !!adding}
                onClick={() => analyzeAndAdd(ticker)}
                className="flex w-full items-center justify-between border-b border-hull-border/40 px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-hull-light/60 disabled:opacity-50"
              >
                <div>
                  <div className="font-mono text-[13px] font-semibold text-holo">
                    {toDisplayName(ticker.symbol)}
                    {label.hint !== 'USDT' && (
                      <span className="ml-1.5 font-sans text-[10px] font-normal text-holo/40">
                        {label.hint}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-holo/40">
                    ${ticker.lastPrice.toLocaleString('ru-RU')} ·{' '}
                    <span
                      className={
                        ticker.priceChangePercent >= 0 ? 'text-matrix' : 'text-alert'
                      }
                    >
                      {ticker.priceChangePercent >= 0 ? '+' : ''}
                      {ticker.priceChangePercent.toFixed(2)}%
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 font-sans text-[11px] font-semibold text-matrix">
                  {isAdding ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : inList ? (
                    <span className="text-holo/35">{t('search_added')}</span>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" />
                      {t('search_add')}
                    </>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default CoinSearch
