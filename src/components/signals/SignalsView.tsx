import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  Loader2,
  X,
  TrendingUp,
  TrendingDown,
  Zap,
  AlertTriangle,
  Eye,
  Send,
  Check,
} from 'lucide-react'
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
import {
  fetchWorkerMarketContext,
  type WorkerMarketContext,
} from '../../api/marketContext'
import {
  createWatchedSetup,
  isTelegramAlertsConfigured,
} from '../../api/telegram/alerts'
import { analyzeSymbol } from '../../engine/ProbabilityEngine'
import { resolveDailyBias, detectMarketStructure } from '../../engine/smc'
import {
  buildDirectedSignal,
  coinBaseFromInternal,
  type DirectedSignalResult,
  type SignalSide,
} from '../../engine/signals/buildDirectedSignal'
import type { ConditionalSetup } from '../../engine/setups'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { logger } from '../../utils/logger'

const BTC = 'BTC/USDT:USDT'

function fmtPx(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

function toneClass(tone: 'ok' | 'warn' | 'bad' | 'neutral'): string {
  if (tone === 'ok') return 'text-matrix border-matrix/30 bg-matrix/5'
  if (tone === 'warn') return 'text-amber-300/90 border-amber-400/30 bg-amber-500/5'
  if (tone === 'bad') return 'text-alert border-alert/30 bg-alert/5'
  return 'text-holo/70 border-hull-border bg-hull/40'
}

const SignalsView = () => {
  const { userId, haptic, showAlert } = useTelegramWebApp()

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<MexcTicker[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [selected, setSelected] = useState<MexcTicker | null>(null)
  const [sideBusy, setSideBusy] = useState<SignalSide | null>(null)
  const [result, setResult] = useState<DirectedSignalResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [workerCtx, setWorkerCtx] = useState<WorkerMarketContext | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [watchBusy, setWatchBusy] = useState(false)
  const [watchedOk, setWatchedOk] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const marketContext = useAppStore((s) => s.marketContext)
  const newsIntel = useAppStore((s) => s.newsIntel)
  const liquidityMaps = useAppStore((s) => s.liquidityMaps)
  const mmIntentMap = useAppStore((s) => s.mmIntent)
  const signals = useAppStore((s) => s.signals)
  const upsertSignal = useAppStore((s) => s.upsertSignal)
  const updateTicker = useAppStore((s) => s.updateTicker)
  const addToWatchlist = useAppStore((s) => s.addToWatchlist)
  const upsertWatchedSetup = useAppStore((s) => s.upsertWatchedSetup)
  const telegramSettings = useAppStore((s) => s.telegramAlertSettings)
  const extraWatchlist = useAppStore((s) => s.extraWatchlist)

  const results = useMemo(() => {
    if (query.trim().length < 1) return []
    return filterTickersByQuery(catalog, query, 10)
  }, [catalog, query])

  useEffect(() => {
    let cancelled = false
    fetchWorkerMarketContext().then((ctx) => {
      if (!cancelled && ctx) setWorkerCtx(ctx)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const loadCatalog = useCallback(async () => {
    if (catalog.length > 0) return
    setCatalogLoading(true)
    try {
      setCatalog(await fetchTickers())
    } catch (err) {
      logger.warn('Signals catalog failed', err)
    } finally {
      setCatalogLoading(false)
    }
  }, [catalog.length])

  const resolveChatId = useCallback((): number | null => {
    if (userId) return userId
    const manual = telegramSettings.manualChatId.trim()
    if (manual && /^-?\d+$/.test(manual)) return Number(manual)
    if (telegramSettings.subscribedChatId) return telegramSettings.subscribedChatId
    return null
  }, [userId, telegramSettings])

  const pickCoin = (ticker: MexcTicker) => {
    setSelected(ticker)
    setQuery(toDisplayName(ticker.symbol))
    setOpen(false)
    setResult(null)
    setError(null)
    setWatchedOk(false)
    setConfirmOpen(false)
  }

  const runSide = async (side: SignalSide) => {
    if (!selected || sideBusy) return
    setSideBusy(side)
    setError(null)
    setResult(null)
    setWatchedOk(false)
    setConfirmOpen(false)

    try {
      const symbol = selected.symbol
      const flat = toFlatSymbol(symbol)
      updateTicker({
        symbol: flat,
        price: selected.lastPrice,
        priceChange24h: selected.priceChangePercent,
        volume24h: selected.volume24h,
        high24h: selected.high24h,
        low24h: selected.low24h,
        timestamp: selected.timestamp,
      })
      if (
        !(CORE_WATCHLIST as readonly string[]).includes(symbol) &&
        !extraWatchlist.includes(symbol)
      ) {
        addToWatchlist(symbol)
      }

      const existing = signals.find((s) => s.internalSymbol === symbol)

      const [btc1d, coin1d, c4h, c1h, c15m] = await Promise.all([
        marketContext?.dailyAnalysis
          ? Promise.resolve(null)
          : fetchOhlcv(BTC, '1d', 60),
        fetchOhlcv(symbol, '1d', 120),
        fetchOhlcv(symbol, '4h', 100),
        fetchOhlcv(symbol, '1h', 100),
        fetchOhlcv(symbol, '15m', 80),
      ])
      await sleep(40)

      let dailyBias = {
        direction: marketContext?.dailyDirection ?? ('BOTH' as const),
        confidence: marketContext?.dailyConfidence ?? 50,
        bias:
          (marketContext?.dailyBias as 'BULLISH' | 'BEARISH' | 'NEUTRAL') ??
          'NEUTRAL',
        dailyAnalysis: marketContext?.dailyAnalysis ?? null,
        dailyLevels: marketContext?.dailyLevels ?? null,
      }
      if (btc1d) dailyBias = resolveDailyBias(btc1d)

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
        internalSymbol: symbol,
        ohlcv4h: c4h,
        ohlcv1h: c1h,
        ohlcv15m: c15m,
        ohlcv1d: coin1d.length >= 20 ? coin1d : undefined,
        priceChange24h: selected.priceChangePercent,
        dailyBias,
        btcTrend,
        mmIntent: mmIntentMap[symbol] ?? existing?.mmIntent ?? null,
      })
      upsertSignal(signal)

      const price = selected.lastPrice > 0 ? selected.lastPrice : signal.price
      const base = coinBaseFromInternal(symbol)
      const coinNews = workerCtx?.coinNews?.[base]
      const coinSent = newsIntel.coinSentiments[base]

      const directed = buildDirectedSignal({
        side,
        candles: c15m.length >= 20 ? c15m : c1h,
        candles1d: coin1d,
        candles1h: c1h,
        symbol,
        flatSymbol: flat,
        price,
        signal,
        mmIntent: mmIntentMap[symbol] ?? signal.mmIntent ?? null,
        liquidityMap: liquidityMaps[symbol] ?? null,
        fearGreed: workerCtx?.fearGreed ?? newsIntel.fearGreed?.value ?? null,
        fearGreedLabel:
          workerCtx?.fearGreedLabel ?? newsIntel.fearGreed?.label ?? null,
        btcDominance: workerCtx?.btcDominance ?? null,
        newsLabel: workerCtx?.newsLabel ?? null,
        newsHeadlines: workerCtx?.newsHeadlines,
        coinNewsLabel: coinNews?.label ?? coinSent?.label ?? null,
        coinNewsHeadlines:
          coinNews?.headlines ??
          coinSent?.items?.slice(0, 3).map((i) => i.title),
        dailyBias: dailyBias.bias,
        btcTrend,
        tradeStyle: 'INTRADAY',
      })

      setResult(directed)
      haptic.success()
    } catch (err) {
      logger.warn('Signals analyze failed', err)
      setError('Не удалось проанализировать монету — попробуйте ещё раз')
      haptic.error()
    } finally {
      setSideBusy(null)
    }
  }

  const handleConfirmWatch = async () => {
    if (!result?.bestSetup || !selected) {
      showAlert('Нет готового сетапа для слежения — зона слишком слабая')
      return
    }
    const chatId = resolveChatId()
    if (!chatId) {
      showAlert('Сначала подпишитесь на Telegram-алерты (колокольчик)')
      return
    }

    const setup: ConditionalSetup = {
      ...result.bestSetup,
      symbol: toFlatSymbol(selected.symbol),
      internalSymbol: selected.symbol,
    }

    setWatchBusy(true)
    try {
      if (!isTelegramAlertsConfigured()) {
        upsertWatchedSetup({
          watchId: `local_${setup.id}`,
          chatId,
          symbol: toFlatSymbol(selected.symbol),
          internalSymbol: selected.symbol,
          setup,
          createdAt: Date.now(),
          expiresAt: Date.now() + 48 * 3600_000,
          lastStatus: setup.status,
          readyNotified: false,
          invalidatedNotified: false,
          updatedAt: Date.now(),
        })
        setWatchedOk(true)
        setConfirmOpen(false)
        showAlert('Watch сохранён локально (прокси не настроен)')
        return
      }

      const watch = await createWatchedSetup({
        chatId,
        setup,
        symbol: toFlatSymbol(selected.symbol),
        internalSymbol: selected.symbol,
        ttlHours: 48,
      })
      if (watch) {
        upsertWatchedSetup(watch)
        setWatchedOk(true)
        setConfirmOpen(false)
        haptic.success()
        showAlert(
          `Бот следит за ${toDisplayName(selected.symbol)} ${setup.side} — алерт при READY`
        )
      } else {
        upsertWatchedSetup({
          watchId: `local_${setup.id}`,
          chatId,
          symbol: toFlatSymbol(selected.symbol),
          internalSymbol: selected.symbol,
          setup,
          createdAt: Date.now(),
          expiresAt: Date.now() + 48 * 3600_000,
          lastStatus: setup.status,
          readyNotified: false,
          invalidatedNotified: false,
          updatedAt: Date.now(),
        })
        setWatchedOk(true)
        setConfirmOpen(false)
        showAlert('Worker недоступен — watch только локально')
      }
    } finally {
      setWatchBusy(false)
    }
  }

  const zone = result?.catchZone
  const setup = result?.bestSetup

  return (
    <div className="flex min-h-screen flex-col bg-space pb-8">
      <div className="border-b border-hull-border px-4 py-4">
        <div className="mb-1 flex items-center gap-2">
          <Zap className="h-5 w-5 text-amber-300" />
          <h1 className="font-mono text-xl font-bold uppercase tracking-tight text-holo">
            Сигналы
          </h1>
        </div>
        <p className="font-mono text-[11px] text-holo/45">
          Монета → LONG/SHORT → зона ловли → оценка → оповещение в бота
        </p>
      </div>

      {/* Market strip */}
      <div className="grid grid-cols-3 gap-2 border-b border-hull-border px-4 py-3">
        <div className="rounded-lg border border-hull-border bg-hull/50 px-2 py-2 text-center">
          <div className="font-mono text-[9px] uppercase text-holo/40">BTC.D</div>
          <div className="font-mono text-sm font-bold text-holo">
            {workerCtx?.btcDominance != null
              ? `${workerCtx.btcDominance.toFixed(1)}%`
              : '—'}
          </div>
        </div>
        <div className="rounded-lg border border-hull-border bg-hull/50 px-2 py-2 text-center">
          <div className="font-mono text-[9px] uppercase text-holo/40">F&G</div>
          <div className="font-mono text-sm font-bold text-holo">
            {workerCtx?.fearGreed ?? newsIntel.fearGreed?.value ?? '—'}
          </div>
        </div>
        <div className="rounded-lg border border-hull-border bg-hull/50 px-2 py-2 text-center">
          <div className="font-mono text-[9px] uppercase text-holo/40">News</div>
          <div className="font-mono text-sm font-bold text-holo">
            {workerCtx?.newsLabel ?? '—'}
          </div>
        </div>
      </div>

      {/* Search */}
      <div ref={wrapRef} className="relative px-4 pt-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-holo/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
              if (selected && e.target.value !== toDisplayName(selected.symbol)) {
                setSelected(null)
                setResult(null)
              }
            }}
            onFocus={() => {
              setOpen(true)
              loadCatalog()
            }}
            placeholder="Найти монету (BTC, ETH, PEPE…)"
            className="w-full rounded-lg border border-hull-border bg-hull py-2.5 pl-10 pr-10 font-mono text-sm text-holo placeholder:text-holo/30 focus:border-amber-400/50 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-holo/40 hover:text-holo"
              onClick={() => {
                setQuery('')
                setSelected(null)
                setResult(null)
                setOpen(false)
              }}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {open && query.trim().length > 0 && (
          <div className="absolute left-4 right-4 z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-hull-border bg-hull shadow-xl">
            {catalogLoading && (
              <div className="flex items-center gap-2 px-3 py-3 font-mono text-xs text-holo/50">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Загрузка каталога…
              </div>
            )}
            {!catalogLoading && results.length === 0 && (
              <div className="px-3 py-3 font-mono text-xs text-holo/50">
                Ничего не найдено
              </div>
            )}
            {results.map((ticker) => (
              <button
                key={ticker.symbol}
                type="button"
                onClick={() => pickCoin(ticker)}
                className="flex w-full items-center justify-between border-b border-hull-border/40 px-3 py-2.5 text-left last:border-0 hover:bg-hull-light"
              >
                <div>
                  <div className="font-mono text-sm font-bold text-holo">
                    {toDisplayName(ticker.symbol)}
                  </div>
                  <div className="font-mono text-xs text-holo/40">
                    ${ticker.lastPrice.toLocaleString('ru-RU')} ·{' '}
                    <span
                      className={
                        ticker.priceChangePercent >= 0
                          ? 'text-matrix'
                          : 'text-alert'
                      }
                    >
                      {ticker.priceChangePercent >= 0 ? '+' : ''}
                      {ticker.priceChangePercent.toFixed(2)}%
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* LONG / SHORT */}
      <div className="grid grid-cols-2 gap-3 px-4 pt-4">
        <button
          type="button"
          disabled={!selected || !!sideBusy}
          onClick={() => runSide('LONG')}
          className="flex items-center justify-center gap-2 rounded-xl border border-matrix/40 bg-matrix/10 py-3.5 font-mono text-sm font-bold uppercase text-matrix transition-colors hover:bg-matrix/20 disabled:opacity-40"
        >
          {sideBusy === 'LONG' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <TrendingUp className="h-4 w-4" />
          )}
          Long
        </button>
        <button
          type="button"
          disabled={!selected || !!sideBusy}
          onClick={() => runSide('SHORT')}
          className="flex items-center justify-center gap-2 rounded-xl border border-alert/40 bg-alert/10 py-3.5 font-mono text-sm font-bold uppercase text-alert transition-colors hover:bg-alert/20 disabled:opacity-40"
        >
          {sideBusy === 'SHORT' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <TrendingDown className="h-4 w-4" />
          )}
          Short
        </button>
      </div>

      {!selected && (
        <p className="px-4 pt-3 font-mono text-[11px] text-holo/35">
          Выберите монету, затем нажмите Long или Short
        </p>
      )}

      {error && (
        <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-alert/40 bg-alert/10 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alert" />
          <span className="font-mono text-xs text-alert">{error}</span>
        </div>
      )}

      {/* Result */}
      {result && selected && (
        <div className="mx-4 mt-4 space-y-3">
          <div
            className={`rounded-xl border p-3 ${
              result.side === 'LONG'
                ? 'border-matrix/35 bg-matrix/[0.06]'
                : 'border-alert/35 bg-alert/[0.06]'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-sm font-bold text-holo">
                {toDisplayName(selected.symbol)} · {result.side}
              </div>
              <div
                className={`font-mono text-lg font-bold ${
                  result.side === 'LONG' ? 'text-matrix' : 'text-alert'
                }`}
              >
                ~{result.winPct}%
              </div>
            </div>
            <p className="mt-1 font-mono text-[10px] text-holo/40">
              Оценка вероятности (не исторический WR)
            </p>
            <p className="mt-2 font-mono text-xs leading-snug text-holo/80">
              {result.primary.title}
              {result.targetMovePct != null
                ? ` · цель ~${result.targetMovePct.toFixed(1)}%`
                : ''}
            </p>
            <p className="mt-1 font-mono text-[11px] leading-snug text-holo/55">
              {result.primary.summary}
            </p>
          </div>

          {/* Catch zone */}
          <div className="rounded-xl border border-amber-400/30 bg-amber-500/[0.05] p-3">
            <div className="font-mono text-[10px] font-bold uppercase tracking-wide text-amber-200/85">
              Зона ловли
            </div>
            {zone || setup ? (
              <div className="mt-2 space-y-1.5 font-mono text-xs text-holo/80">
                <div>
                  Диапазон:{' '}
                  <span className="font-bold text-holo">
                    {fmtPx(zone?.bottom ?? setup!.entryZone.bottom)} —{' '}
                    {fmtPx(zone?.top ?? setup!.entryZone.top)}
                  </span>
                </div>
                <div>
                  Лимит:{' '}
                  <span className="text-holo">
                    {fmtPx(setup?.limitEntry ?? zone?.limitEntry ?? 0)}
                  </span>
                  {(zone?.distancePct != null || setup) && (
                    <span className="text-holo/45">
                      {' '}
                      · до зоны{' '}
                      {(
                        zone?.distancePct ??
                        (((setup!.limitEntry - selected.lastPrice) /
                          selected.lastPrice) *
                          100)
                      ).toFixed(2)}
                      %
                    </span>
                  )}
                </div>
                <div>
                  Цель:{' '}
                  <span className="text-matrix">
                    {fmtPx(setup?.target ?? zone?.target ?? 0)}
                  </span>
                  {' · '}
                  SL:{' '}
                  <span className="text-alert">
                    {fmtPx(setup?.invalidation ?? zone?.invalidation ?? 0)}
                  </span>
                </div>
                {result.live.phaseLabel && (
                  <div className="pt-1 text-[10px] text-holo/45">
                    {result.live.phaseLabel}
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-2 font-mono text-xs text-holo/50">
                Зона не найдена — дождитесь подхода к ликвидности
              </p>
            )}
          </div>

          {/* Doubts */}
          {result.doubts.length > 0 && (
            <div className="rounded-xl border border-hull-border bg-hull/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-holo/50">
                <AlertTriangle className="h-3.5 w-3.5" />
                Сомнения / риски
              </div>
              <ul className="space-y-1">
                {result.doubts.map((d) => (
                  <li
                    key={d}
                    className="font-mono text-[11px] leading-snug text-holo/65"
                  >
                    · {d}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Watch factors */}
          {result.watchFactors.length > 0 && (
            <div className="rounded-xl border border-hull-border bg-hull/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-holo/50">
                <Eye className="h-3.5 w-3.5" />
                За чем следить
              </div>
              <div className="space-y-1.5">
                {result.watchFactors.map((f) => (
                  <div
                    key={f.id}
                    className={`rounded-lg border px-2.5 py-1.5 ${toneClass(f.tone)}`}
                  >
                    <div className="font-mono text-[10px] font-bold uppercase">
                      {f.label}
                    </div>
                    <div className="font-mono text-[11px] opacity-90">
                      {f.detail}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Steps */}
          {result.primary.steps.length > 0 && (
            <div className="rounded-xl border border-hull-border bg-hull/30 p-3">
              <div className="mb-1.5 font-mono text-[10px] font-bold uppercase text-holo/45">
                План
              </div>
              <ol className="space-y-1">
                {result.primary.steps.map((s, i) => (
                  <li
                    key={`${i}-${s}`}
                    className="font-mono text-[11px] text-holo/70"
                  >
                    {i + 1}. {s}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Bot CTA */}
          {!confirmOpen && !watchedOk && (
            <button
              type="button"
              disabled={!setup}
              onClick={() => setConfirmOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-sky-400/40 bg-sky-500/10 py-3 font-mono text-sm font-bold uppercase text-sky-200 transition-colors hover:bg-sky-500/20 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
              Отправить оповещение в бота?
            </button>
          )}

          {confirmOpen && (
            <div className="rounded-xl border border-sky-400/40 bg-sky-500/[0.08] p-3">
              <p className="font-mono text-xs leading-snug text-holo/80">
                Бот будет мониторить цену{' '}
                <span className="font-bold text-holo">
                  {toDisplayName(selected.symbol)}
                </span>{' '}
                и напишет, когда зона {result.side} станет READY (или
                инвалидируется). TTL 48ч.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={watchBusy}
                  onClick={() => setConfirmOpen(false)}
                  className="rounded-lg border border-hull-border py-2.5 font-mono text-xs font-bold uppercase text-holo/60 hover:bg-hull"
                >
                  Нет
                </button>
                <button
                  type="button"
                  disabled={watchBusy || !setup}
                  onClick={handleConfirmWatch}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-sky-400/50 bg-sky-500/20 py-2.5 font-mono text-xs font-bold uppercase text-sky-200 hover:bg-sky-500/30 disabled:opacity-40"
                >
                  {watchBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Да, следить
                </button>
              </div>
            </div>
          )}

          {watchedOk && (
            <div className="flex items-center gap-2 rounded-xl border border-matrix/35 bg-matrix/10 px-3 py-2.5">
              <Check className="h-4 w-4 text-matrix" />
              <span className="font-mono text-xs text-matrix">
                Бот мониторит зону — алерт при READY
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default SignalsView
