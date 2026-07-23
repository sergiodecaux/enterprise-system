import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type LineData,
  type Time,
} from 'lightweight-charts'
import { useTranslation } from 'react-i18next'
import { Settings, Eye } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import type { EqualLevel } from '../../engine/types'
import {
  CHART_TIMEFRAMES,
  fetchOhlcv,
  type MexcTimeframe,
  type OhlcvCandle,
} from '../../api/mexc'
import type { CoinSignal } from '../../engine/types'
import type { LiquidityZone } from '../../engine/indicators/types'
import { logger } from '../../utils/logger'
import { useChartIndicators } from '../../hooks/useChartIndicators'
import { useChartZones } from '../../hooks/useChartZones'
import { useMultiTFAnalysis } from '../../hooks/useMultiTFAnalysis'
import { usePriceForecast } from '../../hooks/usePriceForecast'
import ChartSettings from './ChartSettings'
import ChartOverlay from './ChartOverlay'
import SessionOverlay from './SessionOverlay'
import VolumePanel from './VolumePanel'
import OscillatorPanel from './OscillatorPanel'
import MultiTFPanel from './MultiTFPanel'
import PredictionOverlay from './PredictionOverlay'
import GhostPathOverlay from './GhostPathOverlay'
import ScenarioLegend from './ScenarioLegend'
import MacroOutlookPanel from './MacroOutlookPanel'
import SetupPickerPanel from './SetupPickerPanel'
import { useSessionData } from '../../hooks/useSessionData'
import { SESSION_DEFINITIONS, getSessionAtHour } from '../../engine/sessions/sessionMap'
import {
  findTradeZones,
  refreshZoneSetups,
  type FoundTradeZone,
} from '../../engine/zones/findTradeZones'
import { pushJewelEntryAlert } from '../../api/telegram/formatters'
import { buildGlobalFibonacci } from '../../engine/zones/globalFibonacci'
import type { ForecastHorizon } from '../../engine/prediction/macroOutlook'
import { buildMacroContext } from '../../engine/prediction/macroOutlook'
import {
  buildConditionalSetups,
  type ConditionalSetup,
} from '../../engine/setups'
import {
  createWatchedSetup,
  removeWatchedSetup,
  isTelegramAlertsConfigured,
} from '../../api/telegram/alerts'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'

interface LiveChartProps {
  symbol: string
  flatSymbol: string
  signal?: CoinSignal | null
}

const CANDLE_LIMIT: Record<MexcTimeframe, number> = {
  '1m': 120,
  '5m': 120,
  '15m': 120,
  '1h': 120,
  '4h': 100,
  '1d': 90,
}

const INDICATOR_COLORS: Record<string, string> = {
  ema20: '#3b82f6',
  ema50: '#f59e0b',
  ema200: '#ef4444',
  sma9: '#8b5cf6',
  sma21: '#06b6d4',
  sma50: '#10b981',
  bb_upper: '#64748b',
  bb_middle: '#94a3b8',
  bb_lower: '#64748b',
  vwap: '#f97316',
}

const CHART_HEIGHT = 320
const CHART_HEIGHT_CLEAN = 340

