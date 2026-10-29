import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
  type SeriesMarker,
  type AutoscaleInfo,
} from 'lightweight-charts'
import { useTranslation } from 'react-i18next'
import { Settings, Maximize2, Minimize2, Flame, Layers3 } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useAdvisorStore } from '../../store/useAdvisorStore'
import type { AdvisorChartInput } from '../../engine/advisor'
import type { EqualLevel } from '../../engine/types'
import {
  CHART_TIMEFRAMES,
  fetchOhlcv,
  type MexcTimeframe,
  type OhlcvCandle,
} from '../../api/mexc'
import { fetchCrowdContext } from '../../api/binance/crowd'
import { buildFullMarketContext } from '../../engine/context'
import type { CoinSignal } from '../../engine/types'
import type { LiquidityZone } from '../../engine/indicators/types'
import { logger } from '../../utils/logger'
import {
  CHART_BG,
  CHART_CROSSHAIR_LINES,
  CHART_DOWN,
  CHART_DOWN_FILL,
  CHART_GRID_LINES,
  CHART_LAYOUT,
  CHART_PRICE_LINE,
  CHART_PRICE_SCALE,
  CHART_TIME_SCALE,
  CHART_UP,
  CHART_UP_FILL,
} from '../../styles/chartTheme'
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
import {
  findProbableTrades,
  findLiveSignal,
  findBounceSetups,
} from '../../engine/trades'
import { recordSequenceHit, setProcessAudioEnabled, seedHitBaselineFromCandles } from '../../engine/sequence'
import type { LiveSignalResult, BounceModeResult } from '../../engine/trades'
import {
  pushJewelEntryAlert,
  pushProbableTradesAck,
  pushZoneWatchAck,
} from '../../api/telegram/formatters'
import ZonePathOverlay from './ZonePathOverlay'
import StructureHud from './StructureHud'
import StructureOverlay from './StructureOverlay'
import StoryPathOverlay from './StoryPathOverlay'
import NowStoryHud from './NowStoryHud'
import ScenarioBoard, { ZoneLegend } from './ScenarioBoard'
import CurvePathOverlay from './CurvePathOverlay'
import ZoneAdvisorCard, {
  ADVISOR_CARD_H,
  ADVISOR_CARD_W,
  type AdvisorMode,
} from './ZoneAdvisorCard'
import ZoneVariantsPanel from './ZoneVariantsPanel'
import ProbableTradesPanel from './ProbableTradesPanel'
import SignalNowPanel from './SignalNowPanel'
import { ContextPanel } from '../market/ContextPanel'
import { buildGlobalFibonacci, type GlobalFibonacciMap } from '../../engine/zones/globalFibonacci'
import {
  composeStructureRead,
  findCongestionZones,
  markersForChart,
  readTfStructure,
  readFib141Reaction,
  type StructureRead,
  type StructureTf,
} from '../../engine/smc/structureRead'
import { deriveMacroStructure } from '../../engine/analysis/macroStructure'
import {
  buildZoneReactionBoard,
  srBoardToLiquidityZones,
} from '../../engine/smc/zoneReaction'
import { lastClosedBar } from '../../engine/smc/closeCascade'
import { pickActionZones } from '../../engine/smc/entryZones'
import { calculateAtr } from '../../engine/smc'
import { buildChartStory, FORECAST_HORIZON_UI } from '../../engine/smc/chartStory'
import type { StoryScenarioId } from '../../engine/smc/chartStory'
import { readIctStructure, selectIctOverlayMarks } from '../../engine/smc/ictStructure'
import IctMarksOverlay from './IctMarksOverlay'
import Fib141ZoneOverlay, { type FibZoneLayer } from './Fib141ZoneOverlay'
import { ChartLabelsProvider, ReserveNowPrice } from './chartLabels/LabelLayoutManager'
import {
  buildContinuationExtension,
  readContinuationReaction,
} from '../../engine/smc/continuationExtension'
import ChartCommentsOverlay from './ChartCommentsOverlay'
import CaseMarkersOverlay from './CaseMarkersOverlay'
import LimitCasesStrip from './LimitCasesStrip'
import BounceArrowsOverlay from './BounceArrowsOverlay'
import {
  analyzeZoneTap,
  hitZoneAt,
  timeframeBarSeconds,
  type ZoneAdvisorBrief,
  type ZoneContext,
  type ZoneContext141,
  type ZoneContextFib,
  type ZoneContextLiq,
  type ZoneContextSweep,
} from '../../engine/smc/zoneAdvisor'
import { buildLimitCases, type LimitCase } from '../../engine/trades/limitCases'
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
import { useWorkerMarketContext } from '../../hooks/useWorkerMarketContext'
import { buildLiqHeatmap } from '../../engine/derivatives/liqHeatmap'
import WhaleLevelsOverlay from './WhaleLevelsOverlay'
import WhaleSitStrip from './WhaleSitStrip'
import WhaleTrapButton from './WhaleTrapButton'
import WhaleTrapOverlay from './WhaleTrapOverlay'
import { buildWhaleSitMap } from '../../engine/orderbook/whaleSitLevels'
import LiqHeatmapOverlay from './LiqHeatmapOverlay'
import SequenceProcessOverlay from './SequenceProcessOverlay'
import ProcessStrip from './ProcessStrip'
import ChartHintsOverlay from './ChartHintsOverlay'
import DeltaSparkline from './DeltaSparkline'

interface LiveChartProps {
  symbol: string
  flatSymbol: string
  signal?: CoinSignal | null
  /** Заполнить родителя (терминал ПК), без фиксированных 440px */
  fillParent?: boolean
}

const CANDLE_LIMIT: Record<MexcTimeframe, number> = {
  '1m': 160,
  '5m': 140,
  '15m': 140,
  '1h': 160,
  '4h': 120,
  '1d': 100,
}

/** Чистый график: без EMA/осцилляторов/объёма — свечи главные. */
const CLEAN_OFF_INDICATORS = {
  ema20: false,
  ema50: false,
  ema200: false,
  sma9: false,
  sma21: false,
  sma50: false,
  bollingerBands: false,
  vwap: false,
  rsi: false,
  macd: false,
  stochastic: false,
  atr: false,
  volume: false,
} as const

function readLsFlag(key: string, defaultOn: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v == null) return defaultOn
    return v === '1'
  } catch {
    return defaultOn
  }
}

function writeLsFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* ignore */
  }
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

/** One row inside the chart layers menu. */
function LayerToggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-sm px-2 transition-colors hover:bg-bg-surface/60">
      <span className="min-w-0 font-sans text-[12px] leading-4 text-text-secondary">
        {label}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 shrink-0 accent-brand"
      />
    </label>
  )
}

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

/** Telegram Mini App drawer: fill remaining 85dvh, cap ~440px. */
function drawerPaneHeight(vh: number): number {
  const sheet = Math.round(vh * 0.85)
  // handle+header ≈ 96, optional whale ≈ 40, GO ≈ 48, padding ≈ 16, title+TF rails+HUD ≈ 132
  const leftover = sheet - 96 - 40 - 48 - 16 - 132
  return Math.round(Math.min(CHART_HEIGHT, Math.max(260, leftover)))
}

function paneHeight(
  expanded: boolean,
  landscape: boolean,
  vh: number,
  inDrawer: boolean
): number {
  if (expanded) return Math.max(280, Math.round(vh - 152))
  if (landscape) return Math.max(200, Math.round(vh * 0.58))
  if (inDrawer) return drawerPaneHeight(vh)
  return CHART_HEIGHT
}

