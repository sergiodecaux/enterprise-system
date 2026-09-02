import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type LineData,
  type Time,
  type SeriesMarker,
} from 'lightweight-charts'
import { useTranslation } from 'react-i18next'
import { Settings, Eye, Maximize2, Minimize2, ArrowUpDown, MessageSquare, Volume2, VolumeX, Flame } from 'lucide-react'
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
import { recordSequenceHit, setProcessAudioEnabled, seedHitBaselineFromCandles } from '../../engine/sequence'
import type { LiveSignalResult } from '../../engine/trades'
import {
  pushJewelEntryAlert,
  pushProbableTradesAck,
  pushZoneWatchAck,
  pushZoneAdvisorAlert,
} from '../../api/telegram/formatters'
import ZonePathOverlay from './ZonePathOverlay'
import StructureHud from './StructureHud'
import StructureOverlay from './StructureOverlay'
import CurvePathOverlay from './CurvePathOverlay'
import ZoneAdvisorCard from './ZoneAdvisorCard'
import ZoneVariantsPanel from './ZoneVariantsPanel'
import ProbableTradesPanel from './ProbableTradesPanel'
import SignalNowPanel from './SignalNowPanel'
import { buildGlobalFibonacci, type GlobalFibonacciMap } from '../../engine/zones/globalFibonacci'
import {
  composeStructureRead,
  findCongestionZones,
  markersForChart,
  readTfStructure,
  type StructureTf,
} from '../../engine/smc/structureRead'
import { pickActionZones } from '../../engine/smc/entryZones'
import {
  analyzeZoneTap,
  hitZoneAt,
  timeframeBarSeconds,
  type ZoneAdvisorBrief,
} from '../../engine/smc/zoneAdvisor'
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
import { useLiqHeatmap } from '../../hooks/useLiqHeatmap'
import WhaleLevelsOverlay from './WhaleLevelsOverlay'
import LiqHeatmapOverlay from './LiqHeatmapOverlay'
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
  '1m': 160,
  '5m': 140,
  '15m': 140,
  '1h': 160,
  '4h': 120,
  '1d': 100,
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

const FIB_TF_BUTTONS: Array<{ id: '1h' | '4h' | '1d'; label: string }> = [
  { id: '1h', label: '141 1ч' },
  { id: '4h', label: '141 4ч' },
  { id: '1d', label: '141 1д' },
]

function structureTfOf(tf: MexcTimeframe): StructureTf {
  if (tf === '4h') return '4h'
  if (tf === '1d') return '1d'
  return '1h'
}

const CHART_HEIGHT = 440

function isPhoneLandscapeNow(): boolean {
  if (typeof window === 'undefined') return false
  const w = window.visualViewport?.width ?? window.innerWidth
  const h = window.visualViewport?.height ?? window.innerHeight
  const coarse = window.matchMedia('(pointer: coarse)').matches
  return w > h && (coarse || h < 560)
}

