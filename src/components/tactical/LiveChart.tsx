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
import { Settings, Eye, Maximize2, Minimize2, ArrowUpDown, MessageSquare } from 'lucide-react'
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
import {
  usePriceForecast,
  quantizeBookImbalance,
} from '../../hooks/usePriceForecast'
import ChartSettings from './ChartSettings'
import ChartOverlay from './ChartOverlay'
import DirectionArrowOverlay from './DirectionArrowOverlay'
import { computeDirectionConsensus } from '../../engine/trend/directionConsensus'
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
import { findProbableTrades, findLiveSignal } from '../../engine/trades'
import { recordSequenceHit } from '../../engine/sequence'
import type { LiveSignalResult } from '../../engine/trades'
import {
  pushJewelEntryAlert,
  pushProbableTradesAck,
  pushZoneWatchAck,
} from '../../api/telegram/formatters'
import ZonePathOverlay from './ZonePathOverlay'
import ZoneVariantsPanel from './ZoneVariantsPanel'
import ProbableTradesPanel from './ProbableTradesPanel'
import SignalNowPanel from './SignalNowPanel'
import { buildGlobalFibonacci } from '../../engine/zones/globalFibonacci'
import { horizonToStyle } from '../../engine/zones/horizonProfiles'
import type { ForecastHorizon } from '../../engine/prediction/macroOutlook'
import { buildMacroContext } from '../../engine/prediction/macroOutlook'
import {
  buildConditionalSetups,
  type ConditionalSetup,
  type TradeGlobalView,
  type TradeMagnet,
} from '../../engine/setups'
import {
  createWatchedSetup,
  createWatchedSetupsBatch,
  removeWatchedSetup,
  isTelegramAlertsConfigured,
  subscribeTelegramAlerts,
} from '../../api/telegram/alerts'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import WhaleLevelsOverlay from './WhaleLevelsOverlay'
import SequenceProcessOverlay from './SequenceProcessOverlay'
import ProcessStrip from './ProcessStrip'
import ChartHintsOverlay from './ChartHintsOverlay'
import DeltaSparkline from './DeltaSparkline'

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