const LiveChart = ({
  symbol,
  flatSymbol,
  signal = null,
  fillParent = false,
}: LiveChartProps) => {
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t

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
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const lineRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const priceLineRefs = useRef<IPriceLine[]>([])
  const liqLineRefs = useRef<IPriceLine[]>([])
  /** Skip fitContent after first successful load for this symbol/tf */
  const fittedKeyRef = useRef<string>('')
  const userPanningRef = useRef(false)
  const chartHeightRef = useRef(CHART_HEIGHT)
  const structureStickyRef = useRef<{ key: string; read: StructureRead | null } | null>(null)

  const [timeframe, setTimeframe] = useState<MexcTimeframe>('1h')
  const [chartExpanded, setChartExpanded] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [layersPos, setLayersPos] = useState<{
    top: number
    left: number
    width: number
    maxHeight: number
  } | null>(null)
  const layersRef = useRef<HTMLDetailsElement>(null)
  const [showFsScenarios, setShowFsScenarios] = useState(false)
  const [phoneLandscape, setPhoneLandscape] = useState(isPhoneLandscapeNow)
  const [viewportH, setViewportH] = useState(
    () =>
      (typeof window !== 'undefined'
        ? window.visualViewport?.height ?? window.innerHeight
        : 700)
  )
  const [showDirection, setShowDirection] = useState(false)
  const [showHints, setShowHints] = useState(false)
  const [showComments, setShowComments] = useState(() =>
    readLsFlag('enterprise_chart_comments', true)
  )
  /** 🧰 Отложенные лимитки на отскок от важных зон */
  const [showCases, setShowCases] = useState(() =>
    readLsFlag('enterprise_chart_cases', true)
  )
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [showLiqMap, setShowLiqMap] = useState(() =>
    readLsFlag('enterprise_liq_layer', true)
  )
  const [showWhaleTrap, setShowWhaleTrap] = useState(false)
  const [audioOn, setAudioOn] = useState(() => {
    try {
      return localStorage.getItem('enterprise_process_audio') === '1'
    } catch {
      return false
    }
  })
  const [candles, setCandles] = useState<OhlcvCandle[]>([])
  const [lwcData, setLwcData] = useState<CandlestickData[]>([])
  const lwcDataRef = useRef<CandlestickData[]>([])
  lwcDataRef.current = lwcData
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chartReady, setChartReady] = useState(0)
  const [chartInstance, setChartInstance] = useState<IChartApi | null>(null)
  const [showForecast, setShowForecast] = useState(false)
  /** INTRA = текущий ТФ · MACRO = недельная картина A/B/C */
  const [forecastHorizon] = useState<ForecastHorizon>('INTRA')
  /** По умолчанию только A — B/C включаются вручную, меньше каши */
  const [activeScenarios, setActiveScenarios] = useState<Set<string>>(
    () => new Set(['A'])
  )
  const [cleanMode, setCleanMode] = useState(() =>
    readLsFlag('enterprise_chart_clean', true)
  )
  const [showSetupPicker, setShowSetupPicker] = useState(false)
  const [pickedSetups, setPickedSetups] = useState<ConditionalSetup[]>([])
  const [selectedSetupId, setSelectedSetupId] = useState<string | null>(null)
  const [watchBusy, setWatchBusy] = useState(false)
  const [fibTfs, setFibTfs] = useState<Set<string>>(() => new Set())
  const [showSrZones, setShowSrZones] = useState(true)
  const [onlyStrong, setOnlyStrong] = useState(() => {
    try {
      return localStorage.getItem('enterprise_only_strong') !== '0'
    } catch {
      return true
    }
  })
  const [showFib141, setShowFib141] = useState(() => {
    try {
      return localStorage.getItem('enterprise_show_fib141') !== '0'
    } catch {
      return true
    }
  })
  const [showCont141, setShowCont141] = useState(() => {
    try {
      return localStorage.getItem('enterprise_show_cont141') !== '0'
    } catch {
      return true
    }
  })
  const [storyPathId, setStoryPathId] = useState<StoryScenarioId | null>(null)
  const storyPickedRef = useRef(false)
  const [advisor, setAdvisor] = useState<ZoneAdvisorBrief | null>(null)
  const [hoverAdvisor, setHoverAdvisor] = useState<ZoneAdvisorBrief | null>(null)
  const [hoverAnchor, setHoverAnchor] = useState<{ x: number; y: number } | null>(null)
  const [advisorMode, setAdvisorMode] = useState<AdvisorMode>('hold')
  const [advisorAnchor, setAdvisorAnchor] = useState<{ x: number; y: number } | null>(
    null
  )
  const [foundZones, setFoundZones] = useState<FoundTradeZone[]>([])
  const [foundChartZones, setFoundChartZones] = useState<LiquidityZone[]>([])
  const [zonesMode, setZonesMode] = useState(false)
  const [tradesMode, setTradesMode] = useState(false)
  const [signalMode, setSignalMode] = useState(false)
  const [bouncesMode, setBouncesMode] = useState(false)
  const [bounceResult, setBounceResult] = useState<BounceModeResult | null>(null)
  const [liveSignal, setLiveSignal] = useState<LiveSignalResult | null>(null)
  const [tradesGlobalView, setTradesGlobalView] =
    useState<TradeGlobalView | null>(null)
  const [tradesMagnet, setTradesMagnet] = useState<TradeMagnet | null>(null)
  /** Symbol the Сделки / Найти сигнал results were computed for */
  const toolsSymbolRef = useRef<string | null>(null)
  const jewelSentRef = useRef<Set<string>>(new Set())

  const [fillH, setFillH] = useState(CHART_HEIGHT)
  const [hostW, setHostW] = useState(() =>
    typeof window !== 'undefined'
      ? Math.round(window.visualViewport?.width ?? window.innerWidth)
      : 390
  )
  const tallChart = chartExpanded || phoneLandscape || fillParent
  const inDrawer = !fillParent
  const denseUi = hostW < 560
  const chartHeight =
    fillParent && !chartExpanded
      ? fillH
      : paneHeight(chartExpanded, phoneLandscape, viewportH, inDrawer)
  chartHeightRef.current = chartHeight
  const storyRightOffset = denseUi ? 18 : tallChart ? 28 : 22

  useEffect(() => {
    const sync = () => {
      const h = window.visualViewport?.height ?? window.innerHeight
      const w = window.visualViewport?.width ?? window.innerWidth
      setViewportH(h)
      setHostW(Math.round(w))
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
    const el = chartShellRef.current
    if (!el) return
    const apply = () => {
      const w = Math.floor(el.clientWidth)
      const h = Math.floor(el.clientHeight)
      if (w >= 80) setHostW(w)
      if (fillParent && !chartExpanded && h >= 80) setFillH(h)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fillParent, chartExpanded, chartReady])

  useEffect(() => {
    if (!chartExpanded) {
      setShowFsScenarios(false)
      return
    }
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
    if (!chart || !box) return false
    const w = Math.floor(box.clientWidth)
    const h = Math.floor(box.clientHeight)
    if (w < 16 || h < 16) return false
    try {
      chart.applyOptions({ width: w, height: h })
    } catch {
      return false
    }
    const data = lwcDataRef.current
    if (data.length && candleRef.current) {
      try {
        candleRef.current.setData(data)
      } catch {
        /* series not ready until layout exists */
      }
    }
    return true
  }, [])

  const scheduleChartResize = useCallback(() => {
    const retry = (left: number) => {
      if (resizeLiveChart()) return
      if (left <= 0) return
      window.requestAnimationFrame(() => retry(left - 1))
    }
    resizeLiveChart()
    window.requestAnimationFrame(() => retry(12))
  }, [resizeLiveChart])

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
        `position:fixed;inset:0;z-index:200;display:flex;flex-direction:column;width:100%;height:100%;background:${CHART_BG};padding-top:env(safe-area-inset-top);`
      document.body.appendChild(host)
      slot.style.display = 'none'
    } else {
      slot.style.display = ''
      if (fillParent) {
        host.style.cssText =
          'position:relative;display:flex;flex-direction:column;width:100%;height:100%;flex:1;min-height:0;'
        slot.appendChild(host)
      } else {
        host.style.cssText = 'position:relative;display:block;width:100%;'
        slot.appendChild(host)
      }
    }
    scheduleChartResize()
  }, [chartExpanded, fillParent, expandHost, scheduleChartResize])

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
        layout: { fontSize: denseUi ? 12 : 11 },
        timeScale: { rightOffset: storyRightOffset },
      })
    } catch {
      /* ignore */
    }
    scheduleChartResize()
  }, [
    chartHeight,
    tallChart,
    chartExpanded,
    fillParent,
    denseUi,
    storyRightOffset,
    scheduleChartResize,
  ])

  const watchedSetups = useAppStore((s) => s.watchedSetups)
  const upsertWatchedSetup = useAppStore((s) => s.upsertWatchedSetup)
  const removeWatchedSetupLocal = useAppStore((s) => s.removeWatchedSetupLocal)
  const telegramSettings = useAppStore((s) => s.telegramAlertSettings)
  const { showAlert, haptic, userId } = useTelegramWebApp()

  const currentPrice = ticker?.price ?? signal?.price ?? 0
  const lastClose = candles.length ? candles[candles.length - 1][4] : 0
  const mapPrice = currentPrice > 0 ? currentPrice : lastClose
  const liqModel = useLiqHeatmap(symbol, candles, mapPrice, true)
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
  const workerCtx = useWorkerMarketContext()
  const fearGreedValue = useAppStore((s) => s.newsIntel.fearGreed?.value ?? null)
  const isBtcPair = baseSym === 'BTC' || baseSym === 'XBT'

  const indicators = useChartIndicators(
    candles,
    cleanMode ? CLEAN_OFF_INDICATORS : chartPreferences.indicators
  )
  const { priceLevels: basePriceLevels } = useChartZones(
    candles,
    cleanMode
      ? {
          ...chartPreferences.zones,
          fibonacci: false,
          dailyLevels: false,
          poc: false,
          valueArea: false,
        }
      : chartPreferences.zones
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
    candles15m,
    isLoading: mtfLoading,
  } = useMultiTFAnalysis(symbol, currentPrice, true)

  const chartStructure = useMemo(
    () =>
      candles.length >= 16
        ? readTfStructure(candles, structureTfOf(timeframe))
        : null,
    [candles, timeframe]
  )

  const fibMaps = useMemo(() => {
    const px = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 0
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

  const fib141View = useMemo(() => {
    const tf = fibMaps[timeframe]
      ? timeframe
      : fibMaps['4h']
        ? '4h'
        : fibMaps['1d']
          ? '1d'
          : fibMaps['1h']
            ? '1h'
            : null
    if (!tf) return null
    const map = fibMaps[tf]
    const zone = map?.zone141
    if (!map || !zone) return null
    const zoneCandles =
      tf === '1d' ? candles1d : tf === '1h' ? candles1h : tf === '4h' ? candles4h : candles
    const series = zoneCandles.length >= 20 ? zoneCandles : candles
    const zoneAtr = calculateAtr(series, 14) ?? 0
    const reaction = readFib141Reaction(series, map, zoneAtr)
    return {
      kind: 'sweep' as const,
      top: Math.max(zone.top, zone.bottom),
      bottom: Math.min(zone.top, zone.bottom),
      bias: zone.bias,
      price141: map.price141,
      price161: map.price161,
      state: reaction?.state ?? 'NONE',
    }
  }, [fibMaps, timeframe, candles, candles1h, candles4h, candles1d])

  const cont141View = useMemo((): FibZoneLayer | null => {
    const preferred = fibMaps[timeframe]
      ? timeframe
      : fibMaps['4h']
        ? '4h'
        : fibMaps['1d']
          ? '1d'
          : fibMaps['1h']
            ? '1h'
            : null
    if (!preferred) return null
    const zoneCandles =
      preferred === '1d'
        ? candles1d
        : preferred === '1h'
          ? candles1h
          : preferred === '4h'
            ? candles4h
            : candles
    const series = zoneCandles.length >= 25 ? zoneCandles : candles
    if (series.length < 25) return null
    const zone = buildContinuationExtension(series, preferred)
    if (!zone) return null
    const zoneAtr = calculateAtr(series, 14) ?? 0
    const reaction = readContinuationReaction(series, zone, zoneAtr)
    return {
      kind: 'cont',
      top: zone.top,
      bottom: zone.bottom,
      bias: zone.reactionBias,
      price141: zone.level141,
      price161: zone.level161,
      state: reaction?.state ?? 'NONE',
    }
  }, [fibMaps, timeframe, candles, candles1h, candles4h, candles1d])

  const toggleFibTf = useCallback((tf: string) => {
    setFibTfs((prev) => {
      const next = new Set(prev)
      if (next.has(tf)) next.delete(tf)
      else next.add(tf)
      return next
    })
  }, [])

  const m15 = candles15m ?? []
  const src15m =
    m15.length >= 12
      ? m15
      : timeframe === '15m' || timeframe === '5m' || timeframe === '1m'
        ? candles
        : m15
  const structureAnchor = [
    lastClosedBar(src15m, 900_000)?.[0] ?? 0,
    lastClosedBar(
      candles1h.length >= 16 ? candles1h : timeframe === '1h' ? candles : candles1h,
      3_600_000
    )?.[0] ?? 0,
    lastClosedBar(
      candles4h.length >= 16 ? candles4h : timeframe === '4h' ? candles : candles4h,
      14_400_000
    )?.[0] ?? 0,
    lastClosedBar(
      candles1d.length >= 16 ? candles1d : timeframe === '1d' ? candles : candles1d,
      86_400_000
    )?.[0] ?? 0,
    workerCtx?.altBias ?? 'N',
    Math.round((fearGreedValue ?? workerCtx?.fearGreed ?? 50) / 8),
  ].join('|')

  const structureRead = useMemo(() => {
    if (structureStickyRef.current?.key === structureAnchor) {
      return structureStickyRef.current.read
    }
    try {
      const h1src = candles1h.length >= 20 ? candles1h : timeframe === '1h' ? candles : candles1h
      const h4src = candles4h.length >= 16 ? candles4h : timeframe === '4h' ? candles : candles4h
      const dSrc = candles1d.length >= 16 ? candles1d : timeframe === '1d' ? candles : candles1d
      if (h1src.length < 16 && h4src.length < 16 && dSrc.length < 16) {
        structureStickyRef.current = { key: structureAnchor, read: null }
        return null
      }
      const closedPx =
        lastClosedBar(src15m, 900_000)?.[4] ??
        lastClosedBar(h1src, 3_600_000)?.[4] ??
        lastClosedBar(dSrc, 86_400_000)?.[4] ??
        0
      if (!(closedPx > 0) && candles.length < 16) {
        structureStickyRef.current = { key: structureAnchor, read: null }
        return null
      }
      const px = closedPx > 0 ? closedPx : candles[candles.length - 1]?.[4] ?? 0
      const fibSrc = candles.length >= 40 ? candles : dSrc
      const fib = buildGlobalFibonacci(fibSrc, px)
      let liq = null
      try {
        if (candles.length >= 8 && px > 0) {
          liq = buildLiqHeatmap({ candles, currentPrice: px })
        }
      } catch {
        liq = null
      }
      const next = composeStructureRead({
        price: px,
        candles1h: h1src.length >= 16 ? h1src : undefined,
        candles4h: h4src.length >= 16 ? h4src : undefined,
        candles1d: dSrc.length >= 16 ? dSrc : undefined,
        candles1w: candles1w.length >= 8 ? candles1w : undefined,
        candles15m: src15m.length >= 12 ? src15m : undefined,
        candlesTape: src15m.length >= 8 ? src15m : candles.length >= 8 ? candles : undefined,
        fib,
        zoneAtr: calculateAtr(fibSrc, 14) ?? 0,
        liq,
        mmDrive: mmSnap?.drive ?? null,
        mmStopHunt: mmHunt?.microIsStopHunt,
        mmHuntSide: mmHunt?.preferredSide ?? null,
        mmMicroTarget: mmHunt?.microTarget ?? null,
        mmMacroTarget: mmHunt?.macroTarget ?? null,
        equalHighs: eqLiquidityMap?.equalHighs,
        equalLows: eqLiquidityMap?.equalLows,
        altBias: workerCtx?.altBias ?? null,
        altRegime: workerCtx?.altRegime ?? null,
        fearGreed: fearGreedValue ?? workerCtx?.fearGreed ?? null,
        btcDominance: workerCtx?.btcDominance ?? null,
        btcDomDelta24h: workerCtx?.btcDomDelta24h ?? null,
        total3Delta24h: workerCtx?.total3Delta24h ?? workerCtx?.totalMcapDelta24h ?? null,
        macroAltTilt: deriveMacroStructure({
          btcD: workerCtx?.macroSeries?.btcD,
          total3: workerCtx?.macroSeries?.total3,
          others: workerCtx?.macroSeries?.others,
        }).altTilt,
        newsBias,
        newsScore,
        btcRs,
        isBtc: isBtcPair,
        symbol: flatSymbol,
        walls: orderBookMetrics?.walls ?? null,
        buyerPct:
          signal?.buyerAggression && signal.buyerAggression.buyToSellRatio > 0
            ? (signal.buyerAggression.buyToSellRatio /
                (1 + signal.buyerAggression.buyToSellRatio)) *
              100
            : null,
      })
      structureStickyRef.current = { key: structureAnchor, read: next }
      return next
    } catch (err) {
      logger.warn('structure read failed', err)
      structureStickyRef.current = { key: structureAnchor, read: null }
      return null
    }
  }, [
    structureAnchor,
    candles,
    candles1h,
    candles4h,
    candles1d,
    candles1w,
    src15m,
    timeframe,
    mmSnap?.drive,
    mmHunt?.microIsStopHunt,
    mmHunt?.preferredSide,
    mmHunt?.microTarget,
    mmHunt?.macroTarget,
    eqLiquidityMap?.equalHighs,
    eqLiquidityMap?.equalLows,
    workerCtx?.altBias,
    workerCtx?.altRegime,
    workerCtx?.fearGreed,
    workerCtx?.btcDominance,
    workerCtx?.btcDomDelta24h,
    workerCtx?.total3Delta24h,
    workerCtx?.totalMcapDelta24h,
    workerCtx?.macroSeries,
    fearGreedValue,
    newsBias,
    newsScore,
    btcRs,
    isBtcPair,
    flatSymbol,
    orderBookMetrics?.walls,
    signal?.buyerAggression?.buyToSellRatio,
  ])

  const setAdvisorStructure = useAdvisorStore((s) => s.setStructure)
  useEffect(() => {
    setAdvisorStructure(flatSymbol, structureRead)
  }, [flatSymbol, structureRead, setAdvisorStructure])

  useEffect(() => {
    structureStickyRef.current = null
  }, [symbol])

  const liveZones = useMemo(() => {
    if (!(currentPrice > 0) || candles.length < 12) return structureRead?.zones ?? null
    try {
      const htf =
        candles4h.length >= 16 ? candles4h : candles1h.length >= 16 ? candles1h : undefined
      return buildZoneReactionBoard({
        candles,
        htfCandles: htf && htf !== candles ? htf : undefined,
        candles1h: candles1h.length >= 2 ? candles1h : candles,
        candles4h: candles4h.length >= 2 ? candles4h : undefined,
        tape: candles,
        price: currentPrice,
        dealingHigh: structureRead?.h4?.dealingHigh ?? structureRead?.h1?.dealingHigh,
        dealingLow: structureRead?.h4?.dealingLow ?? structureRead?.h1?.dealingLow,
        structureHeld: Boolean(
          (structureRead?.h1?.lastReclaim?.held || structureRead?.h4?.lastReclaim?.held) &&
            structureRead?.h1?.lastReclaim
        ),
        preferredSide:
          structureRead?.preferredSide ??
          (structureRead?.scenarios?.scenarios[0]?.side === 'BOTH'
            ? null
            : structureRead?.scenarios?.scenarios[0]?.side ?? null),
        magnet: structureRead?.magnet,
        equalHighs: eqLiquidityMap?.equalHighs,
        equalLows: eqLiquidityMap?.equalLows,
      })
    } catch {
      return structureRead?.zones ?? null
    }
  }, [
    candles,
    candles1h,
    candles4h,
    currentPrice,
    structureRead,
    eqLiquidityMap?.equalHighs,
    eqLiquidityMap?.equalLows,
  ])

  const hudRead = useMemo((): StructureRead | null => {
    if (!structureRead) return null
    if (!liveZones) return structureRead
    return { ...structureRead, zones: liveZones }
  }, [structureRead, liveZones])

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

  const candidateZones = useMemo((): LiquidityZone[] => {
    const lastTs =
      candles.length > 0
        ? Math.floor(candles[candles.length - 1][0] / 1000)
        : Math.floor(Date.now() / 1000)
    const visibleEnd = lastTs as Time

    const zones: LiquidityZone[] = []

    if (showSrZones) {
      const sr = srBoardToLiquidityZones(liveZones, visibleEnd)
      if (sr.length) {
        zones.push(...sr)
      } else {
        const cong = findCongestionZones(candles, 4)
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
    zonesMode,
    foundChartZones,
    liveZones,
  ])

  const priceLevels = useMemo(() => {
    const retrace = new Set([0.236, 0.382, 0.5, 0.618, 0.786])
    const autoTf =
      timeframe === '1h' || timeframe === '4h' || timeframe === '1d' ? timeframe : null
    const tfs = new Set(fibTfs)
    if (autoTf && !cleanMode) tfs.add(autoTf)
    if (autoTf && cleanMode && fibTfs.size === 0) tfs.add(autoTf)

    const extColors: Record<string, string> = {
      '1h': 'rgba(251, 191, 36, 0.55)',
      '4h': 'rgba(34, 211, 238, 0.55)',
      '1d': 'rgba(167, 139, 250, 0.55)',
    }
    const out: typeof basePriceLevels = []
    for (const tf of tfs) {
      const fib = fibMaps[tf]
      if (!fib?.levels?.length) continue
      const extra = fibTfs.has(tf)
      for (const lv of fib.levels) {
        if (retrace.has(lv.ratio)) {
          if (cleanMode && lv.ratio !== 0.618) continue
          // Without an explicitly pinned fib timeframe, 0.618 alone carries
          // the read. Extra levels would turn the plot into a lined notebook.
          if (!extra && lv.ratio !== 0.618) continue
          const is618 = lv.ratio === 0.618
          out.push({
            id: `gfib_${tf}_${lv.ratio}`,
            type: is618 ? 'FIB_618' : 'FIB_OTE',
            price: lv.price,
            label: String(lv.ratio),
            color: is618
              ? 'rgba(251, 191, 36, 0.42)'
              : 'rgba(148, 163, 184, 0.24)',
            lineStyle: 0,
          })
        }
        if (extra && (lv.ratio === 1.414 || lv.ratio === 1.618)) {
          out.push({
            id: `gfib_${tf}_${lv.ratio}`,
            type: 'FIB_OTE',
            price: lv.price,
            label: lv.ratio === 1.414 ? '1.414' : '1.618',
            color: extColors[tf] ?? 'rgba(251, 191, 36, 0.45)',
            lineStyle: 0,
          })
        }
      }
    }
    if (cleanMode) return out.slice(0, 3)
    return out
  }, [fibTfs, fibMaps, timeframe, basePriceLevels, cleanMode])

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
    setBouncesMode(false)
    setBounceResult(null)
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
          ? `${styleTag}: ${serverWatches} сетапов на сервере · жди сетап`
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

    toolsSymbolRef.current = symbol
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
        `${serverWatches} сделок на сервере · ${result.globalView.bias} · магнит ${
          result.magnet ? result.magnet.label : 'R-лестница'
        }`
      )
    } else if (!chatId) {
      /* already alerted */
    } else {
      showAlert(
        `Сделки: ${result.trades.length} · ${result.globalView.bias}` +
          (result.trades[0]
            ? ` · топ ${result.trades[0].side}`
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

  const handleFindLiveSignal = useCallback(async () => {
    if (!(currentPrice > 0) || candles.length < 20) {
      showAlert('Нужны свечи и цена — подождите загрузку графика')
      return
    }
    setZonesMode(false)
    setTradesMode(false)

    const tradeStyle = horizonToStyle(forecastHorizon)
    const crowd = await fetchCrowdContext(symbol)
    const marketContext = buildFullMarketContext({
      candles1d,
      price: currentPrice,
      mm: mmSnap,
      crowd,
    })
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
      marketContext,
      crowd,
    })

    toolsSymbolRef.current = symbol
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
        ? `\nSEQ ${result.sequence.kind}`
        : ''
    showAlert(
      `Сигнал: ${p.side !== 'FLAT' ? p.side + ' · ' : ''}${p.title}\n${
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
      showAlert(`Ювелирный ${s.side} → бот · TP ${s.target.toPrecision(5)}`)
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

  const chartAtr = useMemo(
    () => calculateAtr(candles, 14) ?? Math.max(currentPrice * 0.004, 1e-8),
    [candles, currentPrice]
  )

  const handleClearBounces = useCallback(() => {
    setBouncesMode(false)
    setBounceResult(null)
  }, [])

  const handleFindBounces = useCallback(() => {
    if (!(currentPrice > 0) || candles.length < 20) {
      showAlert('Нужны свечи и цена — подождите загрузку графика')
      return
    }
    setSignalMode(false)
    setLiveSignal(null)
    setTradesMode(false)
    setZonesMode(false)
    setShowSetupPicker(false)
    setTradesGlobalView(null)
    setTradesMagnet(null)
    setAdvisor(null)
    setShowHints(false)
    setShowDirection(false)
    setOnlyStrong(true)
    writeLsFlag('enterprise_only_strong', true)

    const tradeStyle = horizonToStyle(forecastHorizon)
    const result = findBounceSetups({
      candles,
      symbol,
      flatSymbol,
      price: currentPrice,
      atr: chartAtr,
      liquidityMap: eqLiquidityMap,
      board: liveZones,
      tradeStyle,
    })
    setBounceResult(result)
    setBouncesMode(true)
    setPickedSetups(result.setups)
    setSelectedSetupId(result.setups[0]?.id ?? null)
    setShowForecast(false)
    haptic.success()
    if (!result.zones.length) {
      showAlert('Сильных зон отскока рядом нет — смени ТФ или пару')
    }
  }, [
    currentPrice,
    candles,
    symbol,
    flatSymbol,
    chartAtr,
    eqLiquidityMap,
    liveZones,
    forecastHorizon,
    showAlert,
    haptic,
  ])

  const ictRead = useMemo(
    () =>
      readIctStructure({
        candles,
        candles1d:
          candles1d.length >= 8 ? candles1d : timeframe === '1d' ? candles : candles1d,
        candles1w: candles1w.length >= 3 ? candles1w : undefined,
        barSeconds: timeframeBarSeconds(timeframe),
        price: currentPrice,
      }),
    [candles, candles1d, candles1w, timeframe, currentPrice]
  )

  const chartStory = useMemo(
    () =>
      buildChartStory({
        zones: candidateZones,
        price: currentPrice,
        atr: chartAtr,
        board: liveZones,
        structure: hudRead,
        setup: selectedSetup,
        focusId: advisor?.zoneId ?? highlightedZoneId ?? null,
        launchId: actionPick.launchId,
        barSeconds: timeframeBarSeconds(timeframe),
        onlyStrong: cleanMode || onlyStrong,
        candles,
        signal,
        liquidityMap: eqLiquidityMap,
        sequence:
          sequenceHit && sequenceHit.expiresAt > Date.now() ? sequenceHit : null,
        whale: whaleState,
        walls: orderBookMetrics?.walls ?? null,
        liqHeatmap: liqModel,
        mmIntent: mmSnap,
        ict: ictRead,
      }),
    [
      candidateZones,
      currentPrice,
      chartAtr,
      liveZones,
      hudRead,
      selectedSetup,
      advisor?.zoneId,
      highlightedZoneId,
      actionPick.launchId,
      timeframe,
      onlyStrong,
      cleanMode,
      candles,
      signal,
      eqLiquidityMap,
      sequenceHit,
      whaleState,
      orderBookMetrics?.walls,
      liqModel,
      mmSnap,
      ictRead,
    ]
  )

  const ictMarks = useMemo(
    () =>
      selectIctOverlayMarks(ictRead, {
        clean: cleanMode || onlyStrong,
        price: currentPrice,
        atr: chartAtr,
        fuelPrice: chartStory.fuel?.price,
        targetPrice: chartStory.future?.targetPrice,
        spent: chartStory.spent,
      }),
    [
      ictRead,
      cleanMode,
      onlyStrong,
      currentPrice,
      chartAtr,
      chartStory.fuel?.price,
      chartStory.future?.targetPrice,
      chartStory.spent,
    ]
  )

  const overlayZones = bouncesMode
    ? bounceResult?.zones ?? []
    : cleanMode || onlyStrong
      ? chartStory.displayZones
      : candidateZones
  const tapZones = bouncesMode
    ? bounceResult?.zones ?? []
    : cleanMode || onlyStrong
      ? overlayZones
      : candidateZones

  /**
   * 🧰 Автоматические «сундучки»: лимитки на отскок от важных зон.
   * Не требуют нажатия «Зоны» — живут на графике постоянно, пока
   * цена не вошла в зону. Только движения цели 1–5 %.
   */
  const autoCases = useMemo((): LimitCase[] => {
    if (!(currentPrice > 0) || candles.length < 20) return []
    const seen = new Set<string>()
    const zones: LiquidityZone[] = []
    for (const z of [
      ...chartStory.displayZones,
      ...overlayZones,
      ...candidateZones,
    ]) {
      if (!z || seen.has(z.id)) continue
      seen.add(z.id)
      zones.push(z)
    }
    const recent = candles.slice(-6)
    const momentumPct =
      recent.length >= 2 && recent[0][4] > 0
        ? ((recent[recent.length - 1][4] - recent[0][4]) / recent[0][4]) * 100
        : null
    const buyerAggression =
      signal?.buyerAggression && signal.buyerAggression.buyToSellRatio > 0
        ? (signal.buyerAggression.buyToSellRatio /
            (1 + signal.buyerAggression.buyToSellRatio)) *
          100
        : null
    return buildLimitCases({
      zones,
      price: currentPrice,
      atr: chartAtr,
      timeframe,
      orderBookImbalance: orderBookMetrics?.imbalance ?? null,
      buyerAggression,
      momentumPct,
      structureSide: structureRead?.preferredSide ?? null,
      maxCases: 3,
      minMovePct: 1,
      maxMovePct: 5,
    })
  }, [
    currentPrice,
    candles,
    chartAtr,
    timeframe,
    chartStory.displayZones,
    overlayZones,
    candidateZones,
    orderBookMetrics?.imbalance,
    signal?.buyerAggression?.buyToSellRatio,
    structureRead?.preferredSide,
  ])

  useEffect(() => {
    storyPickedRef.current = false
    setStoryPathId(null)
    setBouncesMode(false)
    setBounceResult(null)
  }, [symbol, timeframe])

  // No auto-picked arrows: a scenario path is drawn only after the user
  // explicitly selects it (ScenarioBoard) or clicks a zone.
  useEffect(() => {
    if (!storyPickedRef.current) setStoryPathId(null)
  }, [symbol, timeframe])

  useEffect(() => {
    const series = candleRef.current
    if (!series) return
    const picked = storyPathId
      ? chartStory.scenarios.find((s) => s.id === storyPathId) ?? null
      : null
    const paths = picked ? [picked] : []
    const prices: number[] = []
    for (const sc of paths) {
      for (const p of sc.path) if (p.price > 0) prices.push(p.price)
      if (sc.toPrice && sc.toPrice > 0) prices.push(sc.toPrice)
    }
    // Keep the clicked-zone arrow inside the visible price window.
    if (advisor) {
      const leg = advisorMode === 'hold' ? advisor.primary : advisor.alternate
      for (const p of leg.path) if (p.price > 0) prices.push(p.price)
    }
    if (!prices.length) {
      series.applyOptions({ autoscaleInfoProvider: undefined })
      return
    }
    series.applyOptions({
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const base = original()
        if (!base?.priceRange) return base
        let min = base.priceRange.minValue
        let max = base.priceRange.maxValue
        for (const p of prices) {
          min = Math.min(min, p)
          max = Math.max(max, p)
        }
        const pad = Math.max((max - min) * 0.1, 1e-8)
        return {
          ...base,
          priceRange: { minValue: min - pad, maxValue: max + pad },
        }
      },
    })
    return () => {
      try {
        series.applyOptions({ autoscaleInfoProvider: undefined })
      } catch {
        /* chart may already be gone */
      }
    }
  }, [chartStory, storyPathId, chartReady, advisor, advisorMode])

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
        if (!silent && !lwcDataRef.current.length) {
          setLoading(true)
          setError(null)
        }
        const data = await fetchOhlcv(symbol, timeframe, CANDLE_LIMIT[timeframe])
        if (cancelled) return
        if (!data.length) {
          if (!silent && !lwcDataRef.current.length) {
            setError(tRef.current('chart_empty'))
          }
          return
        }

        const mapped: CandlestickData[] = data
          .filter(
            (c) =>
              Number.isFinite(c[0]) &&
              Number.isFinite(c[1]) &&
              Number.isFinite(c[2]) &&
              Number.isFinite(c[3]) &&
              Number.isFinite(c[4])
          )
          .map((c) => ({
            time: (c[0] / 1000) as Time,
            open: c[1],
            high: c[2],
            low: c[3],
            close: c[4],
          }))
        if (!mapped.length) {
          if (!silent && !lwcDataRef.current.length) {
            setError(tRef.current('chart_empty'))
          }
          return
        }
        setCandles(data)
        seedHitBaselineFromCandles(symbol, data)
        setLwcData(mapped)
        setError(null)
      } catch (err) {
        logger.warn('LiveChart klines failed', err)
        if (!cancelled && !silent && !lwcDataRef.current.length) {
          setError(tRef.current('chart_error'))
        }
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
  }, [symbol, timeframe])

  useEffect(() => {
    let cancelled = false
    let chart: IChartApi | null = null
    let sizeRo: ResizeObserver | null = null
    let waitRo: ResizeObserver | null = null

    const onInteractStart = () => {
      userPanningRef.current = true
    }
    const onInteractEnd = () => {
      window.setTimeout(() => {
        userPanningRef.current = false
      }, 180)
    }

    const mountChart = () => {
      if (cancelled || chartRef.current) return
      const el = containerRef.current
      if (!el) return
      const startW = Math.floor(el.clientWidth)
      const startH = Math.floor(el.clientHeight)
      if (startW < 16 || startH < 16) return

      try {
        chart = createChart(el, {
          layout: {
            ...CHART_LAYOUT,
            fontSize: denseUi ? 12 : 11,
          },
          grid: CHART_GRID_LINES,
          crosshair: {
            mode: CrosshairMode.Magnet,
            ...CHART_CROSSHAIR_LINES,
          },
          timeScale: {
            ...CHART_TIME_SCALE,
            rightOffset: denseUi ? 18 : 22,
            barSpacing: 8,
            minBarSpacing: 2,
            lockVisibleTimeRangeOnResize: false,
            shiftVisibleRangeOnNewBar: true,
          },
          rightPriceScale: {
            ...CHART_PRICE_SCALE,
            scaleMargins: { top: 0.08, bottom: 0.12 },
            autoScale: true,
            entireTextOnly: true,
            alignLabels: true,
            ticksVisible: false,
          },
          width: startW,
          height: startH,
          handleScroll: {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            // Vertical drag fights price-scale zoom on phones — keep TV-like feel
            vertTouchDrag: false,
          },
          handleScale: {
            axisPressedMouseMove: { time: true, price: true },
            mouseWheel: true,
            pinch: true,
            axisDoubleClickReset: false,
          },
          kineticScroll: {
            touch: true,
            mouse: false,
          },
        })
      } catch (err) {
        logger.warn('LiveChart createChart failed', err)
        return
      }

      // Volume sits inside the chart on its own overlay scale, like the
      // exchange terminal — the candle scale keeps the upper 82% of the plot.
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        lastValueVisible: false,
        priceLineVisible: false,
      })
      try {
        volumeSeries.priceScale().applyOptions({
          scaleMargins: { top: 0.82, bottom: 0 },
        })
      } catch {
        /* older lightweight-charts build */
      }

      const candleSeries = chart.addCandlestickSeries({
        upColor: CHART_UP,
        downColor: CHART_DOWN,
        borderUpColor: CHART_UP,
        borderDownColor: CHART_DOWN,
        wickUpColor: CHART_UP,
        wickDownColor: CHART_DOWN,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineColor: CHART_PRICE_LINE,
        priceLineWidth: 1,
        priceLineStyle: 2,
      })

      chartRef.current = chart
      candleRef.current = candleSeries
      volumeRef.current = volumeSeries
      setChartInstance(chart)
      setChartReady((n) => n + 1)
      waitRo?.disconnect()
      waitRo = null

      const painted = lwcDataRef.current
      if (painted.length) {
        try {
          candleSeries.setData(painted)
        } catch {
          /* ignore */
        }
      }

      el.addEventListener('touchstart', onInteractStart, { passive: true })
      el.addEventListener('touchend', onInteractEnd, { passive: true })
      el.addEventListener('mousedown', onInteractStart)
      el.addEventListener('mouseup', onInteractEnd)
      el.addEventListener('mouseleave', onInteractEnd)
      el.addEventListener('wheel', onInteractStart, { passive: true })

      sizeRo = new ResizeObserver((entries) => {
        if (!entries.length || !chartRef.current) return
        const w = Math.floor(entries[0].contentRect.width)
        const h = Math.floor(entries[0].contentRect.height)
        if (w < 16 || h < 16) return
        if (userPanningRef.current) return
        try {
          chart?.applyOptions({
            width: w,
            height: h,
          })
        } catch {
          /* ignore */
        }
      })
      sizeRo.observe(el)
    }

    mountChart()
    if (!chartRef.current && containerRef.current) {
      waitRo = new ResizeObserver(() => mountChart())
      waitRo.observe(containerRef.current)
    }

    return () => {
      cancelled = true
      waitRo?.disconnect()
      sizeRo?.disconnect()
      const el = containerRef.current
      el?.removeEventListener('touchstart', onInteractStart)
      el?.removeEventListener('touchend', onInteractEnd)
      el?.removeEventListener('mousedown', onInteractStart)
      el?.removeEventListener('mouseup', onInteractEnd)
      el?.removeEventListener('mouseleave', onInteractEnd)
      el?.removeEventListener('wheel', onInteractStart)
      const instance = chart
      if (!instance) {
        chartRef.current = null
        candleRef.current = null
        return
      }
      Object.values(lineRefs.current).forEach((s) => {
        try {
          instance.removeSeries(s)
        } catch {
          /* ignore */
        }
      })
      lineRefs.current = {}
      priceLineRefs.current = []
      liqLineRefs.current = []
      volumeRef.current = null
      try {
        instance.remove()
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
    try {
      candleRef.current.setData(lwcData)
      if (needFit) {
        const vis =
          timeframe === '1m' || timeframe === '5m' ? 90 : 70
        const from = Math.max(-2, lwcData.length - vis)
        chartRef.current?.timeScale().setVisibleLogicalRange({
          from,
          to: lwcData.length + Math.max(storyRightOffset, 26),
        })
        fittedKeyRef.current = key
      }
    } catch {
      /* 0-size host during portal move */
    }
  }, [lwcData, symbol, timeframe, chartReady, storyRightOffset])

  useEffect(() => {
    if (!candleRef.current || !ticker || !lwcData.length) return
    if (timeframe === '4h' || timeframe === '1d') return
    if (userPanningRef.current) return

    const last = lwcData[lwcData.length - 1]
    const p = ticker.price
    if (Math.abs(last.close - p) / Math.max(p, 1e-12) < 0.00005) return

    try {
      candleRef.current.update({
        ...last,
        close: p,
        high: Math.max(last.high, p),
        low: Math.min(last.low, p),
      })
    } catch {
      /* chart may be mid-portal */
    }
  }, [ticker?.price, lwcData, timeframe])

  useEffect(() => {
    const series = candleRef.current
    if (!series || !structureRead || !lwcData.length) {
      try {
        series?.setMarkers([])
      } catch {
        /* ignore */
      }
      return
    }
    try {
      if (cleanMode) {
        series.setMarkers([])
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
    } catch (err) {
      logger.warn('structure markers failed', err)
    }
  }, [structureRead, lwcData, chartReady, cleanMode])

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

  // Volume histogram inside the plot (TradingView-style), tinted by candle side.
  useEffect(() => {
    const series = volumeRef.current
    if (!series) return
    if (!chartPreferences.indicators.volume || indicators.volume.length === 0) {
      series.setData([])
      return
    }
    const data: HistogramData[] = indicators.volume.map((v) => {
      const bullish =
        (v.color ?? '').includes('34, 197, 94') ||
        (v.color ?? '').includes('34,197,94')
      return {
        time: v.time,
        value: v.value,
        color: bullish ? CHART_UP_FILL : CHART_DOWN_FILL,
      }
    })
    try {
      series.setData(data)
    } catch {
      /* chart may be mid-portal */
    }
  }, [indicators.volume, chartReady, chartPreferences.indicators.volume])

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

    // Fib retrace / 141 — hairline + in-plot tag. Axis labels only for the
    // one level that matters in clean mode, so the price scale never stacks.
    for (const level of priceLevels) {
      addLine(level.price, level.color, level.label || '', {
        lineStyle: level.lineStyle ?? 2,
        lineWidth: 1,
        axisLabel: cleanMode && level.label === '0.618',
      })
    }

    const focusZone = chartStory.primary
    if (focusZone && focusZone.top !== focusZone.bottom) {
      const up = focusZone.side !== 'BEARISH'
      const color = up ? 'rgba(45, 212, 191, 0.95)' : 'rgba(251, 113, 133, 0.95)'
      // The band is drawn by ChartOverlay; here we only add hairline edges.
      // No axis pill: it lands on top of the tick labels and the band already
      // has a named tag. Fewer numbers on the scale = easier reading.
      addLine(focusZone.top, color, '', {
        lineStyle: 0,
        lineWidth: 1,
        axisLabel: false,
      })
      addLine(focusZone.bottom, color, '', {
        lineStyle: 0,
        lineWidth: 1,
        axisLabel: false,
      })
    }

    if (!cleanMode && onlyStrong && liveZones?.reactions && focusZone) {
      const primaryRole =
        focusZone.side === 'BULLISH'
          ? 'SUPPORT'
          : focusZone.side === 'BEARISH'
            ? 'RESISTANCE'
            : null
      const opp = liveZones.reactions.find(
        (r) =>
          r.zone.id !== focusZone.id &&
          r.zone.tier !== 'WEAK' &&
          (!primaryRole || r.zone.role !== primaryRole)
      )
      const lineZone =
        opp ??
        liveZones.reactions.find(
          (r) => r.zone.id !== focusZone.id && r.zone.role === 'RESISTANCE'
        )
      if (lineZone) {
        const resist = lineZone.zone.role === 'RESISTANCE'
        const px = resist ? lineZone.zone.bottom : lineZone.zone.top
        addLine(
          px,
          resist ? 'rgba(251, 113, 133, 0.75)' : 'rgba(45, 212, 191, 0.65)',
          '',
          { lineStyle: 0, lineWidth: 1, axisLabel: false }
        )
      }
    }

    // Limit LONG / SHORT — where to rest the order on the chart.
    // Side-colored axis titles so both directions read at a glance.
    const paintedLimits: number[] = []
    const nearLimit = (px: number) =>
      paintedLimits.some(
        (p) => Math.abs(p - px) / Math.max(Math.abs(px), 1e-12) < 0.0008
      )
    const addLimit = (price: number, side: 'LONG' | 'SHORT') => {
      if (!(price > 0) || nearLimit(price)) return
      paintedLimits.push(price)
      const long = side === 'LONG'
      addLine(
        price,
        long ? 'rgba(45, 212, 191, 0.98)' : 'rgba(251, 113, 133, 0.98)',
        long ? 'LONG' : 'SHORT',
        { lineStyle: 0, lineWidth: 1, axisLabel: true }
      )
    }

    if (selectedSetup?.limitEntry && selectedSetup.limitEntry > 0) {
      addLimit(selectedSetup.limitEntry, selectedSetup.side)
    }

    const surg = signal?.surgicalEntry
    if (
      surg?.status === 'READY' &&
      surg.limitEntry != null &&
      surg.limitEntry > 0 &&
      (surg.side === 'LONG' || surg.side === 'SHORT')
    ) {
      addLimit(surg.limitEntry, surg.side)
    }

    // Bounce mode: all limit lines from bounce result
    if (bouncesMode && bounceResult?.limits.length) {
      for (const lim of bounceResult.limits) {
        addLimit(lim.price, lim.side)
      }
    }

    // Zones / trades: show both nearest long and short limit levels
    if ((zonesMode || tradesMode) && foundZones.length) {
      const nearest = (side: 'LONG' | 'SHORT') =>
        [...foundZones]
          .filter((z) => z.side === side && z.limitEntry > 0)
          .sort(
            (a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct)
          )[0]
      const longZ = nearest('LONG')
      const shortZ = nearest('SHORT')
      if (longZ) addLimit(longZ.limitEntry, 'LONG')
      if (shortZ) addLimit(shortZ.limitEntry, 'SHORT')
    }

    // 🧰 «Сундучки»: уровни отложенных лимиток на отскок от зон.
    if (showCases && autoCases.length) {
      for (const item of autoCases) {
        addLimit(item.entry, item.side)
      }
    }

    // Story ENTRY pin → same axis line when no setup/zones painted yet
    if (paintedLimits.length === 0) {
      const entryPin = chartStory.comments.find((c) => c.kind === 'ENTRY')
      if (
        entryPin &&
        entryPin.price > 0 &&
        (entryPin.side === 'LONG' || entryPin.side === 'SHORT')
      ) {
        addLimit(entryPin.price, entryPin.side)
      } else if (
        chartStory.side &&
        chartStory.primary &&
        (chartStory.nowKind === 'IN_ZONE' || chartStory.nowKind === 'BOUNCE')
      ) {
        const mid =
          (chartStory.primary.top + chartStory.primary.bottom) / 2
        if (mid > 0) addLimit(mid, chartStory.side)
      }
    }

    // SL / TP only in signal mode or selected setup
    if (signalMode || selectedSetup) {
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
    zonesMode,
    tradesMode,
    bouncesMode,
    bounceResult,
    foundZones,
    showSrZones,
    overlayZones,
    chartStory.primary,
    chartStory.comments,
    chartStory.side,
    chartStory.nowKind,
    liveZones,
    onlyStrong,
    cleanMode,
    advisor?.zoneId,
    highlightedZoneId,
    actionPick.launchId,
    showCases,
    autoCases,
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

      const title = ''

      try {
        const line = series.createPriceLine({
          price: level.price,
          color,
          lineWidth: 1,
          lineStyle,
          // Prices already live on the axis; extra colored pills just fight it.
          axisLabelVisible: false,
          title,
        })
        liqLineRefs.current.push(line)
      } catch {
        /* ignore */
      }
    }

    // Только ближайшие сильные уровни — иначе каша линий
    const highs = [...eqLiquidityMap.equalHighs]
      .filter((l) => l.strength === 'STRONG')
      .sort((a, b) => a.distancePct - b.distancePct)
      .slice(0, 1)
    const lows = [...eqLiquidityMap.equalLows]
      .filter((l) => l.strength === 'STRONG')
      .sort((a, b) => a.distancePct - b.distancePct)
      .slice(0, 1)

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

  const whaleSit = useMemo(
    () =>
      buildWhaleSitMap({
        price: mapPrice,
        whale: whaleState,
        liquidityMap: eqLiquidityMap,
        liqHeatmap: liqModel,
        walls: orderBookMetrics?.walls ?? null,
        spent: chartStory.spent,
      }),
    [
      mapPrice,
      whaleState,
      eqLiquidityMap,
      liqModel,
      orderBookMetrics?.walls,
      chartStory.spent,
    ]
  )

  const resetChartView = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.priceScale('right').applyOptions({ autoScale: true })
    const n = lwcData.length
    if (n > 2) {
      const vis = timeframe === '1m' || timeframe === '5m' ? 90 : 70
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(-2, n - vis),
        to: n + Math.max(storyRightOffset, 26),
      })
    } else {
      chart.timeScale().fitContent()
    }
    haptic.impact()
  }, [haptic, lwcData.length, timeframe, storyRightOffset])

  /** Everything the zone card needs besides the zone itself. */
  const zoneContextFor = useCallback(
    (zone: LiquidityZone): ZoneContext => {
      const top = Math.max(zone.top, zone.bottom)
      const bottom = Math.min(zone.top, zone.bottom)
      const mid = (top + bottom) / 2
      const strength = zone.strength ?? 0
      const tier: ZoneContext['tier'] =
        zone.strengthTier ??
        (strength >= 9 ? 'STRONG' : strength >= 6 ? 'MEDIUM' : 'WEAK')

      const findFib = (): ZoneContextFib | null => {
        for (const tf of [timeframe, '4h', '1d', '1h']) {
          const map = fibMaps[tf]
          if (!map) continue
          let best: { ratio: number; price: number } | null = null
          let bestPct = Infinity
          for (const lvl of map.levels) {
            if (!(lvl.price > 0)) continue
            const gap =
              lvl.price > top
                ? lvl.price - top
                : lvl.price < bottom
                  ? bottom - lvl.price
                  : 0
            const pct = (gap / mid) * 100
            if (pct < bestPct) {
              bestPct = pct
              best = { ratio: lvl.ratio, price: lvl.price }
            }
          }
          if (best && bestPct <= 1.4) return { ...best, tf, distPct: bestPct }
        }
        return null
      }

      const bandOf = (src: FibZoneLayer): ZoneContext141 => ({
        kind: src.kind,
        state: src.state,
        bias: src.bias,
        top: src.top,
        bottom: src.bottom,
        price141: src.price141,
        price161: src.price161,
      })
      let fib141: ZoneContext141 | null = null
      let bestOverlap = 0
      for (const src of [fib141View, cont141View]) {
        if (!src) continue
        const hi = Math.min(top, src.top)
        const lo = Math.max(bottom, src.bottom)
        const bandH = Math.max(1e-9, src.top - src.bottom)
        const ov = hi > lo ? (hi - lo) / bandH : 0
        if (ov > bestOverlap) {
          bestOverlap = ov
          fib141 = bandOf(src)
        }
      }
      if (bestOverlap < 0.25) {
        fib141 = null
        let nearPct = Infinity
        for (const src of [fib141View, cont141View]) {
          if (!src) continue
          const pct = (Math.abs((src.top + src.bottom) / 2 - mid) / mid) * 100
          if (pct <= 1.2 && pct < nearPct) {
            nearPct = pct
            fib141 = bandOf(src)
          }
        }
      }

      const eq = eqLiquidityMap
      const above = [...(eq?.equalHighs ?? [])]
        .filter((l) => l.isActive && l.price > top)
        .sort((a, b) => a.price - b.price)[0]
      const below = [...(eq?.equalLows ?? [])]
        .filter((l) => l.isActive && l.price < bottom)
        .sort((a, b) => b.price - a.price)[0]
      const h4 = hudRead?.h4
      const liqAbove: ZoneContextLiq | null = above
        ? {
            price: above.price,
            label: `BSL ×${above.touches}`,
            distPct: ((above.price - mid) / mid) * 100,
          }
        : h4?.nextBsl != null && h4.nextBsl > top
          ? {
              price: h4.nextBsl,
              label: 'BSL 4ч',
              distPct: ((h4.nextBsl - mid) / mid) * 100,
            }
          : null
      const liqBelow: ZoneContextLiq | null = below
        ? {
            price: below.price,
            label: `SSL ×${below.touches}`,
            distPct: ((mid - below.price) / mid) * 100,
          }
        : h4?.nextSsl != null && h4.nextSsl < bottom
          ? {
              price: h4.nextSsl,
              label: 'SSL 4ч',
              distPct: ((mid - h4.nextSsl) / mid) * 100,
            }
          : null

      let swept: ZoneContextSweep | null = null
      let bestGap = 0.035
      for (const pool of [chartStory.spent.ssl, chartStory.spent.bsl]) {
        if (!pool) continue
        const gap = Math.abs(pool.price - mid) / mid
        if (gap < bestGap) {
          bestGap = gap
          swept = {
            side: pool.kind,
            price: pool.price,
            barsAgo: pool.barsAgo,
            reclaimed: pool.reclaimed,
          }
        }
      }

      const recent = candles.slice(-6)
      const momentumPct = recent.length >= 2 && recent[0][4] > 0
        ? ((recent[recent.length - 1][4] - recent[0][4]) / recent[0][4]) * 100
        : null
      const buyerAggression =
        signal?.buyerAggression && signal.buyerAggression.buyToSellRatio > 0
          ? (signal.buyerAggression.buyToSellRatio / (1 + signal.buyerAggression.buyToSellRatio)) * 100
          : null

      return {
        orderBookImbalance: orderBookMetrics?.imbalance ?? null,
        buyerAggression,
        momentumPct,
        strength,
        tier,
        fib: findFib(),
        fib141,
        liqAbove,
        liqBelow,
        swept,
      }
    },
    [
      timeframe,
      fibMaps,
      fib141View,
      cont141View,
      eqLiquidityMap,
      hudRead,
      chartStory.spent,
      candles,
      orderBookMetrics?.imbalance,
      signal?.buyerAggression?.buyToSellRatio,
    ]
  )

  const handleZoneHover = useCallback(
    (zone: LiquidityZone, x: number, y: number) => {
      if (advisor || !(currentPrice > 0)) return
      const brief = analyzeZoneTap({
        zone,
        price: currentPrice,
        structure: hudRead,
        timeframe,
        context: zoneContextFor(zone),
      })
      if (!brief) return
      setHoverAdvisor(brief)
      setHoverAnchor({ x, y })
    },
    [advisor, currentPrice, hudRead, timeframe, zoneContextFor]
  )

  const handleZoneTap = useCallback(
    (zone: LiquidityZone, x?: number, y?: number) => {
      setHoverAdvisor(null)
      setHoverAnchor(null)
      if (!zone || !(currentPrice > 0)) return
      const brief = analyzeZoneTap({
        zone,
        price: currentPrice,
        structure: hudRead,
        timeframe,
        context: zoneContextFor(zone),
      })
      if (!brief) return
      setAdvisor(brief)
      setAdvisorMode('hold')
      setAdvisorAnchor(
        x != null && y != null
          ? { x, y }
          : {
              x: (containerRef.current?.clientWidth ?? 360) * 0.55,
              y: (containerRef.current?.clientHeight ?? 320) * 0.45,
            }
      )
      haptic.impact()
    },
    [currentPrice, hudRead, timeframe, zoneContextFor, haptic]
  )

  const closeAdvisor = useCallback(() => {
    setAdvisor(null)
    setAdvisorAnchor(null)
    setHoverAdvisor(null)
    setHoverAnchor(null)
    setSelectedCaseId(null)
  }, [])

  const handleZoneLeave = useCallback(() => {
    setHoverAdvisor(null)
    setHoverAnchor(null)
  }, [])

  /** Открыть разбор зоны из «сундучка» (маркер на графике или лента). */
  const openLimitCase = useCallback(
    (item: LimitCase, x?: number, y?: number) => {
      setSelectedCaseId(item.id)
      handleZoneTap(
        {
          ...item.zone,
          top: item.top,
          bottom: item.bottom,
          strength: item.strength,
          invalidation: item.stop,
          target: item.target,
        },
        x,
        y
      )
      haptic.impact()
    },
    [handleZoneTap, haptic]
  )

  useEffect(() => {
    if (!advisor) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAdvisor()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advisor, closeAdvisor])

  useEffect(() => {
    const el = chartShellRef.current
    if (!el || !advisor) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('[data-advisor-card]') || t.closest('button')) return
      closeAdvisor()
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [advisor, closeAdvisor])

  /** Keep the popup inside the chart box, next to the clicked band. */
  const advisorPos = useMemo(() => {
    const box = containerRef.current
    const w = box?.clientWidth ?? hostW
    const h = box?.clientHeight ?? (fillParent ? fillH : CHART_HEIGHT)
    const ax = advisorAnchor?.x ?? w * 0.55
    const ay = advisorAnchor?.y ?? h * 0.4
    const pad = 8
    let left = ax + 16
    if (left + ADVISOR_CARD_W > w - pad) left = ax - ADVISOR_CARD_W - 16
    left = Math.max(pad, Math.min(left, Math.max(pad, w - ADVISOR_CARD_W - pad)))
    let top = ay - 30
    top = Math.max(pad, Math.min(top, Math.max(pad, h - ADVISOR_CARD_H - pad)))
    return { left, top }
  }, [advisorAnchor, hostW, fillH, fillParent, chartReady])

  useEffect(() => {
    if (!advisor && !hoverAdvisor) return
    const box = containerRef.current
    if (!box) return
    const reposition = () => {
      const width = box.clientWidth
      const height = box.clientHeight
      if (advisor && advisorAnchor) {
        setAdvisorAnchor((anchor) => anchor ? { x: Math.min(anchor.x, width - 8), y: Math.min(anchor.y, height - 8) } : anchor)
      }
      if (hoverAdvisor && hoverAnchor) {
        setHoverAnchor((anchor) => anchor ? { x: Math.min(anchor.x, width - 8), y: Math.min(anchor.y, height - 8) } : anchor)
      }
    }
    const observer = new ResizeObserver(reposition)
    observer.observe(box)
    window.addEventListener('resize', reposition)
    reposition()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reposition)
    }
  }, [advisor, advisorAnchor, hoverAdvisor, hoverAnchor])

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
      const zone = hitZoneAt(tapZones, price)
      if (zone) handleZoneTap(zone, x, y)
      else closeAdvisor()
    },
    [tapZones, handleZoneTap, closeAdvisor]
  )

  useEffect(() => {
    const el = chartShellRef.current
    if (!el) return
    let last: { t: number; x: number; y: number } | null = null
    let start: { x: number; y: number } | null = null
    let singleTimer: ReturnType<typeof setTimeout> | null = null
    const clearSingle = () => {
      if (singleTimer != null) {
        clearTimeout(singleTimer)
        singleTimer = null
      }
    }
    const onStart = (e: TouchEvent) => {
      e.stopPropagation()
      if (e.touches.length === 1) {
        start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      } else {
        start = null
        last = null
        clearSingle()
      }
    }
    const onEnd = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('button')) {
        last = null
        clearSingle()
        return
      }
      if (e.changedTouches.length !== 1 || !start) return
      const tch = e.changedTouches[0]
      const moved = Math.hypot(tch.clientX - start.x, tch.clientY - start.y)
      start = null
      if (moved > 18) {
        last = null
        clearSingle()
        return
      }
      const now = Date.now()
      if (
        last &&
        now - last.t < 450 &&
        Math.hypot(tch.clientX - last.x, tch.clientY - last.y) < 44
      ) {
        last = null
        clearSingle()
        e.preventDefault()
        resolveChartDoubleTap(tch.clientX, tch.clientY)
        return
      }
      last = { t: now, x: tch.clientX, y: tch.clientY }
      const snap = last
      clearSingle()
      singleTimer = setTimeout(() => {
        if (!last || last.t !== snap.t) return
        last = null
        resolveChartDoubleTap(snap.x, snap.y)
      }, 280)
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: false })
    return () => {
      clearSingle()
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
    writeLsFlag('enterprise_chart_clean', enabled)
    if (enabled) {
      setActiveScenarios(new Set(['A']))
      setSessionSettings({ enabled: false })
      setShowHints(false)
      setOnlyStrong(true)
      writeLsFlag('enterprise_only_strong', true)
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
          ema20: false,
          ema200: false,
          ema50: false,
          bollingerBands: false,
          rsi: false,
          macd: false,
          stochastic: false,
          atr: false,
          volume: false,
        },
      })
    } else {
      setShowHints(true)
      setOnlyStrong(false)
      writeLsFlag('enterprise_only_strong', false)
      setChartPreferences({
        showLabels: true,
      })
    }
  }

  const liveSession = SESSION_DEFINITIONS[getSessionAtHour(new Date().getUTCHours())]
  const liveSessionBg = liveSession.lineColor.replace(
    /rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/,
    'rgba($1, $2, $3, 0.9)'
  )

  const showSessions =
    sessionSettings.enabled && !cleanMode && !bouncesMode
  /** Zones / Сделки / Сигнал / Отскоки — hide story paths to keep chart clean */
  const pathModeActive =
    zonesMode || tradesMode || signalMode || bouncesMode
  const curvePaths = useMemo(() => {
    if (!advisor) return []
    // One arrow only: the leg the user is looking at in the card.
    const leg = advisorMode === 'hold' ? advisor.primary : advisor.alternate
    if (leg.path.length < 2) return []
    return [
      {
        id: advisorMode,
        points: leg.path,
        color: leg.side === 'LONG' ? '#34d399' : '#fb7185',
        label: `${leg.side === 'LONG' ? 'лонг' : 'шорт'} · ${leg.probability}%`,
        emphasis: true,
      },
    ]
  }, [advisor, advisorMode])
  const showPredictionPaths = FORECAST_HORIZON_UI && showForecast && !pathModeActive
  const showGhost =
    !!signal?.direction &&
    signal.sl != null &&
    signal.tp1 != null &&
    !showForecast &&
    !pathModeActive &&
    !onlyStrong &&
    !chartStory.future &&
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

  const advisorChartRef = useRef<AdvisorChartInput | null>(null)
  const toolsFresh = toolsSymbolRef.current === symbol
  advisorChartRef.current = {
    timeframe,
    horizon: forecastHorizon,
    candles,
    forecast: forecast && forecast.scenarios.length > 0 ? forecast : null,
    consensus: directionConsensus,
    liveSignal: toolsFresh ? liveSignal : null,
    setups: toolsFresh ? pickedSetups : [],
    globalView: toolsFresh ? tradesGlobalView : null,
    magnet: toolsFresh ? tradesMagnet : null,
    liq: liqModel,
    macro: macroCtx,
    updatedAt: Date.now(),
  }
  const setAdvisorChart = useAdvisorStore((s) => s.setChart)
  useEffect(() => {
    const read = () => advisorChartRef.current as AdvisorChartInput
    setAdvisorChart(flatSymbol, read)
    return () => {
      if (useAdvisorStore.getState().chartBySymbol[flatSymbol] === read) setAdvisorChart(flatSymbol, null)
    }
  }, [flatSymbol, setAdvisorChart])

  const chartRegime = signal?.marketRegime ?? 'RANGING'
  const toolsTrendOk =
    chartRegime === 'TRENDING_STRONG' || chartRegime === 'TRENDING_WEAK'
  const toolsChop = chartRegime === 'VOLATILE_CHOP'
  const activeSequence =
    sequenceHit && sequenceHit.expiresAt > Date.now() ? sequenceHit : null
  const processRefreshKey =
    (sequenceHit?.detectedAt ?? 0) +
    Math.round((ticker?.timestamp ?? 0) / 15_000)

  const layersActive =
    [
      showSrZones,
      onlyStrong,
      showFib141,
      showCont141,
      showDirection,
      chartPreferences.showLabels,
      showComments,
      showCases,
      showHints,
      audioOn,
      fibTfs.size > 0,
      ...(chartExpanded ? [showFsScenarios] : []),
    ].filter(Boolean).length

  /**
   * The layers popover is portaled to <body>: the chart rail sits inside a
   * blurred, transformed drawer, which would otherwise clip or offset a
   * absolutely positioned panel. Position it explicitly against the viewport.
   */
  const positionLayersPanel = (details: HTMLDetailsElement) => {
    if (!details.open) {
      setLayersOpen(false)
      return
    }
    const rect = details.getBoundingClientRect()
    const width = Math.min(280, window.innerWidth - 24)
    const left = Math.min(
      Math.max(12, rect.right - width),
      window.innerWidth - width - 12
    )
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const openUp = below < 220 && above > below
    const maxHeight = Math.min(480, Math.max(180, openUp ? above : below))
    const top = openUp
      ? Math.max(12, rect.top - maxHeight - 6)
      : rect.bottom + 6

    setLayersPos({ top, left, width, maxHeight })
    setLayersOpen(true)
  }

  const closeLayers = useCallback(() => {
    setLayersOpen(false)
    if (layersRef.current?.open) layersRef.current.open = false
  }, [])

  useEffect(() => {
    if (!layersOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeLayers()
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target) return
      if (layersRef.current?.contains(target)) return
      if (target.closest?.('[data-layers-panel]')) return
      closeLayers()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [layersOpen, closeLayers])

  void handleFindZones

  const ui = (
    <div
      className={
        chartExpanded || fillParent
          ? 'flex h-full min-h-0 flex-col bg-bg-base'
          : 'space-y-2'
      }
    >
      {!chartExpanded && !cleanMode && (
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
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide text-black"
              style={{ backgroundColor: liveSessionBg }}
              title="Текущая торговая сессия (UTC)"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-black/70" />
              {liveSession.label}
            </span>
          )}
          {chartExpanded && chartStory.nowLine && (
            <NowStoryHud
              line={chartStory.nowLine}
              kind={chartStory.nowKind}
              side={chartStory.side}
              fact={chartStory.odds?.fact ?? null}
              dailyLine={chartStory.dailyFrame?.line ?? null}
              toolbar
            />
          )}
        </div>
      </div>

      {/* Unified chart toolbar — one instrument rail, not two rows of buttons. */}
      <div
        className={`relative z-30 flex shrink-0 items-center gap-1 border-b border-border bg-bg-base py-1 ${
          chartExpanded ? 'px-2' : 'sticky top-0 bg-bg-base/95 backdrop-blur-sm'
        }`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
          <div className="tv-group flex shrink-0 items-center">
            {CHART_TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                type="button"
                onClick={() => setTimeframe(tf.id)}
                className={`font-mono text-[11px] ${
                  timeframe === tf.id ? 'bg-brand/10' : ''
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

          <span className="tv-sep" aria-hidden />

          <div className="tv-group flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => {
                setSignalMode(false)
                setLiveSignal(null)
                handleClearBounces()
                handlePickSetups()
              }}
              className={`tv-btn ${
                showSetupPicker &&
                !zonesMode &&
                !tradesMode &&
                !signalMode &&
                !bouncesMode
                  ? 'tv-btn-on'
                  : ''
              }`}
              title="Сетапы: выбранные зоны входа"
            >
              Сетап
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
                handleClearBounces()
                void handleFindProbableTrades()
              }}
              className={`tv-btn ${tradesMode ? 'tv-btn-on' : ''}`}
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
                if (bouncesMode) {
                  handleClearBounces()
                  haptic.impact()
                  return
                }
                handleFindBounces()
              }}
              className={`tv-btn ${bouncesMode ? 'tv-btn-on' : ''}`}
              title="Чистый график: зоны отскока, лимитки и стрелки до цели"
            >
              Отскоки
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
                handleClearBounces()
                handleFindLiveSignal()
              }}
              className={`tv-btn ${signalMode ? 'tv-btn-on' : ''}`}
              title="Живой сигнал по текущей структуре"
            >
              Сигнал
            </button>
          </div>

          <span className="tv-sep" aria-hidden />

          <button
            type="button"
            onClick={resetChartView}
            className="tv-btn shrink-0"
            title="Сбросить масштаб к текущей структуре"
          >
            Fit
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <WhaleTrapButton
            active={showWhaleTrap}
            onClick={() => {
              setShowWhaleTrap((value) => !value)
              haptic.impact()
            }}
          />

          <button
            type="button"
            onClick={() => applyCleanMode(!cleanMode)}
            className={`tv-btn ${cleanMode ? 'tv-btn-on' : ''}`}
            title="Clean: только свечи и рабочий сетап. Полный режим — все слои."
          >
            Clean
          </button>

          <details
            ref={layersRef}
            className="group relative shrink-0"
            onToggle={(event) => positionLayersPanel(event.currentTarget)}
          >
            <summary
              className="tv-btn cursor-pointer list-none [&::-webkit-details-marker]:hidden"
              title="Слои и вид графика"
            >
              <Layers3 className="h-3.5 w-3.5" />
              <span className="hidden min-[380px]:inline">Слои</span>
              <span className="rounded-sm bg-bg-surface px-1 font-mono text-[11px] leading-4 text-text-muted">
                {layersActive}
              </span>
            </summary>

            {layersOpen &&
              layersPos &&
              createPortal(
                <div
                  data-layers-panel
                  role="dialog"
                  aria-label="Слои и вид графика"
                  className="fixed z-[300] overflow-y-auto rounded-lg border border-border bg-bg-elevated p-1.5 shadow-popover"
                  style={{
                    top: layersPos.top,
                    left: layersPos.left,
                    width: layersPos.width,
                    maxHeight: layersPos.maxHeight,
                  }}
                >
              <div className="px-2 pb-1 pt-0.5 font-sans text-[11px] font-medium leading-4 text-text-muted">
                Разметка
              </div>

              <LayerToggle
                label="Зоны поддержки / сопротивления"
                checked={showSrZones}
                onChange={() => {
                  setShowSrZones((v) => !v)
                  haptic.impact()
                }}
              />
              <LayerToggle
                label="Только сильная зона"
                checked={onlyStrong}
                onChange={() => {
                  setOnlyStrong((v) => {
                    const next = !v
                    try {
                      localStorage.setItem(
                        'enterprise_only_strong',
                        next ? '1' : '0'
                      )
                    } catch {
                      /* ignore */
                    }
                    return next
                  })
                  haptic.impact()
                }}
              />
              <LayerToggle
                label="Sweep 141"
                checked={showFib141}
                onChange={() => {
                  setShowFib141((v) => {
                    const next = !v
                    try {
                      localStorage.setItem(
                        'enterprise_show_fib141',
                        next ? '1' : '0'
                      )
                    } catch {
                      /* ignore */
                    }
                    return next
                  })
                  haptic.impact()
                }}
              />
              <LayerToggle
                label="Continuation 141"
                checked={showCont141}
                onChange={() => {
                  setShowCont141((v) => {
                    const next = !v
                    try {
                      localStorage.setItem(
                        'enterprise_show_cont141',
                        next ? '1' : '0'
                      )
                    } catch {
                      /* ignore */
                    }
                    return next
                  })
                  haptic.impact()
                }}
              />

              <div className="mt-1 border-t border-border-subtle px-2 pb-1 pt-1.5 font-sans text-[11px] font-medium leading-4 text-text-muted">
                Fibonacci 141
              </div>
              <div className="grid grid-cols-3 gap-1 px-1 pb-1">
                {FIB_TF_BUTTONS.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      toggleFibTf(b.id)
                      haptic.impact()
                    }}
                    className={`h-9 rounded-sm border font-mono text-[11px] transition-colors ${
                      fibTfs.has(b.id)
                        ? 'border-brand/30 bg-brand/10 text-brand'
                        : 'border-border text-text-secondary hover:border-border-active hover:text-text-primary'
                    }`}
                    title={`Fibonacci 141 на ${b.label.replace('141 ', '')}`}
                  >
                    {b.label.replace('141 ', '')}
                  </button>
                ))}
              </div>

              <div className="mt-1 border-t border-border-subtle px-2 pb-1 pt-1.5 font-sans text-[11px] font-medium leading-4 text-text-muted">
                Вид
              </div>

              <LayerToggle
                label="Стрелка направления"
                checked={showDirection}
                onChange={() => setShowDirection((v) => !v)}
              />
              <LayerToggle
                label="Подписи уровней"
                checked={chartPreferences.showLabels}
                onChange={() =>
                  setChartPreferences({
                    showLabels: !chartPreferences.showLabels,
                  })
                }
              />
              <LayerToggle
                label="Комментарии на графике"
                checked={showComments}
                onChange={() => {
                  setShowComments((v) => {
                    const next = !v
                    writeLsFlag('enterprise_chart_comments', next)
                    return next
                  })
                  haptic.impact()
                }}
              />
              <LayerToggle
                label="Кейсы: отложенные лимитки"
                checked={showCases}
                onChange={() => {
                  setShowCases((v) => {
                    const next = !v
                    writeLsFlag('enterprise_chart_cases', next)
                    return next
                  })
                  haptic.impact()
                }}
              />
              <LayerToggle
                label="Подсказки процесса"
                checked={showHints}
                onChange={() => {
                  setShowHints((v) => !v)
                  haptic.impact()
                }}
              />
              <LayerToggle
                label="Звук процесса"
                checked={audioOn}
                onChange={() => {
                  setAudioOn((v) => {
                    const next = !v
                    setProcessAudioEnabled(next)
                    return next
                  })
                  haptic.impact()
                }}
              />
              {chartExpanded && (
                <LayerToggle
                  label="Четыре сценария"
                  checked={showFsScenarios}
                  onChange={() => {
                    setShowFsScenarios((v) => !v)
                    haptic.impact()
                  }}
                />
              )}
                </div>,
                document.body
              )}
          </details>

          <button
            type="button"
            onClick={() => {
              setChartExpanded((v) => !v)
              haptic.impact()
            }}
            className={`tv-icon ${chartExpanded ? 'tv-icon-on' : ''}`}
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
            className="tv-icon"
            title={t('chart_settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>


      {!chartExpanded && !fillParent && (
      <div className="shrink-0">
      <StructureHud
        read={hudRead}
        startCollapsed={cleanMode || inDrawer}
        nowLine={chartStory.nowLine}
      />
      </div>
      )}
      {!chartExpanded && !fillParent && !cleanMode && (
      <p className="px-1 font-mono text-[11px] text-white/35">
        Живое чтение структуры. Четыре пути — варианты хода, не прогноз.
      </p>
      )}

      <div
        ref={chartShellRef}
        className={`relative flex w-full flex-col overflow-hidden bg-bg-base ${
          chartExpanded || fillParent
            ? 'min-h-0 flex-1 rounded-none border-0'
            : 'rounded-xl border border-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
        }`}
        style={{
          height: chartExpanded || fillParent ? undefined : chartHeight,
          minHeight: chartExpanded ? Math.max(280, chartHeight) : undefined,
          touchAction: 'none',
        }}
        onTouchStart={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          resolveChartDoubleTap(e.clientX, e.clientY)
        }}
      >
        {loading && lwcData.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-hull/60 font-mono text-xs text-holo/40">
            {t('chart_loading')}
          </div>
        )}
        {error && !loading && lwcData.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center font-mono text-xs text-alert/80">
            {error}
          </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden">
        <ChartLabelsProvider containerRef={containerRef}>
        <div
          ref={containerRef}
          className="h-full w-full"
          style={{ touchAction: 'none' }}
        />
        <ReserveNowPrice
          chart={chartInstance}
          series={candleRef.current}
          price={currentPrice}
        />
        {(lwcData.length > 0 || (!chartExpanded && chartStory.nowLine)) && (
          <div
            className={`pointer-events-none absolute left-1.5 top-1.5 z-20 flex flex-col items-start gap-1 ${
              chartExpanded || fillParent ? 'max-w-[min(22rem,54%)]' : 'max-w-[min(22rem,78%)]'
            }`}
          >
            {lwcData.length > 0 && (() => {
              const bar = lwcData[lwcData.length - 1]
              const pct = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0
              const up = pct >= 0
              const fmt = (p: number) =>
                p >= 1000 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(5)
              return (
                <div className="flex flex-col items-start gap-0.5">
                  {/* TradingView-style symbol legend */}
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px] font-semibold tracking-wide text-text-primary">
                      {flatSymbol.replace('_', '')}
                    </span>
                    <span className="rounded-[3px] bg-white/[0.07] px-1 py-px font-mono text-[11px] font-semibold uppercase tracking-wider text-[#b2b5be]/80">
                      {timeframe}
                    </span>
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#787b86]/80">
                      MEXC
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0 font-mono text-[11px] tabular-nums text-[#787b86]">
                    {!denseUi && (
                      <>
                        <span>
                          O <span className="text-text-primary">{fmt(bar.open)}</span>
                        </span>
                        <span>
                          H <span className="text-text-primary">{fmt(bar.high)}</span>
                        </span>
                        <span>
                          L <span className="text-text-primary">{fmt(bar.low)}</span>
                        </span>
                      </>
                    )}
                    <span>
                      {denseUi ? '' : 'C '}
                      <span className="text-text-primary">{fmt(bar.close)}</span>
                    </span>
                    <span
                      className={`rounded-[3px] px-1 py-px text-[11px] ${
                        up
                          ? 'bg-market-long/15 text-market-long'
                          : 'bg-market-short/15 text-market-short'
                      }`}
                    >
                      {up ? '+' : ''}
                      {pct.toFixed(2)}%
                    </span>
                  </div>
                </div>
              )
            })()}
            {!chartExpanded && chartReady > 0 && chartStory.nowLine && (
              <NowStoryHud
                line={chartStory.nowLine}
                kind={chartStory.nowKind}
                side={chartStory.side}
                fact={chartStory.odds?.fact ?? null}
                dailyLine={chartStory.dailyFrame?.line ?? null}
                dense={denseUi}
                toolbar={fillParent}
              />
            )}
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
        {chartReady > 0 && overlayZones.length > 0 && (
          <ChartOverlay
            chart={chartRef.current}
            series={candleRef.current}
            zones={overlayZones}
            containerRef={containerRef}
            opacity={bouncesMode ? 40 : cleanMode ? 32 : 28}
            showLabels
            highlightId={
              bouncesMode
                ? bounceResult?.zones[0]?.id ?? null
                : advisor?.zoneId ??
                  highlightedZoneId ??
                  chartStory.primary?.id ??
                  actionPick.launchId
            }
            quiet={chartExpanded || bouncesMode}
            onlyStrong={cleanMode || onlyStrong || bouncesMode}
            thinLabels={chartExpanded || bouncesMode}
            interactingRef={userPanningRef}
            onZoneClick={tapZones.length > 0 ? handleZoneTap : undefined}
            onZoneHover={tapZones.length > 0 ? handleZoneHover : undefined}
            onZoneLeave={handleZoneLeave}
          />
        )}
        {chartReady > 0 &&
          bouncesMode &&
          bounceResult &&
          bounceResult.arrows.length > 0 &&
          lastCandleTs > 0 && (
            <BounceArrowsOverlay
              chart={chartInstance}
              series={candleRef.current}
              containerRef={containerRef}
              arrows={bounceResult.arrows}
              lastCandleTs={lastCandleTs}
              visible
              interactingRef={userPanningRef}
            />
          )}
        {chartReady > 0 &&
          !bouncesMode &&
          (showFib141 || showCont141) &&
          (fib141View || cont141View) && (
          <Fib141ZoneOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            zones={[
              ...(showFib141 && fib141View ? [fib141View] : []),
              ...(showCont141 && cont141View ? [cont141View] : []),
            ]}
          />
        )}
        {chartReady > 0 && !bouncesMode && ictMarks.length > 0 && (
          <IctMarksOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            marks={ictMarks}
            lastPrice={currentPrice}
          />
        )}
        {chartReady > 0 && !bouncesMode && showCases && autoCases.length > 0 && (
          <CaseMarkersOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            cases={autoCases}
            selectedId={selectedCaseId}
            dense={denseUi}
            onSelect={(item, x, y) => openLimitCase(item, x, y)}
          />
        )}
        {chartReady > 0 &&
          !bouncesMode &&
          showComments &&
          chartStory.comments.length > 0 && (
          <ChartCommentsOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            comments={chartStory.comments}
            lastPrice={currentPrice}
            compactPins={chartExpanded || fillParent || denseUi}
            interactingRef={userPanningRef}
          />
        )}
        {chartReady > 0 &&
          lastCandleTs > 0 &&
          chartStory.future &&
          storyPathId &&
          !advisor &&
          !bouncesMode &&
          !pathModeActive && (
          <StoryPathOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            lastCandleTs={lastCandleTs}
            barSeconds={timeframeBarSeconds(timeframe)}
            future={chartStory.future}
            lastPrice={currentPrice}
            scenarios={chartStory.scenarios}
            activeId={storyPathId}
            interactingRef={userPanningRef}
          />
        )}
        {chartReady > 0 &&
          lastCandleTs > 0 &&
          !cleanMode &&
          !pathModeActive &&
          !advisor &&
          !onlyStrong &&
          !bouncesMode && (
          <StructureOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            read={structureRead}
            lastCandleTs={lastCandleTs}
            barSeconds={timeframeBarSeconds(timeframe)}
            showPath={!pathModeActive}
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
        {!advisor && hoverAdvisor && hoverAnchor && (
          <div
            className="pointer-events-none absolute z-20 w-[248px] rounded-lg border border-cyan-300/30 bg-[#111820]/95 px-3 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-md"
            style={{
              left: Math.max(8, Math.min(hoverAnchor.x + 14, (containerRef.current?.clientWidth ?? 360) - 256)),
              top: Math.max(8, Math.min(hoverAnchor.y + 14, (containerRef.current?.clientHeight ?? CHART_HEIGHT) - 94)),
            }}
          >
            <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-100">
              <span className="truncate">{hoverAdvisor.zoneLabel}</span>
              <span className="shrink-0 text-cyan-200">LIVE · {hoverAdvisor.timeframe}</span>
            </div>
            <div className="mt-1 text-[11px] leading-relaxed text-slate-300">{hoverAdvisor.summary}</div>
            <div className="mt-1.5 flex justify-between border-t border-white/10 pt-1.5 font-mono text-[11px]">
              <span className="text-emerald-300">Удержание {hoverAdvisor.primary.probability}%</span>
              <span className="text-rose-300">Пробой {hoverAdvisor.alternate.probability}%</span>
            </div>
            <div className="mt-1 text-[11px] text-slate-400">Клик по зоне — полный разбор «если → то»</div>
          </div>
        )}
        {advisor && (
          <ZoneAdvisorCard
            brief={advisor}
            mode={advisorMode}
            left={advisorPos.left}
            top={advisorPos.top}
            mobile={denseUi}
            onMode={setAdvisorMode}
            onClose={closeAdvisor}
          />
        )}
        {chartReady > 0 && !bouncesMode && (
          <LiqHeatmapOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            model={liqModel}
            visible
            opacity={
              cleanMode ? (showLiqMap ? 0.52 : 0.36) : showLiqMap ? 1 : 0.42
            }
            edgeOnly={cleanMode || chartExpanded || !showLiqMap}
          />
        )}
        {chartReady > 0 && showWhaleTrap && !bouncesMode && (
          <WhaleTrapOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            candles={candles}
            currentPrice={currentPrice}
            symbol={flatSymbol}
            visible={showWhaleTrap}
          />
        )}
        {!bouncesMode && (
        <button
          type="button"
          onClick={() => {
            setShowLiqMap((v) => {
              const next = !v
              writeLsFlag('enterprise_liq_layer', next)
              return next
            })
            haptic.impact()
          }}
          className={`absolute bottom-8 left-1.5 z-30 inline-flex items-center gap-1 rounded-full border px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-wider shadow-lg backdrop-blur-md transition-colors ${
            showLiqMap
              ? 'border-emerald-400/40 bg-emerald-950/80 text-emerald-200'
              : 'border-white/15 bg-black/65 text-white/55 hover:text-white/85'
          }`}
          title="Оценка скоплений по объёму. Не книга Binance и не открытый интерес MEXC."
        >
          <Flame className="h-3.5 w-3.5" />
          ликв
          <span
            className={`rounded px-1 py-px text-[11px] ${
              showLiqMap ? 'bg-emerald-400/20' : 'bg-white/10'
            }`}
          >
            {showLiqMap ? 'ON' : 'OFF'}
          </span>
        </button>
        )}
        {chartReady > 0 && !bouncesMode && (
          <WhaleLevelsOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            clusters={whaleSit.clusters}
            priceFloor={candlePriceSpan.floor}
            priceCeil={candlePriceSpan.ceil}
          />
        )}
        {chartReady > 0 && !cleanMode && !bouncesMode && (
          <SequenceProcessOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            sequence={
              (signalMode && liveSignal?.sequence) || activeSequence
            }
          />
        )}
        {chartReady > 0 && !chartExpanded && !bouncesMode && (
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
          !onlyStrong &&
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
            barSeconds={timeframeBarSeconds(timeframe)}
            containerRef={containerRef}
          />
        )}
        </ChartLabelsProvider>
        </div>
      </div>
      <div
        className={
          fillParent
            ? 'shrink-0 max-h-[170px] overflow-y-auto overscroll-contain border-t border-white/[0.06]'
            : 'contents'
        }
      >
      <WhaleSitStrip sit={whaleSit} />
      {!chartExpanded && (
        <ZoneLegend
          items={chartStory.legend}
          onlyStrong={cleanMode || onlyStrong}
        />
      )}
      {denseUi && !chartExpanded && showCases && autoCases.length > 0 && (
        <LimitCasesStrip
          cases={autoCases}
          selectedId={selectedCaseId}
          onSelect={(item) => openLimitCase(item)}
        />
      )}
      {(!chartExpanded || showFsScenarios) && (
        <ScenarioBoard
          scenarios={chartStory.scenarios}
          activeId={storyPathId}
          onSelect={(id) => {
            storyPickedRef.current = true
            setStoryPathId(id)
            haptic.impact()
          }}
          dense={denseUi}
          dailyLine={chartStory.dailyFrame?.line ?? null}
        />
      )}

      {!chartExpanded && (
        <>
      {!cleanMode && (
      <DeltaSparkline
        symbol={symbol}
        refreshKey={processRefreshKey}
        height={32}
      />
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
        <>
          {liveSignal.marketContext && (
            <div className="px-3 pt-2">
              <ContextPanel ctx={liveSignal.marketContext} />
            </div>
          )}
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
        </>
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

      {bouncesMode && bounceResult && bounceResult.setups.length > 0 && (
        <ZoneVariantsPanel
          zones={[]}
          setups={bounceResult.setups}
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
      </div>

      <ChartSettings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )

  return (
    <div
      className={
        fillParent ? 'flex h-full min-h-0 w-full flex-col' : undefined
      }
    >
      {chartExpanded && !fillParent && (
        <div
          className="flex h-[440px] items-center justify-center rounded-xl border border-white/[0.08] bg-bg-base font-mono text-[11px] text-white/35"
          aria-hidden
        >
          график на весь экран
        </div>
      )}
      <div
        ref={expandSlotRef}
        className={
          fillParent
            ? 'relative flex min-h-0 w-full flex-1 flex-col'
            : 'relative w-full'
        }
      />
      {expandHost ? createPortal(ui, expandHost) : ui}
    </div>
  )
}

export default LiveChart