function paneHeight(expanded: boolean, landscape: boolean, vh: number): number {
  if (expanded) return Math.max(280, Math.round(vh - 152))
  if (landscape) return Math.max(200, Math.round(vh * 0.58))
  return CHART_HEIGHT
}

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
  const chartShellRef = useRef<HTMLDivElement>(null)
  const expandSlotRef = useRef<HTMLDivElement>(null)
  const [expandHost] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null
    const el = document.createElement('div')
    el.setAttribute('data-live-chart-host', '')
    return el
  })
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
  const [phoneLandscape, setPhoneLandscape] = useState(isPhoneLandscapeNow)
  const [viewportH, setViewportH] = useState(
    () =>
      (typeof window !== 'undefined'
        ? window.visualViewport?.height ?? window.innerHeight
        : 700)
  )
  const [showDirection, setShowDirection] = useState(false)
  const [showHints, setShowHints] = useState(false)
  const [showLiqMap, setShowLiqMap] = useState(() => {
    try {
      return localStorage.getItem('enterprise_liq_map') !== '0'
    } catch {
      return true
    }
  })
  const [audioOn, setAudioOn] = useState(() => {
    try {
      return localStorage.getItem('enterprise_process_audio') === '1'
    } catch {
      return false
    }
  })
  const [candles, setCandles] = useState<OhlcvCandle[]>([])
  const [lwcData, setLwcData] = useState<CandlestickData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chartReady, setChartReady] = useState(0)
  const [chartInstance, setChartInstance] = useState<IChartApi | null>(null)
  const [showForecast, setShowForecast] = useState(false)
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
  const [fibTfs, setFibTfs] = useState<Set<string>>(() => new Set())
  const [showSrZones, setShowSrZones] = useState(true)
  const [advisor, setAdvisor] = useState<ZoneAdvisorBrief | null>(null)
  const [advisorBot, setAdvisorBot] = useState<'idle' | 'sent' | 'fail'>('idle')
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

  const tallChart = chartExpanded || phoneLandscape
  const chartHeight = paneHeight(chartExpanded, phoneLandscape, viewportH)
  chartHeightRef.current = chartHeight

  useEffect(() => {
    const sync = () => {
      const h = window.visualViewport?.height ?? window.innerHeight
      setViewportH(h)
      setPhoneLandscape(isPhoneLandscapeNow())
    }
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    window.visualViewport?.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
      window.visualViewport?.removeEventListener('resize', sync)
    }
  }, [])

  useEffect(() => {
    if (!chartExpanded) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChartExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [chartExpanded])

  const resizeLiveChart = useCallback(() => {
    const chart = chartRef.current
    const box = containerRef.current
    if (!chart || !box) return
    const w = Math.floor(box.clientWidth)
    const h = Math.floor(box.clientHeight)
    if (w < 16 || h < 16) return
    try {
      chart.applyOptions({ width: w, height: h })
    } catch {
      /* chart may be mid-move */
    }
  }, [])

  useEffect(() => {
    return () => {
      expandHost?.remove()
    }
  }, [expandHost])

  useLayoutEffect(() => {
    const host = expandHost
    const slot = expandSlotRef.current
    if (!host || !slot) return
    userPanningRef.current = false
    if (chartExpanded) {
      host.style.cssText =
        'position:fixed;inset:0;z-index:200;display:flex;flex-direction:column;background:#0c0e12;padding-top:env(safe-area-inset-top);'
      document.body.appendChild(host)
    } else {
      host.style.cssText = 'position:relative;display:block;width:100%;'
      slot.appendChild(host)
    }
    window.requestAnimationFrame(() => {
      resizeLiveChart()
      window.requestAnimationFrame(resizeLiveChart)
    })
  }, [chartExpanded, expandHost, resizeLiveChart])

  useEffect(() => {
    if (!chartRef.current) return
    try {
      chartRef.current.applyOptions({
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
        crosshair: { mode: CrosshairMode.Magnet },
        timeScale: { rightOffset: tallChart ? 22 : 16 },
      })
    } catch {
      /* ignore */
    }
    resizeLiveChart()
  }, [chartHeight, tallChart, chartExpanded, resizeLiveChart])

  const watchedSetups = useAppStore((s) => s.watchedSetups)
  const upsertWatchedSetup = useAppStore((s) => s.upsertWatchedSetup)
  const removeWatchedSetupLocal = useAppStore((s) => s.removeWatchedSetupLocal)
  const telegramSettings = useAppStore((s) => s.telegramAlertSettings)
  const { showAlert, haptic, userId } = useTelegramWebApp()

  const currentPrice = ticker?.price ?? signal?.price ?? 0
  const lastClose = candles.length ? candles[candles.length - 1][4] : 0
  const mapPrice = currentPrice > 0 ? currentPrice : lastClose
  const liqModel = useLiqHeatmap(symbol, candles, mapPrice, showLiqMap)
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
  const { priceLevels: basePriceLevels } = useChartZones(
    candles,
    chartPreferences.zones
  )

  const lastCandleTs =
    candles.length > 0 ? Math.floor(candles[candles.length - 1][0] / 1000) : 0

  const {
    alignment,
    liquidityMap,
    candles1d,
    candles4h,
    candles1h,
    candles1w,
    isLoading: mtfLoading,
  } = useMultiTFAnalysis(symbol, currentPrice, true)

  const globalFib = useMemo(() => {
    const src =
      candles.length >= 40
        ? candles
        : candles1d.length >= 20
          ? candles1d
          : candles
    const px =
      currentPrice > 0
        ? Number(currentPrice.toPrecision(6))
        : currentPrice
    return buildGlobalFibonacci(src, px || 0)
  }, [candles, candles1d, currentPrice])

  const chartStructure = useMemo(
    () =>
      candles.length >= 16
        ? readTfStructure(candles, structureTfOf(timeframe))
        : null,
    [candles, timeframe]
  )

  const fibMaps = useMemo(() => {
    const px = currentPrice > 0 ? Number(currentPrice.toPrecision(6)) : 0
    const src: Record<string, OhlcvCandle[]> = {
      '1h':
        candles1h.length >= 20
          ? candles1h
          : timeframe === '1h'
            ? candles
            : [],
      '4h':
        candles4h.length >= 16
          ? candles4h
          : timeframe === '4h'
            ? candles
            : [],
      '1d':
        candles1d.length >= 16
          ? candles1d
          : timeframe === '1d'
            ? candles
            : [],
    }
    const maps: Record<string, GlobalFibonacciMap> = {}
    for (const [tf, c] of Object.entries(src)) {
      if (c.length < 20) continue
      const m = buildGlobalFibonacci(c, px)
      if (m) maps[tf] = m
    }
    return maps
  }, [candles, candles1h, candles4h, candles1d, timeframe, currentPrice])

  const toggleFibTf = useCallback((tf: string) => {
    setFibTfs((prev) => {
      const next = new Set(prev)
      if (next.has(tf)) next.delete(tf)
      else next.add(tf)
      return next
    })
  }, [])

  const structureRead = useMemo(() => {
    const h1src = candles1h.length >= 20 ? candles1h : timeframe === '1h' ? candles : candles1h
    const h4src = candles4h.length >= 16 ? candles4h : timeframe === '4h' ? candles : candles4h
    const dSrc = candles1d.length >= 16 ? candles1d : timeframe === '1d' ? candles : candles1d
    if (h1src.length < 16 && h4src.length < 16 && dSrc.length < 16) return null
    const px =
      currentPrice > 0 ? Number(currentPrice.toPrecision(6)) : currentPrice
    return composeStructureRead({
      price: px || 0,
      candles1h: h1src.length >= 16 ? h1src : undefined,
      candles4h: h4src.length >= 16 ? h4src : undefined,
      candles1d: dSrc.length >= 16 ? dSrc : undefined,
      candles1w: candles1w.length >= 8 ? candles1w : undefined,
      fib: globalFib,
    })
  }, [
    candles,
    candles1h,
    candles4h,
    candles1d,
    candles1w,
    timeframe,
    currentPrice,
    globalFib,
  ])

  const fearGreedValue = useAppStore((s) => s.newsIntel.fearGreed?.value ?? null)

  /** Проторговка + FVG/OB откуда лонг/шорт с отката */
  const actionPick = useMemo(
    () =>
      pickActionZones({
        candles,
        price: currentPrice,
        side: structureRead?.preferredSide ?? null,
      }),
    [candles, currentPrice, structureRead?.preferredSide]
  )

  const liquidityZones = useMemo((): LiquidityZone[] => {
    const visibleEnd =
      candles.length > 0
        ? ((Math.floor(candles[candles.length - 1][0] / 1000) + 86400 * 4) as Time)
        : ((Date.now() / 1000 + 86400) as Time)

    const zones: LiquidityZone[] = []

    if (showSrZones) {
      const cong = findCongestionZones(candles, 2)
      if (cong.length) {
        for (const z of cong) {
          zones.push({
            id: `cong_${z.startTimeSec}_${z.touches}`,
            type: 'VALUE_AREA',
            side: 'NEUTRAL',
            top: z.top,
            bottom: z.bottom,
            startTime: z.startTimeSec as Time,
            endTime: visibleEnd,
            strength: 9,
            label: '',
          })
        }
      } else if (chartStructure && chartStructure.dealingHigh > chartStructure.dealingLow) {
        const startIdx = Math.max(0, Math.floor(candles.length * 0.45))
        const startT = candles[startIdx]
          ? (Math.floor(candles[startIdx][0] / 1000) as Time)
          : ((Date.now() / 1000) as Time)
        zones.push({
          id: 'cong_dealing',
          type: 'VALUE_AREA',
          side: 'NEUTRAL',
          top: chartStructure.dealingHigh,
          bottom: chartStructure.dealingLow,
          startTime: startT,
          endTime: visibleEnd,
          strength: 8,
          label: '',
        })
      }
    }

    const visibleStart =
      candles.length > 0
        ? (Math.floor(candles[0][0] / 1000) as Time)
        : ((Date.now() / 1000) as Time)

    for (const tf of fibTfs) {
      const fib = fibMaps[tf]
      if (!fib) continue
      const band = fib.chartZones.find(
        (z) => (z.id ?? '').includes('ext_141') || (z.id ?? '').includes('141')
      )
      if (!band) continue
      zones.push({
        ...band,
        id: `fib141_${tf}`,
        startTime: visibleStart,
        endTime: visibleEnd,
        label: `141 ${tf}`,
      })
    }

    if (zonesMode && foundChartZones.length) {
      zones.push(...foundChartZones)
    }
    zones.push(...actionPick.zones)
    return zones
  }, [
    actionPick.zones,
    candles,
    chartStructure,
    showSrZones,
    fibTfs,
    fibMaps,
    zonesMode,
    foundChartZones,
  ])

  const priceLevels = useMemo(() => {
    const colors: Record<string, string> = {
      '1h': 'rgba(251, 191, 36, 0.75)',
      '4h': 'rgba(34, 211, 238, 0.75)',
      '1d': 'rgba(167, 139, 250, 0.75)',
    }
    const out: typeof basePriceLevels = []
    for (const tf of fibTfs) {
      const fib = fibMaps[tf]
      if (!fib?.price141) continue
      out.push({
        id: `gfib_${tf}_141`,
        type: 'FIB_OTE',
        price: fib.price141,
        label: '',
        color: colors[tf] ?? 'rgba(251, 191, 36, 0.6)',
        lineStyle: 2,
      })
      if (fib.price161 && fibTfs.size <= 2) {
        out.push({
          id: `gfib_${tf}_161`,
          type: 'FIB_OTE',
          price: fib.price161,
          label: '',
          color: colors[tf] ?? 'rgba(251, 191, 36, 0.4)',
          lineStyle: 3,
        })
      }
    }
    return out
  }, [fibTfs, fibMaps, basePriceLevels])

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

  const handleZoneTap = useCallback(
    (zoneId: string) => {
      const zone = liquidityZones.find((z) => z.id === zoneId)
      if (!zone || !(currentPrice > 0)) return
      const brief = analyzeZoneTap({
        zone,
        price: currentPrice,
        structure: structureRead,
        timeframe,
      })
      if (!brief) return
      setAdvisor(brief)
      setAdvisorBot('idle')
      try {
        chartRef.current?.timeScale().applyOptions({ rightOffset: 24 })
      } catch {
        /* ignore */
      }
      haptic.impact()
      const chatId = resolveChatId()
      void (async () => {
        if (!isTelegramAlertsConfigured() || chatId == null) {
          setAdvisorBot('fail')
          showAlert(
            chatId == null
              ? 'Сценарий на графике. Бот: открой Mini App из Telegram или /start'
              : 'Сценарий на графике. Прокси бота не настроен'
          )
          return
        }
        try {
          await subscribeTelegramAlerts({
            chatId,
            sniper: telegramSettings.sniper !== false,
            meme: false,
          })
        } catch {
          /* best-effort */
        }
        const r = await pushZoneAdvisorAlert({
          symbol: flatSymbol,
          displayName: signal?.displayName,
          price: currentPrice,
          brief,
          chatId,
        })
        setAdvisorBot(r.ok ? 'sent' : 'fail')
        if (r.ok) haptic.success()
        else {
          const why = r.reason ?? ''
          showAlert(
            why === 'need_start' || why === 'no_chat_id'
              ? 'Сценарий на графике. Напиши боту /start и открой Mini App из Telegram'
              : why === 'network'
                ? 'Сценарий на графике. Нет связи с ботом — проверь сеть'
                : 'Сценарий на графике. Бот не принял сообщение — /start и подписка'
          )
        }
      })()
    },
    [
      liquidityZones,
      currentPrice,
      structureRead,
      timeframe,
      haptic,
      resolveChatId,
      telegramSettings.sniper,
      flatSymbol,
      signal?.displayName,
      showAlert,
    ]
  )

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
      structure: structureRead,
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
    structureRead,
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
        seedHitBaselineFromCandles(symbol, data)
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

    const el = containerRef.current
    const startW = Math.max(50, Math.floor(el.clientWidth || el.parentElement?.clientWidth || 320))
    const startH = Math.max(160, Math.floor(el.clientHeight || chartHeightRef.current || CHART_HEIGHT))

    const chart = createChart(el, {
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
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: 'rgba(148, 163, 184, 0.45)',
          width: 1,
          style: 2,
          labelBackgroundColor: '#1e293b',
        },
        horzLine: {
          color: 'rgba(148, 163, 184, 0.45)',
          width: 1,
          style: 2,
          labelBackgroundColor: '#1e293b',
        },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 16,
        barSpacing: 8,
        minBarSpacing: 2,
        lockVisibleTimeRangeOnResize: true,
        shiftVisibleRangeOnNewBar: true,
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.1)',
        scaleMargins: { top: 0.12, bottom: 0.12 },
        autoScale: true,
        entireTextOnly: true,
        alignLabels: true,
      },
      width: startW,
      height: startH,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
        axisDoubleClickReset: false,
      },
      kineticScroll: {
        touch: true,
        mouse: true,
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

    const syncSize = () => {
      const box = containerRef.current
      if (!box || !chartRef.current) return
      const w = box.clientWidth
      const h = box.clientHeight
      if (w > 8 && h > 8) {
        try {
          chart.applyOptions({
            width: Math.floor(w),
            height: Math.floor(h),
          })
        } catch {
          /* ignore */
        }
      }
    }
    window.requestAnimationFrame(syncSize)

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
      const h = Math.floor(entries[0].contentRect.height)
      if (w < 16) return
      if (userPanningRef.current) return
      try {
        chart.applyOptions({
          width: w,
          height: Math.max(160, h || chartHeightRef.current),
        })
      } catch {
        /* ignore */
      }
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
      try {
        chart.remove()
      } catch {
        /* ignore */
      }
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
      const vis =
        timeframe === '1m' || timeframe === '5m' ? 90 : 70
      const from = Math.max(-2, lwcData.length - vis)
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from,
        to: lwcData.length + 14,
      })
      fittedKeyRef.current = key
    }
  }, [lwcData, symbol, timeframe, chartReady])

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

  useEffect(() => {
    const series = candleRef.current
    if (!series || !structureRead || !lwcData.length) {
      series?.setMarkers([])
      return
    }
    const times = lwcData.map((c) => c.time as number)
    const mapped = markersForChart(structureRead, times)
    const markers: SeriesMarker<Time>[] = mapped.map((m) => ({
      time: m.time as Time,
      position: m.position,
      color: m.color,
      shape: m.shape,
      text: m.text,
    }))
    series.setMarkers(markers)
  }, [structureRead, lwcData, chartReady])

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
          // 141/161: show price on the right axis so the band is readable
          axisLabelVisible: opts?.axisLabel ?? false,
          title,
        })
        priceLineRefs.current.push(line)
      } catch {
        /* ignore */
      }
    }

    // Fib 141 — price on the right axis only, no letter tags
    for (const level of priceLevels) {
      addLine(level.price, level.color, '', {
        lineStyle: level.lineStyle ?? 2,
        lineWidth: 1,
        axisLabel: true,
      })
    }

    if (showSrZones) {
      const bands = liquidityZones.filter((z) => (z.id ?? '').startsWith('cong_'))
      for (const z of bands) {
        addLine(z.top, 'rgba(244, 114, 182, 0.55)', '', {
          lineStyle: 2,
          lineWidth: 1,
          axisLabel: true,
        })
        addLine(z.bottom, 'rgba(244, 114, 182, 0.55)', '', {
          lineStyle: 2,
          lineWidth: 1,
          axisLabel: true,
        })
      }
    }

    // SL / TP / вход только в режиме сигнала или выбранного сетапа
    if (signalMode || selectedSetup) {
      const entry =
        signal?.surgicalEntry?.status === 'READY' &&
        signal.surgicalEntry.limitEntry != null
          ? signal.surgicalEntry.limitEntry
          : null
      if (entry != null) {
        addLine(entry, 'rgba(56, 189, 248, 0.95)', 'IN', {
          lineStyle: 0,
          lineWidth: 2,
          axisLabel: true,
        })
      }
      if (signal?.sl != null) {
        addLine(signal.sl, 'rgba(239, 68, 68, 0.95)', 'SL', {
          lineStyle: 0,
          lineWidth: 2,
          axisLabel: true,
        })
      }
      if (signal?.tp1 != null) {
        addLine(signal.tp1, 'rgba(34, 197, 94, 0.95)', 'TP1', {
          lineStyle: 0,
          lineWidth: 2,
          axisLabel: true,
        })
      }
      if (selectedSetup) {
        if (selectedSetup.limitEntry > 0) {
          addLine(selectedSetup.limitEntry, 'rgba(56, 189, 248, 0.95)', 'вход', {
            lineStyle: 0,
            lineWidth: 2,
            axisLabel: true,
          })
        }
        if (selectedSetup.invalidation > 0) {
          addLine(
            selectedSetup.invalidation,
            'rgba(251, 113, 133, 0.95)',
            'слом',
            { lineStyle: 1, lineWidth: 1, axisLabel: true }
          )
        }
        if (selectedSetup.target > 0) {
          addLine(selectedSetup.target, 'rgba(45, 212, 191, 0.95)', 'цель', {
            lineStyle: 2,
            lineWidth: 1,
            axisLabel: true,
          })
        }
      }
    }
  }, [
    priceLevels,
    chartReady,
    lwcData,
    signal,
    selectedSetup,
    signalMode,
    showSrZones,
    liquidityZones,
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

    if (!eqLiquidityMap || cleanMode) return

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

      const title = ''

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
    const n = lwcData.length
    if (n > 2) {
      const vis = timeframe === '1m' || timeframe === '5m' ? 90 : 70
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(-2, n - vis),
        to: n + 14,
      })
    } else {
      chart.timeScale().fitContent()
    }
    haptic.impact()
  }, [haptic, lwcData.length, timeframe])

  const resolveChartDoubleTap = useCallback(
    (clientX: number, clientY: number) => {
      const chart = chartRef.current
      const series = candleRef.current
      const box = containerRef.current
      if (!chart || !series || !box) return
      const rect = box.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      if (x < 8 || y < 0 || x > rect.width - 8 || y > rect.height) return
      let price: number | null = null
      try {
        const p = series.coordinateToPrice(y)
        price = typeof p === 'number' ? p : null
      } catch {
        return
      }
      if (price == null || !(price > 0)) return
      const zone = hitZoneAt(liquidityZones, price)
      if (zone) handleZoneTap(zone.id)
    },
    [liquidityZones, handleZoneTap]
  )

  useEffect(() => {
    const el = chartShellRef.current
    if (!el) return
    let last: { t: number; x: number; y: number } | null = null
    let start: { x: number; y: number } | null = null
    const onStart = (e: TouchEvent) => {
      e.stopPropagation()
      if (e.touches.length === 1) {
        start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      } else {
        start = null
        last = null
      }
    }
    const onEnd = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('button')) {
        last = null
        return
      }
      if (e.changedTouches.length !== 1 || !start) return
      const tch = e.changedTouches[0]
      const moved = Math.hypot(tch.clientX - start.x, tch.clientY - start.y)
      start = null
      if (moved > 18) {
        last = null
        return
      }
      const now = Date.now()
      if (
        last &&
        now - last.t < 450 &&
        Math.hypot(tch.clientX - last.x, tch.clientY - last.y) < 44
      ) {
        last = null
        e.preventDefault()
        resolveChartDoubleTap(tch.clientX, tch.clientY)
        return
      }
      last = { t: now, x: tch.clientX, y: tch.clientY }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: false })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchend', onEnd)
    }
  }, [resolveChartDoubleTap])

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
          fvg: true,
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
  const curvePaths = useMemo(() => {
    if (!advisor) return []
    return [
      {
        id: 'hold',
        points: advisor.primary.path,
        color: advisor.primary.side === 'LONG' ? '#34d399' : '#fb7185',
        label: `${advisor.primary.probability}%`,
        emphasis: true,
      },
      {
        id: 'break',
        points: advisor.alternate.path,
        color: '#94a3b8',
        label: `${advisor.alternate.probability}%`,
        emphasis: false,
      },
    ]
  }, [advisor])
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
        structure: structureRead,
      }),
    [
      signal,
      forecast,
      alignment,
      bookForForecast,
      newsBias,
      timeframe,
      structureRead,
    ]
  )

  const chartRegime = signal?.marketRegime ?? 'RANGING'
  const toolsTrendOk =
    chartRegime === 'TRENDING_STRONG' || chartRegime === 'TRENDING_WEAK'
  const toolsChop = chartRegime === 'VOLATILE_CHOP'
  const activeSequence =
    sequenceHit && sequenceHit.expiresAt > Date.now() ? sequenceHit : null
  const processRefreshKey =
    (sequenceHit?.detectedAt ?? 0) +
    Math.round((ticker?.timestamp ?? 0) / 15_000)

  void handleFindZones

  const ui = (
    <div
      className={
        chartExpanded
          ? 'flex h-full min-h-0 flex-col bg-[#0c0e12]'
          : 'space-y-2'
      }
    >
      {!chartExpanded && (
      <ProcessStrip
        symbol={symbol}
        regime={chartRegime}
        sequence={activeSequence}
        refreshKey={processRefreshKey}
      />
      )}

      <div className={`flex shrink-0 items-center justify-between gap-2 ${chartExpanded ? 'px-2 pt-1' : ''}`}>
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
            onClick={() => {
              setAudioOn((v) => {
                const next = !v
                setProcessAudioEnabled(next)
                return next
              })
              haptic.impact()
            }}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] font-bold uppercase transition-colors ${
              audioOn
                ? 'border-violet-400/45 bg-violet-500/20 text-violet-200'
                : 'border-white/10 bg-hull-light/40 text-holo/55 hover:text-holo'
            }`}
            title="Звук процесса: удары, ликвидации, момент"
          >
            {audioOn ? (
              <Volume2 className="h-3.5 w-3.5" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">Звук</span>
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

      {/* Tool rail — ТФ и режимы всегда с графиком */}
      <div
        className={`shrink-0 space-y-1 bg-[#0c0e12] py-1 ${
          chartExpanded ? 'px-2' : 'sticky top-0 z-20 bg-space/95 backdrop-blur-sm'
        }`}
      >
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
                    : tf.id === '1h' || tf.id === '4h'
                      ? 'text-white/55 hover:text-white/80'
                      : 'text-white/40 hover:text-white/70'
                }`}
                title={
                  tf.id === '1h'
                    ? '1H — главный ТФ структуры (BOS / закреп)'
                    : tf.id === '4h'
                      ? '4H — подтверждение структуры'
                      : undefined
                }
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
            type="button"
            onClick={() => {
              setShowSrZones((v) => !v)
              haptic.impact()
            }}
            className={`shrink-0 rounded-lg px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
              showSrZones
                ? 'border border-pink-400/35 bg-pink-500/15 text-pink-200'
                : 'border border-white/[0.08] bg-[#10141a] text-white/55 hover:text-white/80'
            }`}
            title="Проторговка — полупрозрачный диапазон, не линия"
          >
            Зоны
          </button>
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-white/[0.08] bg-[#10141a] p-0.5">
            {FIB_TF_BUTTONS.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  toggleFibTf(b.id)
                  haptic.impact()
                }}
                className={`rounded-md px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
                  fibTfs.has(b.id)
                    ? b.id === '1h'
                      ? 'bg-amber-500/20 text-amber-200'
                      : b.id === '4h'
                        ? 'bg-cyan-500/20 text-cyan-200'
                        : 'bg-violet-500/20 text-violet-200'
                    : 'text-white/40 hover:text-white/70'
                }`}
                title={`Fibonacci 141 на ${b.label.replace('141 ', '')}`}
              >
                {b.label}
              </button>
            ))}
          </div>
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

      <div className={`shrink-0 ${chartExpanded ? 'px-2' : ''}`}>
      <StructureHud read={structureRead} />
      </div>
      {!chartExpanded && (
      <p className="px-1 font-mono text-[9px] text-white/35">
        Двойной тап по зоне — сценарий, стрелки и сообщение в бота
      </p>
      )}

      <div
        ref={chartShellRef}
        className={`relative w-full overflow-hidden bg-[#0c0e12] ${
          chartExpanded
            ? 'min-h-0 flex-1 rounded-none border-0'
            : 'rounded-xl border border-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
        }`}
        style={{
          height: chartExpanded ? undefined : chartHeight,
          touchAction: 'none',
        }}
        onTouchStart={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          resolveChartDoubleTap(e.clientX, e.clientY)
        }}
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
          style={{ touchAction: 'none' }}
        />
        {lwcData.length > 0 && (
          <div className="pointer-events-none absolute left-2 top-1.5 z-20 flex flex-wrap items-baseline gap-x-2 font-mono text-[10px] text-white/70">
            {(() => {
              const bar = lwcData[lwcData.length - 1]
              const pct = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0
              const up = pct >= 0
              const fmt = (p: number) =>
                p >= 1000 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(5)
              return (
                <>
                  <span className="font-bold text-white/85">{timeframe}</span>
                  <span>
                    O <span className="text-white/90">{fmt(bar.open)}</span>
                  </span>
                  <span>
                    H <span className="text-emerald-300/90">{fmt(bar.high)}</span>
                  </span>
                  <span>
                    L <span className="text-rose-300/90">{fmt(bar.low)}</span>
                  </span>
                  <span>
                    C{' '}
                    <span className={up ? 'text-emerald-300' : 'text-rose-300'}>
                      {fmt(bar.close)}
                    </span>
                  </span>
                  <span className={up ? 'text-emerald-400' : 'text-rose-400'}>
                    {up ? '+' : ''}
                    {pct.toFixed(2)}%
                  </span>
                </>
              )
            })()}
          </div>
        )}
        {structureRead && !pathModeActive && !advisor && (
          <div
            className={`pointer-events-none absolute bottom-1.5 left-2 z-20 max-w-[62%] font-mono text-[10px] leading-tight ${
              structureRead.structureHeld ? 'text-emerald-200/80' : 'text-rose-200/85'
            }`}
          >
            {structureRead.summary}
          </div>
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
            opacity={14}
            showLabels
            highlightId={advisor?.zoneId ?? highlightedZoneId ?? actionPick.launchId}
            quiet
          />
        )}
        {chartReady > 0 && lastCandleTs > 0 && !pathModeActive && !advisor && (
          <StructureOverlay
            chart={chartInstance}
            read={structureRead}
            lastCandleTs={lastCandleTs}
            showPath
          />
        )}
        {chartReady > 0 && lastCandleTs > 0 && advisor && (
          <CurvePathOverlay
            chart={chartInstance}
            lastCandleTs={lastCandleTs}
            barSeconds={timeframeBarSeconds(timeframe)}
            paths={curvePaths}
          />
        )}
        {advisor && (
          <ZoneAdvisorCard
            brief={advisor}
            botStatus={advisorBot}
            onClose={() => {
              setAdvisor(null)
              setAdvisorBot('idle')
            }}
          />
        )}
        {chartReady > 0 && showLiqMap && (
          <LiqHeatmapOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            model={liqModel}
            visible={showLiqMap}
          />
        )}
        <button
          type="button"
          onClick={() => {
            setShowLiqMap((v) => {
              const next = !v
              try {
                localStorage.setItem('enterprise_liq_map', next ? '1' : '0')
              } catch {
                /* ignore */
              }
              return next
            })
            haptic.impact()
          }}
          className={`absolute bottom-9 left-2 z-30 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider shadow-lg backdrop-blur-md transition-colors ${
            showLiqMap
              ? 'border-emerald-400/40 bg-emerald-950/80 text-emerald-200'
              : 'border-white/15 bg-black/65 text-white/55 hover:text-white/85'
          }`}
          title="Карта лонгов, шортов и ликвидаций"
        >
          <Flame className="h-3.5 w-3.5" />
          L/S
          <span
            className={`rounded px-1 py-px text-[8px] ${
              showLiqMap ? 'bg-emerald-400/20' : 'bg-white/10'
            }`}
          >
            {showLiqMap ? 'ON' : 'OFF'}
          </span>
        </button>
        {chartReady > 0 && !cleanMode && (
          <WhaleLevelsOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            whaleState={whaleState}
            priceFloor={candlePriceSpan.floor}
            priceCeil={candlePriceSpan.ceil}
          />
        )}
        {chartReady > 0 &&  (
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
          !advisor &&
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

      {!chartExpanded && (
        <>
      <DeltaSparkline
        symbol={symbol}
        refreshKey={processRefreshKey}
        height={32}
      />

      {chartPreferences.indicators.volume &&
        indicators.volume.length > 0 && (
          <VolumePanel volumeData={indicators.volume} height={44} />
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

      {!cleanMode && (
        <MultiTFPanel alignment={alignment} isLoading={mtfLoading} />
      )}

      {showPredictionPaths && forecast && (
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

      {signalMode && liveSignal && (
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

      {zonesMode && (
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

      {tradesMode && (
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

      {showSetupPicker &&
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
        </>
      )}

      <ChartSettings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )

  return (
    <>
      {chartExpanded && (
        <div
          className="flex h-[440px] items-center justify-center rounded-xl border border-white/[0.08] bg-[#0c0e12] font-mono text-[10px] text-white/35"
          aria-hidden
        >
          график на весь экран
        </div>
      )}
      <div
        ref={expandSlotRef}
        className={chartExpanded ? 'hidden' : 'relative w-full'}
      />
      {expandHost ? createPortal(ui, expandHost) : ui}
    </>
  )
}

export default LiveChart