const CHART_HEIGHT = 440
const CHART_HEIGHT_EXPANDED = () =>
  Math.min(Math.round(window.innerHeight * 0.84), 820)

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
  const whaleState = useAppStore((s) => s.whaleWatcher[symbol] ?? null)
  const sequenceHit = useAppStore((s) => s.sequenceHits[symbol] ?? null)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const priceLineRefs = useRef<IPriceLine[]>([])
  const liqLineRefs = useRef<IPriceLine[]>([])
  /** Skip fitContent after first successful load for this symbol/tf */
  const fittedKeyRef = useRef<string>('')
  const userPanningRef = useRef(false)
  const chartHeightRef = useRef(CHART_HEIGHT)

  const [timeframe, setTimeframe] = useState<MexcTimeframe>('1h')
  const [chartExpanded, setChartExpanded] = useState(false)
  const [showDirection, setShowDirection] = useState(true)
  const [showHints, setShowHints] = useState(false)
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
  const [tradesMode, setTradesMode] = useState(false)
  const [signalMode, setSignalMode] = useState(false)
  const [liveSignal, setLiveSignal] = useState<LiveSignalResult | null>(null)
  const [tradesGlobalView, setTradesGlobalView] =
    useState<TradeGlobalView | null>(null)
  const [tradesMagnet, setTradesMagnet] = useState<TradeMagnet | null>(null)
  const jewelSentRef = useRef<Set<string>>(new Set())

  const chartHeight = chartExpanded ? CHART_HEIGHT_EXPANDED() : CHART_HEIGHT
  chartHeightRef.current = chartHeight

  useEffect(() => {
    chartRef.current?.applyOptions({
      height: chartHeight,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: chartExpanded,
      },
      crosshair: { mode: chartExpanded ? 1 : 0 },
      timeScale: { rightOffset: chartExpanded ? 12 : 6 },
    })
  }, [chartHeight, chartExpanded])

  useEffect(() => {
    if (!chartExpanded) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChartExpanded(false)
    }
    const onResize = () => {
      const h = CHART_HEIGHT_EXPANDED()
      chartHeightRef.current = h
      chartRef.current?.applyOptions({ height: h })
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [chartExpanded])

  const watchedSetups = useAppStore((s) => s.watchedSetups)
  const upsertWatchedSetup = useAppStore((s) => s.upsertWatchedSetup)
  const removeWatchedSetupLocal = useAppStore((s) => s.removeWatchedSetupLocal)
  const telegramSettings = useAppStore((s) => s.telegramAlertSettings)
  const { showAlert, haptic, userId } = useTelegramWebApp()

  const currentPrice = ticker?.price ?? signal?.price ?? 0
  const liveBookImbalance =
    orderBookMetrics != null ? orderBookMetrics.imbalance / 100 : null
  /** 5% OBI buckets — forecast ignores sub-bucket noise */
  const bookForForecast = quantizeBookImbalance(liveBookImbalance, 0.05)
  const btcRs = signal?.btcDivergence?.relativeStrength ?? null
  const mmFromStore = useAppStore((s) => s.mmIntent[symbol] ?? null)
  const mmSnap = signal?.mmIntent ?? mmFromStore
  const mmHunt = useMemo(() => {
    if (!mmSnap) return null
    return {
      microTarget: mmSnap.hunt.microTarget,
      macroTarget: mmSnap.hunt.macroTarget,
      microIsStopHunt: mmSnap.hunt.microIsStopHunt,
      preferredSide: mmSnap.preferredSide,
    }
  }, [
    mmSnap?.hunt.microTarget,
    mmSnap?.hunt.macroTarget,
    mmSnap?.hunt.microIsStopHunt,
    mmSnap?.preferredSide,
  ])
  // Soft refresh: new candle window / OBI bucket / MM update — not every book tick
  const forecastRefreshKey =
    Math.round((ticker?.timestamp ?? 0) / 30_000) +
    Math.round((orderBookMetrics?.imbalance ?? 0) / 5) +
    (mmSnap?.updatedAt ? Math.round(mmSnap.updatedAt / 30_000) : 0)

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

  const {
    alignment,
    liquidityMap,
    candles1d,
    candles1h,
    isLoading: mtfLoading,
  } = useMultiTFAnalysis(symbol, currentPrice, true)

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
    bookForForecast,
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
    // Mini App: Telegram user id is the chat id
    if (userId) return userId
    const manual = telegramSettings.manualChatId.trim()
    if (manual && /^-?\d+$/.test(manual)) return Number(manual)
    if (telegramSettings.subscribedChatId) return telegramSettings.subscribedChatId
    return null
  }, [userId, telegramSettings])

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
    setZonesMode(false)
    setTradesMode(false)
    setTradesGlobalView(null)
    setTradesMagnet(null)
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
    const tradeStyle = horizonToStyle(forecastHorizon)
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
      tradeStyle,
    })
    setFoundZones(result.zones)
    setFoundChartZones(result.chartZones)
    setZonesMode(true)
    setTradesMode(false)
    setTradesGlobalView(null)
    setTradesMagnet(null)
    setLiquidityMap(symbol, result.liquidityMap)
    setPickedSetups(result.setups)
    setShowSetupPicker(true)
    setShowForecast(true)
    if (result.setups[0]) setSelectedSetupId(result.setups[0].id)
    haptic.success()

    const chatId = resolveChatId()
    const autoWatch = result.setups.slice(0, 6)

    if (!isTelegramAlertsConfigured()) {
      showAlert('Прокси бота не настроен (VITE_MEXC_PROXY_URL)')
    } else if (!chatId) {
      showAlert('Нет chatId — открой Mini App из Telegram или /start у бота и колокольчик')
    } else {
      // Ensure subscriber exists, then send watch-ack
      try {
        await subscribeTelegramAlerts({
          chatId,
          sniper: telegramSettings.sniper !== false,
          meme: telegramSettings.meme !== false,
        })
      } catch {
        /* subscribe best-effort */
      }

      const ack = await pushZoneWatchAck({
        symbol: flatSymbol,
        displayName: signal?.displayName,
        price: currentPrice,
        zones: result.zones.map((z) => ({
          side: z.side,
          label: z.label,
          mid: z.mid,
          limitEntry: z.limitEntry,
          target: z.target,
          invalidation: z.invalidation,
        })),
        setupsCount: result.setups.length,
        chatId,
      })

      if (!ack.ok) {
        const hint =
          ack.reason === 'secret_missing_in_app' ||
          ack.reason === 'secret_mismatch'
            ? 'ALERT_SECRET: в Pages нет VITE_ALERT_SECRET или он не совпадает с worker'
            : ack.reason === 'need_start' || ack.reason === 'tg_send_failed'
              ? 'Напиши боту /start, потом снова «Зоны»'
              : ack.reason === 'network'
                ? 'Нет связи с worker (VITE_MEXC_PROXY_URL)'
                : ack.reason === 'no_chat_id'
                  ? 'Нет chatId — открой Mini App из Telegram'
                  : `Не удалось отправить в бот (${ack.reason ?? 'error'})`
        showAlert(hint)
      }
    }

    let serverWatches = 0
    if (chatId && isTelegramAlertsConfigured() && autoWatch.length > 0) {
      try {
        const watches = await createWatchedSetupsBatch({
          chatId,
          setups: autoWatch,
          symbol: flatSymbol,
          internalSymbol: symbol,
          ttlHours: 48,
        })
        serverWatches = watches.length
        for (const watch of watches) upsertWatchedSetup(watch)
      } catch {
        /* fall through to local */
      }
      if (serverWatches === 0) {
        for (const setup of autoWatch) {
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
        showAlert(
          'Зоны на экране, но серверный мониторинг не включился — проверь /start и снова «Зоны»'
        )
      }
    } else if (chatId && autoWatch.length > 0) {
      for (const setup of autoWatch) {
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
    const styleTag =
      tradeStyle === 'SCALP' ? '#SCALP' : tradeStyle === 'SWING' ? '#SWING' : '#INTRA'
    if (chatId && isTelegramAlertsConfigured()) {
      showAlert(
        serverWatches > 0
          ? `👁 ${styleTag}: ${serverWatches} сетапов на сервере · жди 💎`
          : `${styleTag} зоны: ${result.zones.length} · мониторинг бота не активен`
      )
    } else if (!chatId) {
      /* already alerted above */
    } else {
      showAlert(
        `${styleTag} зоны: ${result.zones.length}` +
          (longZ ? ` · LONG @ ${longZ.mid.toPrecision(5)}` : '') +
          (shortZ ? ` · SHORT @ ${shortZ.mid.toPrecision(5)}` : '')
      )
    }
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
    telegramSettings.sniper,
    telegramSettings.meme,
    forecastHorizon,
  ])

  const handleFindProbableTrades = useCallback(async () => {
    if (!(currentPrice > 0) || candles.length < 20) {
      showAlert('Нужны свечи и цена — подождите загрузку графика')
      return
    }
    jewelSentRef.current = new Set()
    setZonesMode(false)

    const tradeStyle = horizonToStyle(forecastHorizon)
    const result = findProbableTrades({
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
      fearGreed: fearGreedValue,
      maxTrades: 8,
      tradeStyle,
    })

    setFoundZones(result.zones)
    setFoundChartZones(result.chartZones)
    setTradesMode(true)
    setTradesGlobalView(result.globalView)
    setTradesMagnet(result.magnet)
    setLiquidityMap(symbol, result.liquidityMap)
    setPickedSetups(result.trades)
    setShowSetupPicker(true)
    setShowForecast(true)
    if (result.trades[0]) setSelectedSetupId(result.trades[0].id)
    haptic.success()

    const chatId = resolveChatId()
    const autoWatch = result.trades.slice(0, 6)

    if (!isTelegramAlertsConfigured()) {
      showAlert('Прокси бота не настроен (VITE_MEXC_PROXY_URL)')
    } else if (!chatId) {
      showAlert('Нет chatId — открой Mini App из Telegram или /start у бота')
    } else {
      try {
        await subscribeTelegramAlerts({
          chatId,
          sniper: telegramSettings.sniper !== false,
          meme: telegramSettings.meme !== false,
        })
      } catch {
        /* best-effort */
      }

      const ack = await pushProbableTradesAck({
        symbol: flatSymbol,
        displayName: signal?.displayName,
        price: currentPrice,
        globalBias: result.globalView.bias,
        globalSummary: result.globalView.summary,
        magnetLabel: result.magnet?.label,
        magnetPrice: result.magnet?.price,
        trades: result.trades.map((t) => ({
          side: t.side,
          title: t.title,
          probability: t.probability,
          limitEntry: t.limitEntry,
          invalidation: t.invalidation,
          r1: t.targetsLadder?.r1 ?? t.target,
          r2: t.targetsLadder?.r2 ?? t.target,
          r3: t.targetsLadder?.r3 ?? t.target,
          p1: t.targetsLadder?.pReach1 ?? Math.round(t.probability),
          p2: t.targetsLadder?.pReach2 ?? Math.round(t.probability * 0.55),
          p3: t.targetsLadder?.pReach3 ?? Math.round(t.probability * 0.3),
        })),
        chatId,
      })

      if (!ack.ok) {
        const hint =
          ack.reason === 'need_start' || ack.reason === 'tg_send_failed'
            ? 'Напиши боту /start, потом снова «Сделки»'
            : ack.reason === 'network'
              ? 'Нет связи с worker'
              : `Не удалось отправить в бот (${ack.reason ?? 'error'})`
        showAlert(hint)
      }
    }

    let serverWatches = 0
    if (chatId && isTelegramAlertsConfigured() && autoWatch.length > 0) {
      try {
        const watches = await createWatchedSetupsBatch({
          chatId,
          setups: autoWatch,
          symbol: flatSymbol,
          internalSymbol: symbol,
          ttlHours: 48,
        })
        serverWatches = watches.length
        for (const watch of watches) upsertWatchedSetup(watch)
      } catch {
        /* local fallback */
      }
      if (serverWatches === 0) {
        for (const setup of autoWatch) {
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
        showAlert(
          'Сделки на экране, но серверный мониторинг не включился — /start и снова «Сделки»'
        )
      }
    }

    if (chatId && isTelegramAlertsConfigured() && serverWatches > 0) {
      showAlert(
        `🎲 ${serverWatches} сделок на сервере · ${result.globalView.bias} · магнит ${
          result.magnet ? result.magnet.label : 'R-лестница'
        }`
      )
    } else if (!chatId) {
      /* already alerted */
    } else {
      showAlert(
        `Сделки: ${result.trades.length} · ${result.globalView.bias}` +
          (result.trades[0]
            ? ` · топ ${result.trades[0].side} ~${Math.round(result.trades[0].probability)}%`
            : '')
      )
    }
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
    fearGreedValue,
    setLiquidityMap,
    upsertWatchedSetup,
    showAlert,
    haptic,
    resolveChatId,
    telegramSettings.sniper,
    telegramSettings.meme,
    forecastHorizon,
  ])

  const handleFindLiveSignal = useCallback(() => {
    if (!(currentPrice > 0) || candles.length < 20) {
      showAlert('Нужны свечи и цена — подождите загрузку графика')
      return
    }
    setZonesMode(false)
    setTradesMode(false)

    const tradeStyle = horizonToStyle(forecastHorizon)
    const result = findLiveSignal({
      candles,
      candles1d,
      candles1h,
      symbol,
      flatSymbol,
      price: currentPrice,
      signal,
      mmIntent: mmSnap,
      forecast,
      liquidityMap: eqLiquidityMap,
      bookImbalance: orderBookMetrics?.imbalance ?? null,
      fearGreed: fearGreedValue,
      tradeStyle,
      sequence: sequenceHit,
    })

    setLiveSignal(result)
    setSignalMode(true)
    setFoundZones(result.zones)
    setFoundChartZones(result.chartZones)
    setTradesGlobalView(result.globalView)
    setTradesMagnet(result.magnet)
    setLiquidityMap(symbol, result.liquidityMap)
    setPickedSetups(result.trades)
    setShowSetupPicker(true)
    setShowForecast(true)
    if (result.bestSetup) setSelectedSetupId(result.bestSetup.id)
    else if (result.trades[0]) setSelectedSetupId(result.trades[0].id)
    haptic.success()

    if (result.sequence?.allowedInRegime && result.sequence.confidence >= 58) {
      recordSequenceHit({
        symbol,
        flatSymbol,
        displayName: signal?.displayName,
        price: currentPrice,
        hit: result.sequence,
        sl: result.bestSetup?.invalidation ?? signal?.sl,
        tp1: result.bestSetup?.target ?? signal?.tp1,
      })
    }

    const p = result.primary
    const lm = result.liveMarket
    const seqNote =
      result.sequence && result.sequence.allowedInRegime
        ? `\nSEQ ${result.sequence.kind} ~${result.sequence.confidence}%`
        : ''
    showAlert(
      `Сигнал: ${p.side !== 'FLAT' ? p.side + ' · ' : ''}${p.title} · ~${p.winPct}%\n${
        lm?.whatNow ?? result.phaseLabel
      }${seqNote}`
    )
  }, [
    currentPrice,
    candles,
    candles1d,
    candles1h,
    symbol,
    flatSymbol,
    signal,
    mmSnap,
    forecast,
    eqLiquidityMap,
    orderBookMetrics,
    fearGreedValue,
    setLiquidityMap,
    showAlert,
    haptic,
    forecastHorizon,
    sequenceHit,
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

  const highlightedZoneId = useMemo(() => {
    if (!selectedSetupId) return null
    const cut = selectedSetupId.search(/_(bounce|break)_/i)
    if (cut > 0) return selectedSetupId.slice(0, cut)
    const bySetup = selectedSetup
    if (!bySetup) return null
    const match = foundZones.find(
      (z) =>
        Math.abs(z.mid - (bySetup.limitEntry ?? 0)) / Math.max(z.mid, 1e-9) <
          0.004 ||
        (bySetup.entryZone &&
          Math.abs(
            z.mid - (bySetup.entryZone.top + bySetup.entryZone.bottom) / 2
          ) /
            Math.max(z.mid, 1e-9) <
            0.006)
    )
    return match?.id ?? null
  }, [selectedSetupId, selectedSetup, foundZones])

  const zoneGuide = useMemo(() => {
    if (!foundZones.length || !(currentPrice > 0)) return null
    const below = foundZones
      .filter((z) => z.side === 'LONG' && z.mid <= currentPrice * 1.002)
      .sort((a, b) => b.mid - a.mid)[0]
    const above = foundZones
      .filter((z) => z.side === 'SHORT' && z.mid >= currentPrice * 0.998)
      .sort((a, b) => a.mid - b.mid)[0]
    return { below, above }
  }, [foundZones, currentPrice])

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
        background: { color: '#0c0e12' },
        textColor: 'rgba(220, 230, 240, 0.55)',
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.045)' },
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: 'rgba(148, 163, 184, 0.35)',
          width: 1,
          style: 2,
          labelBackgroundColor: '#1e293b',
        },
        horzLine: {
          color: 'rgba(148, 163, 184, 0.35)',
          width: 1,
          style: 2,
          labelBackgroundColor: '#1e293b',
        },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 7,
        minBarSpacing: 3,
        lockVisibleTimeRangeOnResize: true,
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        scaleMargins: { top: 0.08, bottom: 0.1 },
        autoScale: true,
        entireTextOnly: true,
      },
      width: containerRef.current.clientWidth,
      height: chartHeightRef.current,
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
        axisDoubleClickReset: true,
      },
      kineticScroll: {
        touch: true,
        mouse: false,
      },
    })

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#f43f5e',
      borderUpColor: '#16a34a',
      borderDownColor: '#e11d48',
      wickUpColor: 'rgba(34, 197, 94, 0.7)',
      wickDownColor: 'rgba(244, 63, 94, 0.7)',
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: 'rgba(148, 163, 184, 0.4)',
      priceLineWidth: 1,
      priceLineStyle: 2,
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
      const w = Math.floor(entries[0].contentRect.width)
      if (w <= 0) return
      if (userPanningRef.current) return
      // Width from RO; height from expand / compact mode
      chart.applyOptions({
        width: w,
        height: chartHeightRef.current,
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

    // Selected zone setup: где слом / куда цель
    if (selectedSetup) {
      if (selectedSetup.limitEntry > 0) {
        addLine(
          selectedSetup.limitEntry,
          'rgba(56, 189, 248, 0.95)',
          `вход ${fmt(selectedSetup.limitEntry)}`,
          { lineStyle: 0, lineWidth: 2, axisLabel: true }
        )
      }
      if (selectedSetup.invalidation > 0) {
        addLine(
          selectedSetup.invalidation,
          'rgba(251, 113, 133, 0.95)',
          `слом ${fmt(selectedSetup.invalidation)}`,
          { lineStyle: 1, lineWidth: 2, axisLabel: true }
        )
      }
      if (selectedSetup.target > 0) {
        addLine(
          selectedSetup.target,
          'rgba(45, 212, 191, 0.95)',
          `цель ${fmt(selectedSetup.target)}`,
          { lineStyle: 2, lineWidth: 2, axisLabel: true }
        )
      }
    }
  }, [
    priceLevels,
    chartPreferences.showLabels,
    chartReady,
    lwcData,
    signal,
    cleanMode,
    selectedSetup,
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
      // Align with zone bands: BSL rose / SSL teal; alpha by strength
      const colorMap = {
        STRONG: isBSL ? 'rgba(251, 113, 133, 0.95)' : 'rgba(45, 212, 191, 0.95)',
        MEDIUM: isBSL ? 'rgba(251, 113, 133, 0.65)' : 'rgba(45, 212, 191, 0.65)',
        WEAK: isBSL ? 'rgba(251, 113, 133, 0.35)' : 'rgba(45, 212, 191, 0.35)',
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
      const hold = isBSL ? 'удерж↓' : 'удерж↑'
      const touchLabel = `×${level.touches}`
      const distLabel = `${level.distancePct.toFixed(1)}%`
      const title =
        chartPreferences.showLabels || zonesMode
          ? `${typeLabel} ${hold} ${touchLabel} ${distLabel}`
          : ''

      try {
        const line = series.createPriceLine({
          price: level.price,
          color,
          lineWidth: level.strength === 'STRONG' ? 2 : 1,
          lineStyle,
          axisLabelVisible: chartPreferences.showLabels || zonesMode,
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
  }, [
    eqLiquidityMap,
    chartPreferences.showLabels,
    chartReady,
    lwcData,
    cleanMode,
    zonesMode,
  ])

  /** Candle span for whale overlay — ignore book levels that would distort view */
  const candlePriceSpan = useMemo(() => {
    if (!lwcData.length) return { floor: 0, ceil: 0 }
    let floor = Number.POSITIVE_INFINITY
    let ceil = 0
    for (const c of lwcData) {
      if (c.low < floor) floor = c.low
      if (c.high > ceil) ceil = c.high
    }
    return { floor, ceil }
  }, [lwcData])

  const resetChartView = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.priceScale('right').applyOptions({ autoScale: true })
    chart.timeScale().fitContent()
    haptic.impact()
  }, [haptic])

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

  const showSessions = sessionSettings.enabled && !cleanMode
  /** Zones / Сделки / Сигнал draw their own chartPath — hide A/B/C to avoid double story */
  const pathModeActive = zonesMode || tradesMode || signalMode
  const showPredictionPaths = showForecast && !pathModeActive
  const showGhost =
    !!signal?.direction &&
    signal.sl != null &&
    signal.tp1 != null &&
    !showForecast &&
    !pathModeActive &&
    chartReady > 0 &&
    lastCandleTs > 0

  const directionConsensus = useMemo(
    () =>
      computeDirectionConsensus({
        signal,
        forecast:
          forecast && forecast.scenarios.length > 0 ? forecast : null,
        alignment,
        bookImbalance: bookForForecast,
        newsBias,
        timeframe,
      }),
    [
      signal,
      forecast,
      alignment,
      bookForForecast,
      newsBias,
      timeframe,
    ]
  )

  const chartRegime = signal?.marketRegime ?? 'RANGING'
  const toolsBounceOk =
    chartRegime === 'RANGING' || chartRegime === 'TRENDING_WEAK'
  const toolsTrendOk =
    chartRegime === 'TRENDING_STRONG' || chartRegime === 'TRENDING_WEAK'
  const toolsChop = chartRegime === 'VOLATILE_CHOP'
  const activeSequence =
    sequenceHit && sequenceHit.expiresAt > Date.now() ? sequenceHit : null
  const processRefreshKey =
    (sequenceHit?.detectedAt ?? 0) +
    Math.round((ticker?.timestamp ?? 0) / 15_000)

  return (
    <div
      className={
        chartExpanded
          ? 'fixed inset-0 z-[80] flex flex-col gap-2 overflow-y-auto bg-[#0a0a0a]/p-2 pb-4'
          : 'space-y-2'
      }
    >
      {chartExpanded && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-hull-border bg-hull px-3 py-2">
          <div className="min-w-0 font-mono text-[11px] font-bold uppercase tracking-wider text-holo/80">
            {flatSymbol.replace('USDT', '/USDT')} · {timeframe}
            {showDirection && (
              <span
                className={`ml-2 ${
                  directionConsensus.bias === 'UP'
                    ? 'text-emerald-400'
                    : directionConsensus.bias === 'DOWN'
                      ? 'text-rose-400'
                      : 'text-holo/40'
                }`}
              >
                {directionConsensus.bias === 'UP'
                  ? '↑'
                  : directionConsensus.bias === 'DOWN'
                    ? '↓'
                    : '·'}{' '}
                {directionConsensus.confidence}%
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setChartExpanded(false)
              haptic.impact()
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-matrix/40 bg-matrix/15 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase text-matrix"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            Свернуть
          </button>
        </div>
      )}
      {/* Process strip — regime · OI · film · active SEQ */}
      <ProcessStrip
        symbol={symbol}
        regime={chartRegime}
        sequence={activeSequence}
        refreshKey={processRefreshKey}
      />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-wider text-holo/50">
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
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setShowHints((v) => !v)
              haptic.impact()
            }}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] font-bold uppercase transition-colors ${
              showHints
                ? 'border-cyan-400/45 bg-cyan-500/20 text-cyan-200'
                : 'border-white/10 bg-hull-light/40 text-holo/55 hover:text-holo'
            }`}
            title="Подсказки процесса на графике"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Подсказки</span>
            <span className="rounded bg-black/25 px-1 py-px text-[8px] opacity-80">
              {showHints ? 'ON' : 'OFF'}
            </span>
          </button>
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
          <button
            type="button"
            onClick={() => {
              setChartExpanded((v) => !v)
              haptic.impact()
            }}
            className={`rounded-lg p-1.5 transition-colors ${
              chartExpanded
                ? 'bg-matrix/20 text-matrix'
                : 'bg-hull-light/40 text-holo/60 hover:bg-hull-light/70 hover:text-holo'
            }`}
            title={chartExpanded ? 'Свернуть график' : 'Развернуть как на бирже'}
          >
            {chartExpanded ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
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

      {/* Tool rail — ТФ + режиссёрский набор */}
      <div className="-mx-1 space-y-1 px-1">
        <div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-white/[0.08] bg-[#10141a] p-0.5">
            {CHART_TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                type="button"
                onClick={() => setTimeframe(tf.id)}
                className={`rounded-md px-2.5 py-1.5 font-mono text-[11px] font-semibold transition-colors ${
                  timeframe === tf.id
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'text-white/40 hover:text-white/70'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={resetChartView}
            className="shrink-0 rounded-lg border border-white/[0.08] bg-[#10141a] px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase text-white/45 hover:text-white/75"
            title="Сбросить масштаб"
          >
            Fit
          </button>
          <button
            id="live-signal-cta"
            type="button"
            onClick={() => {
              if (signalMode) {
                setSignalMode(false)
                setLiveSignal(null)
                haptic.impact()
                return
              }
              handleFindLiveSignal()
            }}
            className={`shrink-0 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase ${
              signalMode
                ? 'border-amber-400/50 bg-amber-500/20 text-amber-100'
                : 'border-amber-400/30 bg-amber-500/10 text-amber-200/80'
            }`}
          >
            {signalMode ? 'Сигнал ON' : 'Сигнал'}
          </button>
        </div>
        <div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-white/[0.08] bg-[#10141a] p-0.5">
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
              className={`rounded-md px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
                showForecast
                  ? forecastHorizon === 'SCALP'
                    ? 'bg-amber-500/20 text-amber-300'
                    : forecastHorizon === 'SWING' || forecastHorizon === 'MACRO'
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'bg-emerald-500/15 text-emerald-300'
                  : 'text-white/35'
              }`}
              title="Горизонт: SCALP → INTRA → SWING"
            >
              {forecastHorizon === 'MACRO' ? 'SWING' : forecastHorizon}
            </button>
            <button
              type="button"
              disabled={toolsChop}
              onClick={() => {
                if (zonesMode) {
                  setZonesMode(false)
                  setFoundChartZones([])
                  setFoundZones([])
                  haptic.impact()
                  return
                }
                setSignalMode(false)
                setLiveSignal(null)
                void handleFindZones()
              }}
              className={`rounded-md px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
                zonesMode
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : toolsBounceOk && !toolsChop
                    ? 'text-white/55 hover:text-white/80'
                    : 'text-white/20'
              }`}
              title={
                toolsChop
                  ? 'CHOP — зоны отключены'
                  : 'Зоны лучше в RANGE / слабом тренде'
              }
            >
              Зоны{foundZones.length > 0 && zonesMode ? ` ${foundZones.length}` : ''}
            </button>
            <button
              type="button"
              disabled={toolsChop || !toolsTrendOk}
              onClick={() => {
                if (tradesMode) {
                  setTradesMode(false)
                  setTradesGlobalView(null)
                  setTradesMagnet(null)
                  setPickedSetups([])
                  setShowSetupPicker(false)
                  haptic.impact()
                  return
                }
                setSignalMode(false)
                setLiveSignal(null)
                void handleFindProbableTrades()
              }}
              className={`rounded-md px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
                tradesMode
                  ? 'bg-sky-500/20 text-sky-300'
                  : toolsTrendOk && !toolsChop
                    ? 'text-white/55 hover:text-white/80'
                    : 'text-white/20'
              }`}
              title={
                !toolsTrendOk || toolsChop
                  ? 'Сделки — для трендового режима'
                  : 'Вероятные сделки'
              }
            >
              Сделки
            </button>
            <button
              type="button"
              onClick={() => {
                setSignalMode(false)
                setLiveSignal(null)
                handlePickSetups()
              }}
              className={`rounded-md px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
                showSetupPicker && !zonesMode && !tradesMode && !signalMode
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'text-white/35 hover:text-white/70'
              }`}
            >
              Сетапы
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-white/[0.08] bg-[#10141a] p-0.5">
            <button
              type="button"
              onClick={() => setShowDirection((v) => !v)}
              className={`rounded-md px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
                showDirection
                  ? 'bg-violet-500/20 text-violet-300'
                  : 'text-white/35'
              }`}
              title="Стрелка направления"
            >
              <ArrowUpDown className="inline h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() =>
                setChartPreferences({
                  showLabels: !chartPreferences.showLabels,
                })
              }
              className={`rounded-md px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
                chartPreferences.showLabels
                  ? 'bg-white/15 text-white'
                  : 'text-white/35'
              }`}
              title="Подписи уровней"
            >
              <Eye className="inline h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div
        className={`relative w-full overflow-hidden rounded-xl border border-white/[0.08] bg-[#0c0e12] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${
          chartExpanded ? 'ring-1 ring-emerald-500/30' : ''
        }`}
        style={{
          height: chartHeight,
          touchAction: chartExpanded ? 'none' : 'pan-x pinch-zoom',
        }}
        onTouchStart={(e) => e.stopPropagation()}
        onDoubleClick={resetChartView}
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
            opacity={Math.max(
              chartPreferences.opacity,
              zonesMode ? 32 : 20
            )}
            showLabels={chartPreferences.showLabels || zonesMode || chartExpanded}
            highlightId={highlightedZoneId}
            forceContextLabels={
              zonesMode || chartExpanded || Boolean(highlightedZoneId)
            }
          />
        )}
        {chartReady > 0 && (
          <WhaleLevelsOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            whaleState={whaleState}
            priceFloor={candlePriceSpan.floor}
            priceCeil={candlePriceSpan.ceil}
          />
        )}
        {chartReady > 0 && (
          <SequenceProcessOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            sequence={
              (signalMode && liveSignal?.sequence) || activeSequence
            }
          />
        )}
        {chartReady > 0 && (
          <ChartHintsOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            visible={showHints}
            symbol={symbol}
            price={currentPrice}
            regime={chartRegime}
            sequence={
              (signalMode && liveSignal?.sequence) || activeSequence
            }
            whale={whaleState}
            liveSignal={signalMode ? liveSignal : null}
            bookImbalance={orderBookMetrics?.imbalance ?? null}
            refreshKey={processRefreshKey}
          />
        )}
        {showDirection &&
          chartReady > 0 &&
          lastCandleTs > 0 &&
          currentPrice > 0 && (
            <DirectionArrowOverlay
              chart={chartInstance}
              series={candleRef.current}
              containerRef={containerRef}
              consensus={directionConsensus}
              lastTime={lastCandleTs}
              lastPrice={currentPrice}
              visible={showDirection}
            />
          )}
        {zonesMode &&
          chartReady > 0 &&
          (zoneGuide?.below || zoneGuide?.above) && (
            <div className="pointer-events-none absolute right-2 top-12 z-[3] flex max-w-[58%] flex-col gap-1.5">
              {zoneGuide?.below && (
                <div className="rounded-md border border-teal-400/45 bg-black/70 px-2 py-1 font-mono text-[9px] text-teal-200 shadow-lg backdrop-blur-sm">
                  <span className="font-bold">▼ ПОДДЕРЖКА · лонг ↑</span>
                  <span className="text-teal-100/80">
                    {' '}
                    @{' '}
                    {zoneGuide.below.mid >= 1
                      ? zoneGuide.below.mid.toFixed(4)
                      : zoneGuide.below.mid.toPrecision(5)}
                  </span>
                  <span className="block text-[8px] text-teal-100/55">
                    слом &lt;{' '}
                    {zoneGuide.below.invalidation >= 1
                      ? zoneGuide.below.invalidation.toFixed(4)
                      : zoneGuide.below.invalidation.toPrecision(5)}{' '}
                    · цель{' '}
                    {zoneGuide.below.target >= 1
                      ? zoneGuide.below.target.toFixed(4)
                      : zoneGuide.below.target.toPrecision(5)}
                  </span>
                </div>
              )}
              {zoneGuide?.above && (
                <div className="rounded-md border border-rose-400/45 bg-black/70 px-2 py-1 font-mono text-[9px] text-rose-200 shadow-lg backdrop-blur-sm">
                  <span className="font-bold">▲ СОПРОТИВЛЕНИЕ · шорт ↓</span>
                  <span className="text-rose-100/80">
                    {' '}
                    @{' '}
                    {zoneGuide.above.mid >= 1
                      ? zoneGuide.above.mid.toFixed(4)
                      : zoneGuide.above.mid.toPrecision(5)}
                  </span>
                  <span className="block text-[8px] text-rose-100/55">
                    слом &gt;{' '}
                    {zoneGuide.above.invalidation >= 1
                      ? zoneGuide.above.invalidation.toFixed(4)
                      : zoneGuide.above.invalidation.toPrecision(5)}{' '}
                    · цель{' '}
                    {zoneGuide.above.target >= 1
                      ? zoneGuide.above.target.toFixed(4)
                      : zoneGuide.above.target.toPrecision(5)}
                  </span>
                </div>
              )}
              <div className="rounded-md border border-white/10 bg-black/50 px-2 py-1 font-mono text-[8px] text-white/45">
                ●●● сильная · ●● средняя · тусклая = слабая
              </div>
            </div>
          )}
        {showPredictionPaths && forecast && chartReady > 0 && (
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
        {pathModeActive &&
          pickedSetups.some((s) => s.chartPath?.length) &&
          chartReady > 0 && (
          <ZonePathOverlay
            chart={chartRef.current}
            series={candleRef.current}
            setups={pickedSetups}
            selectedId={selectedSetupId}
            lastCandleTs={
              lastCandleTs || Math.floor(Date.now() / 1000)
            }
            containerRef={containerRef}
          />
        )}
      </div>

      <DeltaSparkline
        symbol={symbol}
        refreshKey={processRefreshKey}
        height={chartExpanded ? 44 : 32}
      />

      {chartPreferences.indicators.volume &&
        indicators.volume.length > 0 && (
          <VolumePanel volumeData={indicators.volume} height={chartExpanded ? 56 : 44} />
        )}

      {!chartExpanded &&
        oscillators.map((mode) => (
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

      {chartExpanded && oscillators.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {oscillators.map((mode) => (
            <OscillatorPanel
              key={mode}
              mode={mode}
              rsiData={indicators.rsi}
              macdData={indicators.macd}
              stochasticData={indicators.stochastic}
              atrData={indicators.atr}
              height={72}
            />
          ))}
        </div>
      )}

      {!chartExpanded && !cleanMode && (
        <MultiTFPanel alignment={alignment} isLoading={mtfLoading} />
      )}

      {!chartExpanded && showPredictionPaths && forecast && (
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

      {!chartExpanded && signalMode && liveSignal && (
        <SignalNowPanel
          result={liveSignal}
          selectedId={selectedSetupId}
          watchingIds={watchingIds}
          busy={watchBusy}
          onSelectSetup={(s) => {
            setSelectedSetupId(s.id)
            haptic.impact()
          }}
          onWatchSetup={(s) => void handleWatchSetup(s)}
          onSelectScenario={(sc) => {
            if (sc.setupId) setSelectedSetupId(sc.setupId)
            haptic.impact()
          }}
        />
      )}

      {!chartExpanded && zonesMode && (
        <ZoneVariantsPanel
          zones={foundZones}
          setups={pickedSetups}
          selectedId={selectedSetupId}
          watchingIds={watchingIds}
          busy={watchBusy}
          onSelect={(s) => {
            setSelectedSetupId(s.id)
            haptic.impact()
          }}
          onWatch={(s) => void handleWatchSetup(s)}
        />
      )}

      {!chartExpanded && tradesMode && (
        <ProbableTradesPanel
          trades={pickedSetups}
          globalView={tradesGlobalView}
          magnet={tradesMagnet}
          selectedId={selectedSetupId}
          watchingIds={watchingIds}
          busy={watchBusy}
          onSelect={(s) => {
            setSelectedSetupId(s.id)
            haptic.impact()
          }}
          onWatch={(s) => void handleWatchSetup(s)}
        />
      )}

      {!chartExpanded &&
        showSetupPicker &&
        !zonesMode &&
        !tradesMode &&
        !signalMode && (
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
