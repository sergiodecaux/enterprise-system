import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, Plus, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CORE_WATCHLIST,
  fetchOhlcv,
  fetchTickers,
  filterTickersByQuery,
  sleep,
  toDisplayName,
  toFlatSymbol,
  type MexcTicker,
} from '../../api/mexc'
import { useAppStore } from '../../store/useAppStore'
import { analyzeSymbol } from '../../engine/ProbabilityEngine'
import { resolveDailyBias, detectMarketStructure } from '../../engine/smc'
import { logger } from '../../utils/logger'

const BTC = 'BTC/USDT:USDT'

const CoinSearch = () => {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<MexcTicker[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const extraWatchlist = useAppStore((s) => s.extraWatchlist)
  const addToWatchlist = useAppStore((s) => s.addToWatchlist)
  const upsertSignal = useAppStore((s) => s.upsertSignal)
  const updateTicker = useAppStore((s) => s.updateTicker)
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const marketContext = useAppStore((s) => s.marketContext)

  const known = useMemo(() => {
    return new Set<string>([...CORE_WATCHLIST, ...extraWatchlist])
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
      addToWatchlist(ticker.symbol)

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
      const [c1d, c4h, c1h, c15m] = await Promise.all([
        marketContext?.dailyAnalysis
          ? Promise.resolve(null)
          : fetchOhlcv(BTC, '1d', 60),
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

      if (c1d) {
        dailyBias = resolveDailyBias(c1d)
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

      const { signal } = analyzeSymbol({
        internalSymbol: ticker.symbol,
        ohlcv4h: c4h,
        ohlcv1h: c1h,
        ohlcv15m: c15m,
        priceChange24h: ticker.priceChangePercent,
        dailyBias,
        btcTrend,
      })

      upsertSignal(signal)
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
    <div ref={wrapRef} className="relative px-4 pb-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-holo/40" />
        <input
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
          className="w-full bg-hull border border-hull-border rounded-lg pl-10 pr-10 py-2.5 text-sm font-mono text-holo placeholder:text-holo/30 focus:outline-none focus:border-matrix/50"
        />
        {query && (
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-holo/40 hover:text-holo"
            onClick={() => {
              setQuery('')
              setOpen(false)
            }}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {open && query.trim().length > 0 && (
        <div className="absolute left-4 right-4 z-30 mt-1 bg-hull border border-hull-border rounded-lg shadow-xl max-h-64 overflow-y-auto">
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
            return (
              <button
                key={ticker.symbol}
                type="button"
                disabled={inList || !!adding}
                onClick={() => analyzeAndAdd(ticker)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-hull-light disabled:opacity-50 border-b border-hull-border/40 last:border-0"
              >
                <div>
                  <div className="text-sm font-mono font-bold text-holo">
                    {toDisplayName(ticker.symbol)}
                  </div>
                  <div className="text-xs font-mono text-holo/40">
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
                <div className="text-xs font-mono text-matrix flex items-center gap-1">
                  {isAdding ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : inList ? (
                    t('search_added')
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5" />
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
