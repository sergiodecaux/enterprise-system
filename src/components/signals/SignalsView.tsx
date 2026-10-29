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
  Calculator,
  ChevronRight,
  Crosshair,
  ListChecks,
} from 'lucide-react'
import {
  PINNED_WATCHLIST,
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
import type { SetupTradeStyle } from '../../engine/setups/types'
import { HORIZON_PROFILES } from '../../engine/zones/horizonProfiles'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { logger } from '../../utils/logger'
import {
  buildMarketContextBoost,
  evaluateReadyGate,
  pushSignalSnapshot,
} from '../../engine/analysis'
import { getCachedWorkerMarketContext } from '../../hooks/useWorkerMarketContext'
import { DescriptiveNote } from '../tactical/DescriptiveNote'
import { AltMacroStrip } from '../market/AltMacroStrip'
import { ContextPanel } from '../market/ContextPanel'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import SegmentedControl from '../ui/SegmentedControl'
import PositionSizeCalculator from '../trades/PositionSizeCalculator'
import { loadJournal, SETUP_LABELS } from '../../engine/journal'
import { isSniperFireNew, sniperFireKey } from '../../engine/sniper/fire'
import { fetchCrowdContext } from '../../api/binance/crowd'
import { buildFullMarketContext } from '../../engine/context'
import { directionLabel } from '../../i18n/displayMaps'

const BTC = 'BTC/USDT:USDT'

const STYLE_OPTIONS: Array<{
  id: SetupTradeStyle
  label: string
  hint: string
}> = [
  { id: 'SCALP', label: 'Скальп', hint: '5–45м · ближние зоны' },
  { id: 'INTRADAY', label: 'Интрадей', hint: '2–8ч · основная сессия' },
  { id: 'SWING', label: 'Свинг', hint: 'дни · HTF зоны' },
]

function ttlHoursForStyle(style: SetupTradeStyle): number {
  if (style === 'SCALP') return 18
  if (style === 'SWING') return 96
  return 48
}

function fmtPx(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

function toneClass(tone: 'ok' | 'warn' | 'bad' | 'neutral'): string {
  if (tone === 'ok')
    return 'text-market-long border-market-long/20 bg-market-long/[0.05]'
  if (tone === 'warn')
    return 'text-market-warning border-market-warning/25 bg-market-warning/[0.05]'
  if (tone === 'bad')
    return 'text-market-short border-market-short/20 bg-market-short/[0.05]'
  return 'text-text-secondary border-border bg-bg-base/40'
}

const SignalsView = () => {
  const { userId, haptic, showAlert } = useTelegramWebApp()

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<MexcTicker[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [selected, setSelected] = useState<MexcTicker | null>(null)
  const [tradeStyle, setTradeStyle] = useState<SetupTradeStyle>('INTRADAY')
  const [sideBusy, setSideBusy] = useState<SignalSide | null>(null)
  const [result, setResult] = useState<DirectedSignalResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [workerCtx, setWorkerCtx] = useState<WorkerMarketContext | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [watchBusy, setWatchBusy] = useState(false)
  const [watchedOk, setWatchedOk] = useState(false)
  const [calcOpen, setCalcOpen] = useState(false)
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
  const journalVersion = useAppStore((s) => s.journalVersion)
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)

  const firedSniper = useMemo(() => {
    return loadJournal()
      .filter((e) => e.source === 'SNIPER' && e.status === 'OPEN')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8)
  }, [journalVersion])

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
    setCalcOpen(false)
  }

  const runSide = async (side: SignalSide) => {
    if (!selected || sideBusy) return
    setSideBusy(side)
    setError(null)
    setResult(null)
    setWatchedOk(false)
    setConfirmOpen(false)
    setCalcOpen(false)

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
        !(PINNED_WATCHLIST as readonly string[]).includes(symbol) &&
        !extraWatchlist.includes(symbol)
      ) {
        addToWatchlist(symbol)
      }

      const existing = signals.find((s) => s.internalSymbol === symbol)
      const style = tradeStyle
      const prof = HORIZON_PROFILES[style]

      const [btc1d, coin1d, c4h, c1h, c15m, c5m] = await Promise.all([
        marketContext?.dailyAnalysis
          ? Promise.resolve(null)
          : fetchOhlcv(BTC, '1d', 60),
        fetchOhlcv(symbol, '1d', 120),
        fetchOhlcv(symbol, '4h', 100),
        fetchOhlcv(symbol, '1h', 100),
        fetchOhlcv(symbol, '15m', style === 'SCALP' ? 120 : 80),
        style === 'SCALP'
          ? fetchOhlcv(symbol, '5m', 120)
          : Promise.resolve([] as Awaited<ReturnType<typeof fetchOhlcv>>),
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

      const baseSym = symbol.split('/')[0]
      const localNews =
        useAppStore.getState().newsSettings.scoreInfluence
          ? useAppStore.getState().newsIntel.coinSentiments[baseSym]?.scoreBoost
          : undefined
      const ctxBoost = buildMarketContextBoost({
        internalSymbol: symbol,
        side,
        workerCtx: workerCtx ?? getCachedWorkerMarketContext(),
        localNewsBoost: localNews,
      })

      const { signal } = analyzeSymbol({
        internalSymbol: symbol,
        ohlcv4h: c4h,
        ohlcv1h: c1h,
        ohlcv15m: c15m.length >= 20 ? c15m : c1h,
        ohlcv1d: coin1d.length >= 20 ? coin1d : undefined,
        ohlcv5m: c5m.length >= 20 ? c5m : undefined,
        priceChange24h: selected.priceChangePercent,
        dailyBias,
        btcTrend,
        mmIntent: mmIntentMap[symbol] ?? existing?.mmIntent ?? null,
        newsSentimentBoost: ctxBoost.newsSentimentBoost || undefined,
        marketCtxBoost: ctxBoost.marketCtxBoost || undefined,
        marketCtxNotes: ctxBoost.notes.length ? ctxBoost.notes : undefined,
      })
      // Stamp selected horizon so ScoreCard / journal / watch see the same style
      const styledSignal = {
        ...signal,
        tradeStyle: style,
        styleReasons: [
          ...(signal.styleReasons ?? []),
          `Signals tab · ${prof.tag} ${prof.label}`,
        ],
      }
      upsertSignal(styledSignal)
      pushSignalSnapshot(styledSignal)

      const price =
        selected.lastPrice > 0 ? selected.lastPrice : styledSignal.price
      const base = coinBaseFromInternal(symbol)
      const coinNews = workerCtx?.coinNews?.[base]
      const coinSent = newsIntel.coinSentiments[base]

      // Chart TF for path/zones: SCALP→5m/15m, INTRA→15m/1h, SWING→1h (+1d fib)
      const pathCandles =
        style === 'SCALP'
          ? c5m.length >= 20
            ? c5m
            : c15m.length >= 20
              ? c15m
              : c1h
          : style === 'SWING'
            ? c1h.length >= 20
              ? c1h
              : c4h
            : c15m.length >= 20
              ? c15m
              : c1h

      const crowd = await fetchCrowdContext(symbol)
      const rankContext = buildFullMarketContext({
        candles1d: coin1d,
        price,
        mm: mmIntentMap[symbol] ?? styledSignal.mmIntent ?? null,
        crowd,
      })
      const directed = buildDirectedSignal({
        side,
        candles: pathCandles,
        candles1d: coin1d,
        candles1h: c1h,
        symbol,
        flatSymbol: flat,
        price,
        signal: styledSignal,
        mmIntent: mmIntentMap[symbol] ?? styledSignal.mmIntent ?? null,
        liquidityMap: liquidityMaps[symbol] ?? null,
        fearGreed: workerCtx?.fearGreed ?? newsIntel.fearGreed?.value ?? null,
        fearGreedLabel:
          workerCtx?.fearGreedLabel ?? newsIntel.fearGreed?.label ?? null,
        btcDominance: workerCtx?.btcDominance ?? null,
        btcDomDelta24h: workerCtx?.btcDomDelta24h ?? null,
        total3Usd: workerCtx?.total3Usd ?? null,
        total3Delta24h: workerCtx?.total3Delta24h ?? null,
        altRegime: workerCtx?.altRegime ?? null,
        altBias: workerCtx?.altBias ?? null,
        newsLabel: workerCtx?.newsLabel ?? null,
        newsHeadlines: workerCtx?.newsHeadlines,
        coinNewsLabel: coinNews?.label ?? coinSent?.label ?? null,
        coinNewsHeadlines:
          coinNews?.headlines ??
          coinSent?.items?.slice(0, 3).map((i) => i.title),
        dailyBias: dailyBias.bias,
        btcTrend,
        tradeStyle: style,
        marketContext: rankContext,
        crowd,
      })

      // Ensure setup carries horizon for bot watch / Lab
      if (directed.bestSetup && !directed.bestSetup.tradeStyle) {
        directed.bestSetup = { ...directed.bestSetup, tradeStyle: style }
      }
      for (const s of directed.setups) {
        if (!s.tradeStyle) s.tradeStyle = style
      }

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

  const handleConfirmWatch = async (opts?: { early?: boolean }) => {
    if (!result?.bestSetup || !selected) {
      showAlert('Нет готового сетапа для слежения — зона слишком слабая')
      return
    }
    const signalForGate = signals.find(
      (s) => s.internalSymbol === selected.symbol
    )
    const gate = signalForGate ? evaluateReadyGate(signalForGate) : null
    const allowEarly = opts?.early === true

    if (gate && !gate.ready && !allowEarly) {
      showAlert(
        `Gate не готов (${gate.passCount}/${gate.needCount}): ${gate.summary}. Выбери «Ранний watch» или дождись READY.`
      )
      return
    }

    if (gate?.items.some((i) => i.id === 'hist_wr' && i.status === 'FAIL')) {
      showAlert(
        `Журнал этого сетапа не открывает Elite watch. Смени сторону или стиль.`
      )
      return
    }

    const chatId = resolveChatId()
    if (!chatId) {
      showAlert('Сначала подпишитесь на Telegram-алерты (колокольчик)')
      return
    }

    const style = result.bestSetup.tradeStyle ?? tradeStyle
    const ttlHours = ttlHoursForStyle(style)
    const earlyTag = allowEarly && gate && !gate.ready
    const setup: ConditionalSetup = {
      ...result.bestSetup,
      tradeStyle: style,
      symbol: toFlatSymbol(selected.symbol),
      internalSymbol: selected.symbol,
      title: (() => {
        const base = result.bestSetup.title.startsWith('#')
          ? result.bestSetup.title
          : `${HORIZON_PROFILES[style].tag} ${result.bestSetup.title}`
        return earlyTag ? `EARLY · ${base}` : base
      })(),
      reasoning: earlyTag
        ? [
            `EARLY watch — gate ${gate!.passCount}/${gate!.needCount}: ${gate!.summary}`,
            ...(result.bestSetup.reasoning ?? []),
          ]
        : result.bestSetup.reasoning,
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
          expiresAt: Date.now() + ttlHours * 3600_000,
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
        ttlHours,
      })
      if (watch) {
        upsertWatchedSetup(watch)
        setWatchedOk(true)
        setConfirmOpen(false)
        haptic.success()
        showAlert(
          earlyTag
            ? `Elite: ранний watch ${toDisplayName(selected.symbol)} ${setup.side} · ${style} (gate ещё не READY)`
            : `Elite следит за ${toDisplayName(selected.symbol)} ${setup.side} · ${style}. /start в @Enterpriseelite_bot — READY + журнал WR`
        )
      } else {
        upsertWatchedSetup({
          watchId: `local_${setup.id}`,
          chatId,
          symbol: toFlatSymbol(selected.symbol),
          internalSymbol: selected.symbol,
          setup,
          createdAt: Date.now(),
          expiresAt: Date.now() + ttlHours * 3600_000,
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

  const isResultLong = result?.side === 'LONG'
  const SideIcon = result?.side === 'SHORT' ? TrendingDown : TrendingUp
  const activeProfile = HORIZON_PROFILES[tradeStyle]

  const planEntry = setup?.limitEntry ?? zone?.limitEntry ?? 0
  const planSl = setup?.invalidation ?? zone?.invalidation ?? 0
  const planTarget = setup?.target ?? zone?.target ?? 0
  const planTp2 = setup?.targetsLadder?.r2 ?? null
  const planRR =
    planEntry > 0 && planSl > 0 && planTarget > 0
      ? Math.abs(planTarget - planEntry) / Math.abs(planEntry - planSl)
      : 0
  const zoneDistance =
    zone?.distancePct ??
    (setup && selected && selected.lastPrice > 0
      ? ((setup.limitEntry - selected.lastPrice) / selected.lastPrice) * 100
      : null)

  return (
    <div className="flex min-h-full flex-col bg-bg-base pb-8">
      <div className="z-10 border-b border-border bg-bg-base/95 px-3 py-2.5 backdrop-blur-sm min-[1100px]:sticky min-[1100px]:top-0">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 shrink-0 text-brand" />
          <h1 className="min-w-0 truncate font-sans text-[15px] font-semibold leading-5 text-text-primary">
            Сигналы
          </h1>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-sans text-[11px] leading-4 text-text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            ручной разбор
          </span>
        </div>
        <p className="mt-0.5 font-sans text-[11px] leading-4 text-text-muted">
          Стиль → монета → сторона → зона под горизонт
        </p>
      </div>

      {/* Market strip */}
      <div className="border-b border-border px-3 py-3">
        <AltMacroStrip ctx={workerCtx} />
        <p className="mt-1.5 text-center font-mono text-[11px] leading-4 text-text-muted">
          F&amp;G alternative.me {workerCtx?.fearGreed ?? newsIntel.fearGreed?.value ?? '—'}
          {workerCtx?.newsLabel ? ` · News ${workerCtx.newsLabel}` : ''}
        </p>
      </div>

      {firedSniper.length > 0 && (
        <div className="border-b border-border px-3 py-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Crosshair className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <span className="font-sans text-[11px] font-medium leading-4 text-text-muted">
              Снайпер выбросил
            </span>
            <span className="tnum ml-auto font-mono text-[11px] leading-4 text-text-muted">
              {firedSniper.length}
            </span>
          </div>
          <div className="space-y-1.5">
            {firedSniper.map((entry) => {
              const key = sniperFireKey(entry)
              const fresh = isSniperFireNew(key)
              const isLong = entry.direction === 'LONG'
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    haptic.impact()
                    selectCoin(entry.symbol)
                    setDrawerOpen(true)
                  }}
                  className={`relative w-full overflow-hidden rounded-lg border bg-bg-panel px-2.5 py-2 text-left transition-colors hover:border-border-active ${
                    isLong
                      ? 'border-market-long/25'
                      : 'border-market-short/25'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute inset-y-0 left-0 w-[2px] ${
                      isLong ? 'bg-market-long/70' : 'bg-market-short/70'
                    }`}
                  />
                  <div className="flex items-center justify-between gap-2 pl-1.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-mono text-[13px] font-semibold leading-5 text-text-primary">
                          {entry.displayName}
                        </span>
                        <Badge tone={isLong ? 'long' : 'short'} uppercase>
                          {directionLabel(entry.direction)}
                        </Badge>
                        {fresh && (
                          <Badge tone="brand" dot>
                            NEW
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] leading-4 text-text-muted">
                        {SETUP_LABELS[entry.setupType] ?? entry.setupTag}
                        {entry.tradeStyle ? ` · ${entry.tradeStyle}` : ''}
                        {' · '}SL {fmtPx(entry.sl)} · TP {fmtPx(entry.tp1)}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Search */}
      <div ref={wrapRef} className="relative px-3 pt-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="font-sans text-[11px] font-medium leading-4 text-text-muted">
            Монета
          </span>
          {selected ? (
            <span className="tnum flex items-center gap-2 font-mono text-[11px] leading-4 text-text-secondary">
              ${fmtPx(selected.lastPrice)}
              <span
                className={
                  selected.priceChangePercent >= 0
                    ? 'text-market-long'
                    : 'text-market-short'
                }
              >
                {selected.priceChangePercent >= 0 ? '+' : ''}
                {selected.priceChangePercent.toFixed(2)}%
              </span>
            </span>
          ) : (
            <span className="font-sans text-[11px] leading-4 text-text-muted">
              каталог MEXC
            </span>
          )}
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
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
            placeholder="Найти монету: BTC, ETH, PEPE…"
            className="h-10 w-full rounded-md border border-border bg-bg-panel pl-8 pr-10 font-mono text-[13px] text-text-primary outline-none placeholder:text-text-muted focus:border-brand/40 desk:h-8"
          />
          {query && (
            <button
              type="button"
              aria-label="Очистить поиск"
              className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-text-muted transition-colors hover:text-text-primary desk:h-8 desk:w-8"
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
          <div className="absolute left-3 right-3 z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-bg-elevated p-1 shadow-popover">
            {catalogLoading && (
              <div className="flex items-center gap-2 px-2.5 py-2.5 font-sans text-[11px] text-text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Загрузка каталога…
              </div>
            )}
            {!catalogLoading && results.length === 0 && (
              <div className="px-2.5 py-2.5 font-sans text-[11px] text-text-muted">
                Ничего не найдено
              </div>
            )}
            {results.map((ticker) => (
              <button
                key={ticker.symbol}
                type="button"
                onClick={() => pickCoin(ticker)}
                className="flex min-h-10 w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left transition-colors hover:bg-bg-surface"
              >
                <span className="truncate font-mono text-[12px] font-medium text-text-primary">
                  {toDisplayName(ticker.symbol)}
                </span>
                <span className="tnum shrink-0 font-mono text-[11px] text-text-muted">
                  ${ticker.lastPrice.toLocaleString('ru-RU')}
                  <span
                    className={`ml-1.5 ${
                      ticker.priceChangePercent >= 0
                        ? 'text-market-long'
                        : 'text-market-short'
                    }`}
                  >
                    {ticker.priceChangePercent >= 0 ? '+' : ''}
                    {ticker.priceChangePercent.toFixed(2)}%
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Trade style: SCALP / INTRA / SWING */}
      <div className="px-3 pt-3">
        <div className="mb-1.5 font-sans text-[11px] font-medium leading-4 text-text-muted">
          Горизонт сделки
        </div>
        <SegmentedControl
          value={tradeStyle}
          onChange={(value) => {
            setTradeStyle(value)
            setResult(null)
            setWatchedOk(false)
            setConfirmOpen(false)
            setCalcOpen(false)
            setError(null)
            haptic.impact()
          }}
          options={STYLE_OPTIONS.map((opt) => ({
            value: opt.id,
            label: opt.label,
            title: opt.hint,
            disabled: !!sideBusy,
          }))}
          size="md"
          stretch
          ariaLabel="Горизонт сделки"
          className="w-full"
        />
        <p className="mt-1.5 font-sans text-[11px] leading-4 text-text-muted">
          {STYLE_OPTIONS.find((opt) => opt.id === tradeStyle)?.hint}
        </p>
        <p className="font-mono text-[11px] leading-4 text-text-muted">
          {activeProfile.tag} · зоны до {activeProfile.maxDistPct}% · TP×
          {activeProfile.tpMult} · R {activeProfile.rMultiples.join('/')}
        </p>
      </div>

      {/* LONG / SHORT */}
      <div className="grid grid-cols-2 gap-2 px-3 pt-3">
        <button
          type="button"
          disabled={!selected || !!sideBusy}
          onClick={() => runSide('LONG')}
          className="flex h-11 items-center justify-center gap-2 rounded-md border border-market-long/30 bg-market-long/10 font-mono text-[13px] font-semibold text-market-long transition-colors hover:bg-market-long/15 active:bg-market-long/20 disabled:opacity-40"
        >
          {sideBusy === 'LONG' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <TrendingUp className="h-4 w-4" />
          )}
          {directionLabel('LONG')}
        </button>
        <button
          type="button"
          disabled={!selected || !!sideBusy}
          onClick={() => runSide('SHORT')}
          className="flex h-11 items-center justify-center gap-2 rounded-md border border-market-short/30 bg-market-short/10 font-mono text-[13px] font-semibold text-market-short transition-colors hover:bg-market-short/15 active:bg-market-short/20 disabled:opacity-40"
        >
          {sideBusy === 'SHORT' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <TrendingDown className="h-4 w-4" />
          )}
          {directionLabel('SHORT')}
        </button>
      </div>

      {!selected && (
        <p className="px-3 pt-2 font-sans text-[11px] leading-4 text-text-muted">
          Выберите монету, затем сторону — движок подберёт зону под горизонт.
        </p>
      )}

      {error && (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-market-short/25 bg-market-short/[0.06] px-2.5 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-market-short" />
          <span className="font-sans text-[11px] leading-4 text-market-short">
            {error}
          </span>
        </div>
      )}

      {/* Result */}
      {result && selected && (
        <div className="mt-3 space-y-3 px-3">
          <section
            className={`relative overflow-hidden rounded-lg border bg-bg-panel p-3 ${
              isResultLong ? 'border-market-long/25' : 'border-market-short/25'
            }`}
          >
            <span
              aria-hidden
              className={`absolute inset-y-0 left-0 w-[2px] ${
                isResultLong ? 'bg-market-long/70' : 'bg-market-short/70'
              }`}
            />
            <div className="pl-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h2 className="truncate font-mono text-[15px] font-semibold leading-5 text-text-primary">
                      {toDisplayName(selected.symbol)}
                    </h2>
                    <Badge tone={isResultLong ? 'long' : 'short'} uppercase>
                      <SideIcon className="h-3 w-3" strokeWidth={2} />
                      {directionLabel(result.side)}
                    </Badge>
                    <Badge tone="neutral">{activeProfile.tag}</Badge>
                  </div>
                  <p className="mt-1 font-sans text-[11px] leading-4 text-text-muted">
                    {activeProfile.label}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-sans text-[11px] leading-4 text-text-muted">
                    Совпадение
                  </div>
                  <div className="tnum font-mono text-[15px] font-medium leading-5 text-text-primary">
                    {Math.round(result.winPct)}%
                  </div>
                </div>
              </div>

              <div className="mt-2">
                <DescriptiveNote />
              </div>

              <p className="mt-2 font-sans text-[13px] font-medium leading-5 text-text-primary">
                {result.primary.title}
                {result.targetMovePct != null ? (
                  <span className="font-mono text-[11px] font-normal text-text-muted">
                    {' '}
                    · цель ~{result.targetMovePct.toFixed(1)}%
                  </span>
                ) : null}
              </p>
              <p className="mt-1 font-sans text-[11px] leading-4 text-text-secondary">
                {result.primary.summary}
              </p>
            </div>
          </section>

          {result.live.marketContext && (
            <ContextPanel ctx={result.live.marketContext} />
          )}

          {/* Catch zone */}
          <section className="rounded-lg border border-border bg-bg-panel p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Crosshair className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                <h3 className="truncate font-sans text-[13px] font-medium leading-5 text-text-primary">
                  Зона ловли
                </h3>
              </div>
              {planRR > 0 && (
                <Badge
                  tone={
                    planRR >= 3 ? 'long' : planRR >= 2 ? 'warning' : 'neutral'
                  }
                  uppercase
                  title="Риск к доходу до цели"
                >
                  1 : {planRR.toFixed(1)}
                </Badge>
              )}
            </div>

            {zone || setup ? (
              <>
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border">
                  <div className="bg-bg-base/60 px-2.5 py-2">
                    <div className="font-sans text-[11px] leading-4 text-text-muted">
                      Диапазон
                    </div>
                    <div className="tnum mt-0.5 truncate font-mono text-[12px] font-medium leading-4 text-text-primary">
                      {fmtPx(zone?.bottom ?? setup!.entryZone.bottom)} —{' '}
                      {fmtPx(zone?.top ?? setup!.entryZone.top)}
                    </div>
                  </div>
                  <div className="bg-bg-base/60 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-1 font-sans text-[11px] leading-4 text-text-muted">
                      <span>Лимит</span>
                      {zoneDistance != null && Number.isFinite(zoneDistance) && (
                        <span className="tnum font-mono">
                          {zoneDistance >= 0 ? '+' : ''}
                          {zoneDistance.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    <div
                      className={`tnum mt-0.5 truncate font-mono text-[12px] font-medium leading-4 ${
                        isResultLong ? 'text-market-long' : 'text-market-short'
                      }`}
                    >
                      {fmtPx(planEntry)}
                    </div>
                  </div>
                  <div className="bg-bg-base/60 px-2.5 py-2">
                    <div className="font-sans text-[11px] leading-4 text-text-muted">
                      Цель
                    </div>
                    <div className="tnum mt-0.5 truncate font-mono text-[12px] font-medium leading-4 text-market-long">
                      {fmtPx(planTarget)}
                    </div>
                  </div>
                  <div className="bg-bg-base/60 px-2.5 py-2">
                    <div className="font-sans text-[11px] leading-4 text-text-muted">
                      Стоп
                    </div>
                    <div className="tnum mt-0.5 truncate font-mono text-[12px] font-medium leading-4 text-market-short">
                      {fmtPx(planSl)}
                    </div>
                  </div>
                </div>

                {result.live.phaseLabel && (
                  <p className="mt-1.5 font-sans text-[11px] leading-4 text-text-muted">
                    {result.live.phaseLabel}
                  </p>
                )}

                <Button
                  variant="secondary"
                  size="md"
                  fullWidth
                  className="mt-2"
                  disabled={!(planEntry > 0 && planSl > 0)}
                  onClick={() => {
                    haptic.impact()
                    setCalcOpen(true)
                  }}
                >
                  <Calculator className="h-3.5 w-3.5" />
                  Рассчитать позицию
                </Button>
              </>
            ) : (
              <p className="font-sans text-[11px] leading-4 text-text-muted">
                Зона не найдена — дождитесь подхода к ликвидности.
              </p>
            )}
          </section>

          {/* Doubts */}
          {result.doubts.length > 0 && (
            <section className="rounded-lg border border-market-warning/20 bg-market-warning/[0.05] p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-market-warning" />
                <h3 className="font-sans text-[11px] font-medium leading-4 text-market-warning">
                  Сомнения / риски
                </h3>
              </div>
              <ul className="space-y-1">
                {result.doubts.map((d) => (
                  <li
                    key={d}
                    className="flex items-start gap-1.5 font-sans text-[11px] leading-4 text-text-secondary"
                  >
                    <span
                      aria-hidden
                      className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-market-warning/70"
                    />
                    <span className="min-w-0">{d}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Watch factors */}
          {result.watchFactors.length > 0 && (
            <section className="rounded-lg border border-border bg-bg-panel p-3">
              <div className="mb-2 flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                <h3 className="font-sans text-[11px] font-medium leading-4 text-text-muted">
                  За чем следить
                </h3>
              </div>
              <div className="space-y-1.5">
                {result.watchFactors.map((f) => (
                  <div
                    key={f.id}
                    className={`rounded-md border px-2.5 py-1.5 ${toneClass(f.tone)}`}
                  >
                    <div className="font-sans text-[11px] font-medium leading-4">
                      {f.label}
                    </div>
                    <div className="font-sans text-[11px] leading-4 opacity-90">
                      {f.detail}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Steps */}
          {result.primary.steps.length > 0 && (
            <section className="rounded-lg border border-border bg-bg-panel/60 p-3">
              <div className="mb-1.5 flex items-center gap-1.5">
                <ListChecks className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                <h3 className="font-sans text-[11px] font-medium leading-4 text-text-muted">
                  План
                </h3>
              </div>
              <ol className="space-y-1">
                {result.primary.steps.map((s, i) => (
                  <li
                    key={`${i}-${s}`}
                    className="flex items-start gap-2 font-sans text-[11px] leading-4 text-text-secondary"
                  >
                    <span className="tnum mt-px w-3 shrink-0 font-mono text-[11px] text-text-muted">
                      {i + 1}.
                    </span>
                    <span className="min-w-0">{s}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Bot CTA */}
          {!confirmOpen && !watchedOk && (
            <Button
              variant="primary"
              size="md"
              fullWidth
              disabled={!setup}
              onClick={() => {
                haptic.impact()
                setConfirmOpen(true)
              }}
            >
              <Send className="h-3.5 w-3.5" />
              Отправить оповещение в бота
            </Button>
          )}

          {confirmOpen && (
            <section className="rounded-lg border border-brand/25 bg-brand/[0.06] p-3">
              <p className="font-sans text-[12px] leading-5 text-text-secondary">
                Бот будет мониторить цену{' '}
                <span className="font-mono font-medium text-text-primary">
                  {toDisplayName(selected.symbol)}
                </span>{' '}
                и напишет, когда зона {result.side} · {activeProfile.tag} станет
                READY или инвалидируется. TTL {ttlHoursForStyle(tradeStyle)} ч.
              </p>
              {(() => {
                const gateSig = signals.find(
                  (s) => s.internalSymbol === selected.symbol
                )
                const g = gateSig ? evaluateReadyGate(gateSig) : null
                if (!g) return null
                return (
                  <p
                    className={`mt-2 font-sans text-[11px] leading-4 ${
                      g.ready ? 'text-market-long' : 'text-market-warning'
                    }`}
                  >
                    Gate: {g.summary}
                    {!g.ready
                      ? ' — обычный watch закрыт, нужен «Ранний» или ждать.'
                      : ''}
                  </p>
                )
              })()}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  disabled={watchBusy}
                  onClick={() => setConfirmOpen(false)}
                >
                  Отмена
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  disabled={watchBusy || !setup}
                  onClick={() => handleConfirmWatch({ early: false })}
                >
                  {watchBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Следить
                </Button>
              </div>
              <Button
                variant="ghost"
                size="md"
                fullWidth
                className="mt-2 text-market-warning hover:text-market-warning"
                disabled={watchBusy || !setup}
                onClick={() => handleConfirmWatch({ early: true })}
              >
                Ранний watch · gate не READY
              </Button>
            </section>
          )}

          {watchedOk && (
            <div className="flex items-center gap-2 rounded-md border border-market-long/25 bg-market-long/[0.06] px-2.5 py-2">
              <Check className="h-4 w-4 shrink-0 text-market-long" />
              <span className="font-sans text-[11px] leading-4 text-market-long">
                Бот мониторит зону — алерт при READY
              </span>
            </div>
          )}
        </div>
      )}

      <PositionSizeCalculator
        isOpen={calcOpen}
        onClose={() => setCalcOpen(false)}
        symbol={selected ? toFlatSymbol(selected.symbol) : ''}
        displayName={selected ? toDisplayName(selected.symbol) : ''}
        direction={result?.side ?? 'LONG'}
        entry={planEntry}
        sl={planSl}
        tp1={planTarget > 0 ? planTarget : null}
        tp2={planTp2}
      />
    </div>
  )
}

export default SignalsView