const LiveChart = ({ symbol, flatSymbol, signal = null }: LiveChartProps) => {
  const { t } = useTranslation()

  const ticker = useAppStore((s) => s.liveTickets[flatSymbol])
  const orderBookMetrics = useAppStore(
    (s) => s.orderBookMetrics[symbol] ?? null
  )
  const chartPreferences = useAppStore((s) => s.chartPreferences)
  const setChartPreferences = useAppStore((s) => s.setChartPreferences)
  const sessionSettings = useAppStore((s) => s.sessionSettings)
  const setSessionSettings = useAppStore((s) => s.setSessionSettings)
  const eqLiquidityMap = useAppStore((s) => s.liquidityMaps[symbol] ?? null)
  const setLiquidityMap = useAppStore((s) => s.setLiquidityMap)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const priceLineRefs = useRef<IPriceLine[]>([])
  const liqLineRefs = useRef<IPriceLine[]>([])
  /** Skip fitContent after first successful load for this symbol/tf */
  const fittedKeyRef = useRef<string>('')
  const userPanningRef = useRef(false)

  const [timeframe, setTimeframe] = useState<MexcTimeframe>('1h')
  const [candles, setCandles] = useState<OhlcvCandle[]>([])
  const [lwcData, setLwcData] = useState<CandlestickData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chartReady, setChartReady] = useState(0)
  const [chartInstance, setChartInstance] = useState<IChartApi | null>(null)
  const [showForecast, setShowForecast] = useState(true)
  /** INTRA = текущий ТФ · MACRO = недельная картина A/B/C */
  const [forecastHorizon, setForecastHorizon] = useState<ForecastHorizon>('INTRA')
  /** По умолчанию только A — B/C включаются вручную, меньше каши */
  const [activeScenarios, setActiveScenarios] = useState<Set<string>>(
    () => new Set(['A'])
  )
  const [cleanMode, setCleanMode] = useState(true)
  const [showSetupPicker, setShowSetupPicker] = useState(false)
  const [pickedSetups, setPickedSetups] = useState<ConditionalSetup[]>([])
  const [selectedSetupId, setSelectedSetupId] = useState<string | null>(null)
  const [watchBusy, setWatchBusy] = useState(false)
  const [fibPanelOpen, setFibPanelOpen] = useState(false)
  const [foundZones, setFoundZones] = useState<FoundTradeZone[]>([])
  const [foundChartZones, setFoundChartZones] = useState<LiquidityZone[]>([])
  const [zonesMode, setZonesMode] = useState(false)
  const jewelSentRef = useRef<Set<string>>(new Set())

  const watchedSetups = useAppStore((s) => s.watchedSetups)
  const upsertWatchedSetup = useAppStore((s) => s.upsertWatchedSetup)
  const removeWatchedSetupLocal = useAppStore((s) => s.removeWatchedSetupLocal)
  const telegramSettings = useAppStore((s) => s.telegramAlertSettings)
  const { showAlert, haptic } = useTelegramWebApp()

  const currentPrice = ticker?.price ?? signal?.price ?? 0
  const liveBookImbalance =
    orderBookMetrics != null ? orderBookMetrics.imbalance / 100 : null
  const btcRs = signal?.btcDivergence?.relativeStrength ?? null
  const mmFromStore = useAppStore((s) => s.mmIntent[symbol] ?? null)
  const mmSnap = signal?.mmIntent ?? mmFromStore
  const mmHunt = mmSnap
    ? {
        microTarget: mmSnap.hunt.microTarget,
        macroTarget: mmSnap.hunt.macroTarget,
        microIsStopHunt: mmSnap.hunt.microIsStopHunt,
        preferredSide: mmSnap.preferredSide,
      }
    : null
  // Re-anchor scenario paths every ~60s even if HTF candles are quiet
  const [scenarioClock, setScenarioClock] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setScenarioClock((n) => n + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])
  const forecastRefreshKey =
    Math.round((ticker?.timestamp ?? 0) / 15_000) +
    Math.round((orderBookMetrics?.imbalance ?? 0) * 10) +
    (mmSnap?.updatedAt ? Math.round(mmSnap.updatedAt / 15_000) : 0) +
    scenarioClock

  const baseSym = flatSymbol.replace(/USDT$/i, '').replace(/_USDT$/i, '')
  const coinSentiment = useAppStore(
    (s) => s.newsIntel.coinSentiments[baseSym] ?? null
  )
  const newsBias =
    coinSentiment?.label === 'BULLISH' || coinSentiment?.label === 'BEARISH'
      ? coinSentiment.label
      : ('NEUTRAL' as const)
  const newsScore = coinSentiment?.score ?? 0

  const indicators = useChartIndicators(candles, chartPreferences.indicators)
  const { liquidityZones: baseZones, priceLevels: basePriceLevels } = useChartZones(
    candles,
    chartPreferences.zones
  )

  const lastCandleTs =
    candles.length > 0 ? Math.floor(candles[candles.length - 1][0] / 1000) : 0

  const { alignment, liquidityMap, candles1d, isLoading: mtfLoading } = useMultiTFAnalysis(
    symbol,
    currentPrice,
    true
  )

  const globalFib = useMemo(() => {
    // Chart TF first: last swing H/L on what user sees; daily only if too few bars
    const src =
      candles.length >= 40
        ? candles
        : candles1d.length >= 20
          ? candles1d
          : candles
    // Stabilize vs ticker noise — round to ~0.02% so fib doesn't rebuild every tick
    const px =
      currentPrice > 0
        ? Number(currentPrice.toPrecision(6))
        : currentPrice
    return buildGlobalFibonacci(src, px || 0)
  }, [candles, candles1d, currentPrice])

  const fearGreedValue = useAppStore((s) => s.newsIntel.fearGreed?.value ?? null)

  /** OTE Killzone Box + signal-linked zones + global Fib reaction */
  const liquidityZones = useMemo((): LiquidityZone[] => {
    const visibleStart =
      candles.length > 0
        ? (Math.floor(candles[0][0] / 1000) as Time)
        : ((Date.now() / 1000) as Time)
    const visibleEnd =
      candles.length > 0
        ? ((Math.floor(candles[candles.length - 1][0] / 1000) + 86400) as Time)
        : ((Date.now() / 1000 + 86400) as Time)

    const fibZones = (globalFib?.chartZones ?? []).map((z) => ({
      ...z,
      // Anchor fib bands to visible chart range so overlay can draw them
      startTime: visibleStart,
      endTime: visibleEnd,
    }))

    if (cleanMode) {
      // В чистом режиме — OTE + сильнейший OB + активные Fib-зоны
      const zones: LiquidityZone[] = []
      const obs = baseZones
        .filter((z) => z.type === 'ORDER_BLOCK')
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 1)
      zones.push(...obs)
      // Always keep 141 band on chart (главный магнит), even if price far
      const fib141 = fibZones.filter(
        (z) =>
          (z.id ?? '').includes('141') || (z.label ?? '').includes('141')
      )
      zones.push(...fib141.slice(0, 2))
      // Secondary active fib only if no 141 drawn
      if (!fib141.length) {
        zones.push(
          ...fibZones.filter((z) => (z.label ?? '').includes('◎')).slice(0, 1)
        )
      }
      if (signal?.ote?.isActive && candles.length > 0) {
        const start = candles[Math.max(0, candles.length - 40)]
        const end = candles[candles.length - 1]
        zones.push({
          id: 'ote_killzone',
          type: 'OTE',
          side: signal.direction === 'SHORT' ? 'BEARISH' : 'BULLISH',
          top: signal.ote.zoneTop,
          bottom: signal.ote.zoneBottom,
          startTime: (start[0] / 1000) as Time,
          endTime: (end[0] / 1000) as Time,
          strength: 12,
          label: signal.ote.priceInZone
            ? 'OTE — набирай сеткой'
            : 'OTE Zone',
        })
      }
      if (zonesMode && foundChartZones.length) {
        return [...foundChartZones, ...zones]
      }
      return zones
    }

    const zones = [...baseZones, ...fibZones]
    if (signal?.ote?.isActive && candles.length > 0) {
      const start = candles[Math.max(0, candles.length - 40)]
      const end = candles[candles.length - 1]
      zones.push({
        id: 'ote_killzone',
        type: 'OTE',
        side: signal.direction === 'SHORT' ? 'BEARISH' : 'BULLISH',
        top: signal.ote.zoneTop,
        bottom: signal.ote.zoneBottom,
        startTime: (start[0] / 1000) as Time,
        endTime: (end[0] / 1000) as Time,
        strength: 12,
        label: signal.ote.priceInZone
          ? 'OTE — набирай сеткой'
          : 'OTE Zone',
      })
    }
    if (zonesMode && foundChartZones.length) {
      return [...foundChartZones, ...zones]
    }
    return zones
  }, [baseZones, signal, candles, globalFib, cleanMode, zonesMode, foundChartZones])

  const priceLevels = useMemo(() => {
    const fibLines = globalFib?.priceLevels ?? []
    if (!fibLines.length) return basePriceLevels
    // Prefer global HTF fib grid over local candle fib duplicates
    const withoutLocalFib = basePriceLevels.filter(
      (l) => !l.id.startsWith('fib_')
    )
    return [...withoutLocalFib, ...fibLines]
  }, [basePriceLevels, globalFib])

  const forecast = usePriceForecast(
    candles,
    alignment,
    liquidityMap,
    currentPrice,
    symbol,
    timeframe,
    signal?.sl ?? null,
    signal?.invalidationPrice ?? null,
    forecastHorizon,
    candles1d,
    newsBias,
    newsScore,
    fearGreedValue,
    liveBookImbalance,
    btcRs,
    forecastRefreshKey,
    mmHunt
  )

  const macroCtx = useMemo(() => {
    if (
      (forecastHorizon !== 'MACRO' && forecastHorizon !== 'SWING') ||
      !alignment ||
      candles1d.length < 20
    ) {
      return null
    }
    return buildMacroContext(
      candles1d,
      alignment,
      liquidityMap,
      currentPrice,
      newsBias,
      newsScore
    )
  }, [
    forecastHorizon,
    alignment,
    candles1d,
    liquidityMap,
    currentPrice,
    newsBias,
    newsScore,
  ])

  const resolveChatId = useCallback((): number | null => {
    const manual = telegramSettings.manualChatId.trim()
    if (manual && /^-?\d+$/.test(manual)) return Number(manual)
    if (telegramSettings.subscribedChatId) return telegramSettings.subscribedChatId
    return null
  }, [telegramSettings])

  const handlePickSetups = useCallback(() => {
    if (!signal) {
      showAlert('Нет сигнала по монете — подождите скан')
      return
    }
    const setups = buildConditionalSetups({
      signal,
      forecast,
      liquidityMap: eqLiquidityMap,
      mmIntent: mmSnap,
      htfTrend: signal.htfTrend,
      price: currentPrice || signal.price,
    })
    setPickedSetups(setups)
    setShowSetupPicker(true)
    setShowForecast(true)
    haptic.impact()
  }, [
    signal,
    forecast,
    eqLiquidityMap,
    mmSnap,
    currentPrice,
    showAlert,
    haptic,
  ])

  const handleFindZones = useCallback(async () => {
    if (!(currentPrice > 0) || candles.length < 20) {
      showAlert('Нужны свечи и цена — подождите загрузку графика')
      return
    }
    jewelSentRef.current = new Set()
    const result = findTradeZones({
      candles,
      candles1d,
      symbol,
      flatSymbol,
      price: currentPrice,
      signal,
      mmIntent: mmSnap,
      forecast,
      liquidityMap: eqLiquidityMap,
      bookImbalance: orderBookMetrics?.imbalance ?? null,
    })
    setFoundZones(result.zones)
    setFoundChartZones(result.chartZones)
    setZonesMode(true)
    setLiquidityMap(symbol, result.liquidityMap)
    setPickedSetups(result.setups)
    setShowSetupPicker(true)
    setShowForecast(true)
    setCleanMode(false)
    haptic.success()

    const chatId = resolveChatId()
    const autoWatch = result.setups
      .filter((s) => s.side === 'LONG' || s.side === 'SHORT')
      .slice(0, 4)

    for (const setup of autoWatch) {
      if (chatId) {
        try {
          if (isTelegramAlertsConfigured()) {
            const watch = await createWatchedSetup({
              chatId,
              setup,
              symbol: flatSymbol,
              internalSymbol: symbol,
              ttlHours: 48,
            })
            if (watch) upsertWatchedSetup(watch)
          } else {
            upsertWatchedSetup({
              watchId: `local_${setup.id}`,
              chatId,
              symbol: flatSymbol,
              internalSymbol: symbol,
              setup,
              createdAt: Date.now(),
              expiresAt: Date.now() + 48 * 3600_000,
              lastStatus: setup.status,
              readyNotified: false,
              invalidatedNotified: false,
              updatedAt: Date.now(),
            })
          }
        } catch {
          /* ignore watch errors */
        }
      }
    }

    for (const ready of result.jewelReady) {
      const key = `${ready.side}:${ready.limitEntry.toPrecision(6)}`
      if (jewelSentRef.current.has(key)) continue
      jewelSentRef.current.add(key)
      void pushJewelEntryAlert({
        setup: ready,
        symbol: flatSymbol,
        displayName: signal?.displayName,
        price: currentPrice,
        chatId: chatId ?? undefined,
      })
    }

    const longZ = result.nearestLong
    const shortZ = result.nearestShort
    showAlert(
      `Зоны: ${result.zones.length}` +
        (longZ
          ? ` · LONG @ ${longZ.mid.toPrecision(5)}`
          : '') +
        (shortZ
          ? ` · SHORT @ ${shortZ.mid.toPrecision(5)}`
          : '') +
        (chatId ? ' · слежение в боте' : ' · подпишитесь на бота для алертов')
    )
  }, [
    currentPrice,
    candles,
    candles1d,
    symbol,
    flatSymbol,
    signal,
    mmSnap,
    forecast,
    eqLiquidityMap,
    orderBookMetrics,
    setLiquidityMap,
    upsertWatchedSetup,
    showAlert,
    haptic,
    resolveChatId,
  ])

  const watchingIds = useMemo(() => {
    const ids = new Set<string>()
    for (const w of watchedSetups) {
      if (w.internalSymbol === symbol || w.symbol === flatSymbol) {
        ids.add(w.setup.id)
      }
    }
    return ids
  }, [watchedSetups, symbol, flatSymbol])

  const handleWatchSetup = useCallback(
    async (setup: ConditionalSetup) => {
      const chatId = resolveChatId()
      if (!chatId) {
        showAlert('Сначала подпишитесь на Telegram-алерты (колокольчик)')
        return
      }
      setWatchBusy(true)
      try {
        if (!isTelegramAlertsConfigured()) {
          upsertWatchedSetup({
            watchId: `local_${setup.id}`,
            chatId,
            symbol: flatSymbol,
            internalSymbol: symbol,
            setup,
            createdAt: Date.now(),
            expiresAt: Date.now() + 48 * 3600_000,
            lastStatus: setup.status,
            readyNotified: false,
            invalidatedNotified: false,
            updatedAt: Date.now(),
          })
          showAlert('Watch сохранён локально (прокси не настроен)')
          return
        }
        const watch = await createWatchedSetup({
          chatId,
          setup,
          symbol: flatSymbol,
          internalSymbol: symbol,
          ttlHours: 48,
        })
        if (watch) {
          upsertWatchedSetup(watch)
          haptic.success()
          showAlert(`Слежу за сетапом ${setup.side} · алерт в бот при READY`)
        } else {
          upsertWatchedSetup({
            watchId: `local_${setup.id}`,
            chatId,
            symbol: flatSymbol,
            internalSymbol: symbol,
            setup,
            createdAt: Date.now(),
            expiresAt: Date.now() + 48 * 3600_000,
            lastStatus: setup.status,
            readyNotified: false,
            invalidatedNotified: false,
            updatedAt: Date.now(),
          })
          showAlert('Worker недоступен — watch только локально')
        }
      } finally {
        setWatchBusy(false)
      }
    },
    [
      resolveChatId,
      showAlert,
      flatSymbol,
      symbol,
      upsertWatchedSetup,
      haptic,
    ]
  )

  const handleUnwatchSetup = useCallback(
    async (setup: ConditionalSetup) => {
      const chatId = resolveChatId()
      const existing = watchedSetups.find((w) => w.setup.id === setup.id)
      if (existing) {
        removeWatchedSetupLocal(existing.watchId)
        if (chatId && !existing.watchId.startsWith('local_')) {
          await removeWatchedSetup({ chatId, watchId: existing.watchId })
        }
      }
      haptic.impact()
    },
    [resolveChatId, watchedSetups, removeWatchedSetupLocal, haptic]
  )

  // Zone watch: refresh readiness from price + book; push jewel when READY
  useEffect(() => {
    if (!zonesMode || pickedSetups.length === 0 || !(currentPrice > 0)) return
    const refreshed = refreshZoneSetups(
      pickedSetups,
      currentPrice,
      orderBookMetrics?.imbalance ?? null,
      signal
    )
    const changed = refreshed.some(
      (s, i) =>
        s.status !== pickedSetups[i]?.status ||
        s.probability !== pickedSetups[i]?.probability
    )
    if (changed) setPickedSetups(refreshed)

    const chatId = resolveChatId()
    for (const s of refreshed) {
      if (s.status !== 'READY') continue
      if (s.probability < 60) continue
      const key = `${s.side}:${s.limitEntry.toPrecision(6)}`
      if (jewelSentRef.current.has(key)) continue
      jewelSentRef.current.add(key)
      void pushJewelEntryAlert({
        setup: s,
        symbol: flatSymbol,
        displayName: signal?.displayName,
        price: currentPrice,
        chatId: chatId ?? undefined,
      })
      haptic.success()
      showAlert(`💎 Ювелирный ${s.side} → бот · TP ${s.target.toPrecision(5)}`)
    }
  }, [
    zonesMode,
    currentPrice,
    orderBookMetrics?.imbalance,
    signal,
    ticker?.timestamp,
    flatSymbol,
    resolveChatId,
    haptic,
    showAlert,
    // intentionally omit pickedSetups to avoid loop — use functional update path via changed check
    pickedSetups,
  ])

  const selectedSetup = pickedSetups.find((s) => s.id === selectedSetupId) ?? null

  useEffect(() => {
    if (!selectedSetup?.chartPath || !forecast) return
    if (
      selectedSetup.kind === 'FORECAST_A' ||
      selectedSetup.kind === 'FORECAST_B' ||
      selectedSetup.kind === 'FORECAST_C'
    ) {
      const id = selectedSetup.kind.replace('FORECAST_', '')
      setActiveScenarios(new Set([id]))
    }
  }, [selectedSetup, forecast])

  const { sessions, weekends, news } = useSessionData(
    chartInstance,
    timeframe,
    sessionSettings
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setCandles([])
    setLwcData([])

    const pollMs =
      timeframe === '1m'
        ? 15_000
        : timeframe === '5m'
          ? 25_000
          : timeframe === '15m'
            ? 40_000
            : timeframe === '1h'
              ? 60_000
              : timeframe === '4h'
                ? 120_000
                : 180_000

    const load = async (silent = false) => {
      try {
        if (!silent) {
          setLoading(true)
          setError(null)
        }
        const data = await fetchOhlcv(symbol, timeframe, CANDLE_LIMIT[timeframe])
        if (cancelled) return
        if (!data.length) {
          if (!silent) setError(t('chart_empty'))
          return
        }

        const mapped: CandlestickData[] = data.map((c) => ({
          time: (c[0] / 1000) as Time,
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
        }))
        setCandles(data)
        setLwcData(mapped)
      } catch (err) {
        logger.warn('LiveChart klines failed', err)
        if (!cancelled && !silent) setError(t('chart_error'))
      } finally {
        if (!cancelled && !silent) setLoading(false)
      }
    }

    void load(false)
    const id = window.setInterval(() => void load(true), pollMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [symbol, timeframe, t])

  useEffect(() => {
    if (!containerRef.current || chartRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#111111' },
        textColor: '#e0e0e080',
      },
      grid: {
        vertLines: { color: '#1a1a1a' },
        horzLines: { color: '#1a1a1a' },
      },
      crosshair: { mode: 0 },
      timeScale: {
        borderColor: '#2a2a2a',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        lockVisibleTimeRangeOnResize: true,
      },
      rightPriceScale: {
        borderColor: '#2a2a2a',
        scaleMargins: { top: 0.08, bottom: 0.12 },
        autoScale: true,
      },
      width: containerRef.current.clientWidth,
      height: CHART_HEIGHT,
      // Mobile-first: pan freely, no kinetic jump-back, no vert drag fighting drawer
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
        axisDoubleClickReset: false,
      },
      kineticScroll: {
        touch: false,
        mouse: false,
      },
    })

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00ff41',
      downColor: '#ff003c',
      borderUpColor: '#00ff41',
      borderDownColor: '#ff003c',
      wickUpColor: '#00ff4180',
      wickDownColor: '#ff003c80',
      lastValueVisible: true,
      priceLineVisible: false,
    })

    chartRef.current = chart
    candleRef.current = candleSeries
    setChartInstance(chart)
    setChartReady((n) => n + 1)

    const onTouchStart = () => {
      userPanningRef.current = true
    }
    const onTouchEnd = () => {
      window.setTimeout(() => {
        userPanningRef.current = false
      }, 400)
    }
    containerRef.current.addEventListener('touchstart', onTouchStart, {
      passive: true,
    })
    containerRef.current.addEventListener('touchend', onTouchEnd, {
      passive: true,
    })

    const ro = new ResizeObserver((entries) => {
      if (!entries.length || !chartRef.current) return
      const w = entries[0].contentRect.width
      if (w <= 0) return
      // Don't fight user gesture
      if (userPanningRef.current) return
      chart.applyOptions({
        width: w,
        height: CHART_HEIGHT,
      })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      containerRef.current?.removeEventListener('touchstart', onTouchStart)
      containerRef.current?.removeEventListener('touchend', onTouchEnd)
      Object.values(lineRefs.current).forEach((s) => {
        try {
          chart.removeSeries(s)
        } catch {
          /* ignore */
        }
      })
      lineRefs.current = {}
      priceLineRefs.current = []
      liqLineRefs.current = []
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      setChartInstance(null)
    }
  }, [])

  useEffect(() => {
    if (!candleRef.current || !lwcData.length) return
    const key = `${symbol}|${timeframe}`
    const needFit = fittedKeyRef.current !== key
    candleRef.current.setData(lwcData)
    if (needFit) {
      chartRef.current?.timeScale().fitContent()
      fittedKeyRef.current = key
    }
  }, [lwcData, symbol, timeframe])

  useEffect(() => {
    if (!candleRef.current || !ticker || !lwcData.length) return
    if (timeframe === '4h' || timeframe === '1d') return
    if (userPanningRef.current) return

    const last = lwcData[lwcData.length - 1]
    const p = ticker.price
    if (Math.abs(last.close - p) / Math.max(p, 1e-12) < 0.00005) return

    candleRef.current.update({
      ...last,
      close: p,
      high: Math.max(last.high, p),
      low: Math.min(last.low, p),
    })
  }, [ticker?.price, lwcData, timeframe])

  const updateLineSeries = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return

    const seriesMap: Record<string, LineData[]> = {
      ema20: indicators.ema20,
      ema50: indicators.ema50,
      ema200: indicators.ema200,
      sma9: indicators.sma9,
      sma21: indicators.sma21,
      sma50: indicators.sma50,
      vwap: indicators.vwap,
      bb_upper: indicators.bollingerBands.map((p) => ({
        time: p.time,
        value: p.upper,
      })),
      bb_middle: indicators.bollingerBands.map((p) => ({
        time: p.time,
        value: p.middle,
      })),
      bb_lower: indicators.bollingerBands.map((p) => ({
        time: p.time,
        value: p.lower,
      })),
    }

    Object.entries(seriesMap).forEach(([key, data]) => {
      if (data.length === 0) {
        if (lineRefs.current[key]) {
          try {
            chart.removeSeries(lineRefs.current[key])
          } catch {
            /* ignore */
          }
          delete lineRefs.current[key]
        }
        return
      }

      if (!lineRefs.current[key]) {
        const isDashed = key.startsWith('bb_')
        lineRefs.current[key] = chart.addLineSeries({
          color: INDICATOR_COLORS[key] ?? '#fff',
          lineWidth: key === 'ema200' ? 2 : 1,
          lineStyle: isDashed ? 2 : 0,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
        })
      }

      lineRefs.current[key].setData(data)
    })
  }, [indicators])

  useEffect(() => {
    updateLineSeries()
  }, [updateLineSeries, chartReady])

  useEffect(() => {
    const series = candleRef.current
    if (!series) return

    for (const line of priceLineRefs.current) {
      try {
        series.removePriceLine(line)
      } catch {
        /* ignore */
      }
    }
    priceLineRefs.current = []

    const fmt = (p: number) => {
      if (p >= 1000) return p.toFixed(2)
      if (p >= 1) return p.toFixed(4)
      return p.toPrecision(5)
    }

    const addLine = (
      price: number,
      color: string,
      title: string,
      opts?: {
        lineStyle?: 0 | 1 | 2 | 3 | 4
        lineWidth?: 1 | 2 | 3 | 4
        axisLabel?: boolean
      }
    ) => {
      try {
        const line = series.createPriceLine({
          price,
          color,
          lineWidth: opts?.lineWidth ?? 1,
          lineStyle: opts?.lineStyle ?? 2,
          // Fib: no axis label (не путает с SL/TP справа)
          axisLabelVisible: opts?.axisLabel ?? false,
          title,
        })
        priceLineRefs.current.push(line)
      } catch {
        /* ignore */
      }
    }

    // Fib first — without right-axis price tags
    for (const level of priceLevels) {
      const is141 = level.label === '141' || level.id.includes('1.414')
      if (cleanMode && !is141 && level.label !== '161' && level.label !== '100%') {
        continue
      }
      addLine(level.price, level.color, is141 ? 'F141' : level.label, {
        lineStyle: level.lineStyle ?? 2,
        lineWidth: is141 ? 2 : 1,
        axisLabel: false,
      })
    }

    // Trade levels last — clear titles + axis labels on the right
    const entry =
      signal?.surgicalEntry?.status === 'READY' &&
      signal.surgicalEntry.limitEntry != null
        ? signal.surgicalEntry.limitEntry
        : null
    if (entry != null) {
      addLine(entry, 'rgba(56, 189, 248, 0.95)', `IN ${fmt(entry)}`, {
        lineStyle: 0,
        lineWidth: 2,
        axisLabel: true,
      })
    }
    if (signal?.sl != null) {
      addLine(signal.sl, 'rgba(239, 68, 68, 0.95)', `SL ${fmt(signal.sl)}`, {
        lineStyle: 0,
        lineWidth: 2,
        axisLabel: true,
      })
    }
    if (signal?.tp1 != null) {
      addLine(signal.tp1, 'rgba(34, 197, 94, 0.95)', `TP1 ${fmt(signal.tp1)}`, {
        lineStyle: 0,
        lineWidth: 2,
        axisLabel: true,
      })
    }
    if (signal?.tp2 != null) {
      addLine(signal.tp2, 'rgba(34, 197, 94, 0.65)', `TP2 ${fmt(signal.tp2)}`, {
        lineStyle: 2,
        lineWidth: 1,
        axisLabel: true,
      })
    }
    if (signal?.tpDaily != null) {
      addLine(
        signal.tpDaily,
        'rgba(100, 200, 255, 0.7)',
        `TPd ${fmt(signal.tpDaily)}`,
        { lineStyle: 2, lineWidth: 1, axisLabel: false }
      )
    }
    if (signal?.invalidationPrice != null) {
      const invTitle = signal.invalidationMessage?.includes('4H')
        ? 'Inv4H'
        : signal.invalidationMessage?.includes('1H')
          ? 'Inv1H'
          : 'Inv'
      addLine(
        signal.invalidationPrice,
        'rgba(251, 191, 36, 0.95)',
        `${invTitle} ${fmt(signal.invalidationPrice)}`,
        { lineStyle: 1, lineWidth: 1, axisLabel: true }
      )
    }
  }, [
    priceLevels,
    chartPreferences.showLabels,
    chartReady,
    lwcData,
    signal,
    cleanMode,
  ])

  // ── Liquidity Map: Equal Highs / Equal Lows линии ──────────────────────────
  useEffect(() => {
    const series = candleRef.current
    if (!series) return

    for (const line of liqLineRefs.current) {
      try {
        series.removePriceLine(line)
      } catch {
        /* ignore */
      }
    }
    liqLineRefs.current = []

    if (!eqLiquidityMap) return

    const drawLiqLevel = (level: EqualLevel) => {
      const isBSL = level.type === 'HIGH'

      const colorMap = {
        STRONG: isBSL ? 'rgba(251, 191, 36, 0.9)' : 'rgba(168, 85, 247, 0.9)',
        MEDIUM: isBSL ? 'rgba(251, 191, 36, 0.6)' : 'rgba(168, 85, 247, 0.6)',
        WEAK: isBSL ? 'rgba(251, 191, 36, 0.35)' : 'rgba(168, 85, 247, 0.35)',
      }

      const color = level.isActive
        ? colorMap[level.strength]
        : 'rgba(100, 100, 100, 0.3)'

      const styleMap: Record<string, 0 | 1 | 2 | 3> = {
        STRONG: 0,
        MEDIUM: 2,
        WEAK: 3,
      }
      const lineStyle = styleMap[level.strength]

      const typeLabel = isBSL ? 'BSL' : 'SSL'
      const touchLabel = `×${level.touches}`
      const distLabel = `${level.distancePct.toFixed(1)}%`
      const title = chartPreferences.showLabels
        ? `${typeLabel} ${touchLabel} ${distLabel}`
        : ''

      try {
        const line = series.createPriceLine({
          price: level.price,
          color,
          lineWidth: level.strength === 'STRONG' ? 2 : 1,
          lineStyle,
          axisLabelVisible: chartPreferences.showLabels,
          title,
        })
        liqLineRefs.current.push(line)
      } catch {
        /* ignore */
      }
    }

    // Только ближайшие сильные уровни — иначе каша линий
    const highs = [...eqLiquidityMap.equalHighs]
      .filter((l) => l.strength !== 'WEAK')
      .sort((a, b) => a.distancePct - b.distancePct)
      .slice(0, cleanMode ? 1 : 2)
    const lows = [...eqLiquidityMap.equalLows]
      .filter((l) => l.strength !== 'WEAK')
      .sort((a, b) => a.distancePct - b.distancePct)
      .slice(0, cleanMode ? 1 : 2)

    for (const level of highs) drawLiqLevel(level)
    for (const level of lows) drawLiqLevel(level)
  }, [eqLiquidityMap, chartPreferences.showLabels, chartReady, lwcData, cleanMode])

  const oscillators: Array<'rsi' | 'macd' | 'stochastic' | 'atr'> = []
  if (!cleanMode) {
    if (chartPreferences.indicators.rsi) oscillators.push('rsi')
    if (chartPreferences.indicators.macd) oscillators.push('macd')
    if (chartPreferences.indicators.stochastic) oscillators.push('stochastic')
    if (chartPreferences.indicators.atr) oscillators.push('atr')
  }

  const toggleScenario = (id: string) => {
    setActiveScenarios((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        // Не даём выключить все — минимум A или хотя бы один
        if (next.size > 1) next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const applyCleanMode = (enabled: boolean) => {
    setCleanMode(enabled)
    if (enabled) {
      setActiveScenarios(new Set(['A']))
      setSessionSettings({ enabled: false })
      setChartPreferences({
        opacity: 16,
        showLabels: false,
        zones: {
          ...chartPreferences.zones,
          fvg: false,
          poc: false,
          valueArea: false,
          fibonacci: false,
          dailyLevels: false,
          orderBlocks: true,
        },
        indicators: {
          ...chartPreferences.indicators,
          ema200: false,
          ema50: false,
          bollingerBands: false,
          rsi: false,
          macd: false,
          stochastic: false,
          atr: false,
        },
      })
    }
  }

  const liveSession = SESSION_DEFINITIONS[getSessionAtHour(new Date().getUTCHours())]
  const liveSessionBg = liveSession.lineColor.replace(
    /rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/,
    'rgba($1, $2, $3, 0.9)'
  )

  const chartHeight = cleanMode ? CHART_HEIGHT_CLEAN : CHART_HEIGHT
  const showSessions = sessionSettings.enabled && !cleanMode
  const showGhost =
    !!signal?.direction &&
    signal.sl != null &&
    signal.tp1 != null &&
    !showForecast &&
    chartReady > 0 &&
    lastCandleTs > 0

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-wider text-holo/40">
            {t('chart_title')}
          </span>
          {sessionSettings.enabled && !cleanMode && (
            <span
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-black"
              style={{ backgroundColor: liveSessionBg }}
              title="Текущая торговая сессия (UTC)"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-black/70" />
              {liveSession.label}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => applyCleanMode(!cleanMode)}
            className={`rounded px-2 py-1 font-mono text-[10px] font-bold uppercase transition-colors ${
              cleanMode
                ? 'border border-matrix/40 bg-matrix/15 text-matrix'
                : 'border border-hull-border text-holo/40 hover:text-holo/70'
            }`}
            title="Чистый режим — меньше слоёв"
          >
            {cleanMode ? t('chart_clean') : t('chart_full')}
          </button>
          {CHART_TIMEFRAMES.map((tf) => (
            <button
              key={tf.id}
              type="button"
              onClick={() => setTimeframe(tf.id)}
              className={`rounded px-2 py-1 font-mono text-xs transition-colors ${
                timeframe === tf.id
                  ? 'border border-matrix/50 bg-matrix/20 text-matrix'
                  : 'border border-transparent text-holo/40 hover:bg-hull-light hover:text-holo/70'
              }`}
            >
              {tf.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setShowForecast(true)
              setForecastHorizon((h: ForecastHorizon) => {
                const order: ForecastHorizon[] = ['SCALP', 'INTRA', 'SWING']
                const idx = order.indexOf(h === 'MACRO' ? 'SWING' : h)
                const next = order[(idx + 1) % order.length]
                if (
                  next === 'SWING' &&
                  (timeframe === '1m' ||
                    timeframe === '5m' ||
                    timeframe === '15m')
                ) {
                  setTimeframe('4h')
                }
                if (
                  next === 'SCALP' &&
                  (timeframe === '4h' || timeframe === '1d')
                ) {
                  setTimeframe('5m')
                }
                return next
              })
            }}
            className={`rounded px-2 py-1 font-mono text-[10px] font-bold uppercase transition-colors ${
              showForecast
                ? forecastHorizon === 'SCALP'
                  ? 'border border-amber-400/50 bg-amber-500/15 text-amber-300'
                  : forecastHorizon === 'SWING' || forecastHorizon === 'MACRO'
                    ? 'border border-cyan-400/50 bg-cyan-500/15 text-cyan-300'
                    : 'border border-matrix/50 bg-matrix/15 text-matrix'
                : 'border border-hull-border text-holo/40 hover:text-holo/70'
            }`}
            title="Горизонт прогноза: SCALP → INTRA → SWING"
          >
            {forecastHorizon === 'MACRO'
              ? 'SWING'
              : forecastHorizon}
          </button>
          <button
            type="button"
            onClick={() => {
              if (zonesMode) {
                setZonesMode(false)
                setFoundChartZones([])
                setFoundZones([])
                haptic.impact()
                return
              }
              void handleFindZones()
            }}
            className={`rounded px-2 py-1 font-mono text-[10px] font-bold uppercase transition-colors ${
              zonesMode
                ? 'border border-emerald-400/50 bg-emerald-500/15 text-emerald-300'
                : 'border border-hull-border text-holo/40 hover:text-holo/70'
            }`}
            title="Найти зоны ликвидности LONG/SHORT и следить для ювелирного входа"
          >
            Зоны{foundZones.length > 0 ? ` · ${foundZones.length}` : ''}
          </button>
          <button
            type="button"
            onClick={handlePickSetups}
            className={`rounded px-2 py-1 font-mono text-[10px] font-bold uppercase transition-colors ${
              showSetupPicker
                ? 'border border-matrix/50 bg-matrix/15 text-matrix'
                : 'border border-hull-border text-holo/40 hover:text-holo/70'
            }`}
            title="Подобрать условные сетапы"
          >
            Сетапы
          </button>
          <button
            type="button"
            onClick={() => setShowForecast((v) => !v)}
            className={`rounded-lg p-1.5 transition-colors ${
              showForecast
                ? 'bg-holo/20 text-holo'
                : 'bg-hull-light/40 text-holo/60 hover:bg-hull-light/70 hover:text-holo'
            }`}
            title={t('forecast_toggle')}
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg bg-hull-light/40 p-1.5 text-holo/60 transition-colors hover:bg-hull-light/70 hover:text-holo"
            title={t('chart_settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        className="relative w-full overflow-hidden rounded-lg border border-hull-border bg-hull"
        style={{ height: chartHeight, touchAction: 'pan-x pinch-zoom' }}
        onTouchStart={(e) => e.stopPropagation()}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-hull/60 font-mono text-xs text-holo/40">
            {t('chart_loading')}
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center font-mono text-xs text-alert/80">
            {error}
          </div>
        )}
        <div
          ref={containerRef}
          className="h-full w-full"
          style={{ touchAction: 'pan-x pinch-zoom' }}
        />
        {globalFib && (
          <button
            type="button"
            onClick={() => setFibPanelOpen((v) => !v)}
            className={`absolute left-2 top-2 z-20 max-w-[68%] rounded border bg-black/75 px-2 py-1 text-left font-mono text-[9px] shadow-lg ${
              globalFib.in141 || globalFib.near141
                ? 'border-amber-400/50 text-amber-200'
                : 'border-amber-400/25 text-amber-100/80'
            }`}
          >
            <span className="font-bold text-amber-300">
              FIB {globalFib.impulse === 'UP' ? '↑' : '↓'}
            </span>
            {' · '}
            <span>
              →{globalFib.entryBias ?? '—'} · 141{' '}
              {globalFib.price141?.toPrecision(5) ?? '—'}
            </span>
            {fibPanelOpen && (
              <span className="mt-0.5 block text-[8px] leading-snug text-holo/50">
                H {globalFib.swingHigh.toPrecision(5)} · L{' '}
                {globalFib.swingLow.toPrecision(5)} · от последнего свинга
                {globalFib.distTo141Pct != null && (
                  <>
                    {' · Δ'}
                    {globalFib.distTo141Pct >= 0 ? '+' : ''}
                    {globalFib.distTo141Pct.toFixed(1)}%
                  </>
                )}
              </span>
            )}
          </button>
        )}
        {chartReady > 0 && showSessions && (
          <SessionOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            sessions={sessions}
            weekends={weekends}
            news={news}
            settings={sessionSettings}
            timeframe={timeframe}
          />
        )}
        {liquidityZones.length > 0 && chartReady > 0 && (
          <ChartOverlay
            chart={chartRef.current}
            series={candleRef.current}
            zones={liquidityZones}
            containerRef={containerRef}
            opacity={chartPreferences.opacity}
            showLabels={chartPreferences.showLabels}
          />
        )}
        {showForecast && forecast && chartReady > 0 && (
          <PredictionOverlay
            chart={chartRef.current}
            series={candleRef.current}
            forecast={forecast}
            activeScenarios={activeScenarios}
            containerRef={containerRef}
          />
        )}
        {showGhost && (
          <GhostPathOverlay
            chart={chartRef.current}
            series={candleRef.current}
            signal={signal}
            candles={candles}
            containerRef={containerRef}
            lastCandleTs={lastCandleTs}
          />
        )}
      </div>

      {chartPreferences.indicators.volume && indicators.volume.length > 0 && (
        <VolumePanel volumeData={indicators.volume} height={cleanMode ? 40 : 50} />
      )}

      {oscillators.map((mode) => (
        <OscillatorPanel
          key={mode}
          mode={mode}
          rsiData={indicators.rsi}
          macdData={indicators.macd}
          stochasticData={indicators.stochastic}
          atrData={indicators.atr}
          height={60}
        />
      ))}

      {!cleanMode && (
        <MultiTFPanel alignment={alignment} isLoading={mtfLoading} />
      )}

      {showForecast && forecast && (
        <>
          <ScenarioLegend
            scenarios={forecast.scenarios}
            dominantId={forecast.dominantScenario}
            activeScenarios={activeScenarios}
            onToggle={toggleScenario}
            updatedAt={forecast.generatedAt}
            horizon={forecast.horizon}
          />
          {(forecastHorizon === 'MACRO' || forecastHorizon === 'SWING') && (
            <MacroOutlookPanel
              summary={forecast.macroSummary}
              scenarios={forecast.scenarios}
              macro={macroCtx}
            />
          )}
        </>
      )}

      {showSetupPicker && (
        <SetupPickerPanel
          setups={pickedSetups}
          selectedId={selectedSetupId}
          watchingIds={watchingIds}
          busy={watchBusy}
          onSelect={(s) => {
            setSelectedSetupId(s.id)
            haptic.impact()
          }}
          onWatch={handleWatchSetup}
          onUnwatch={handleUnwatchSetup}
        />
      )}

      <ChartSettings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

export default LiveChart
