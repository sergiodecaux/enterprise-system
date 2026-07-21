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
import { useSessionData } from '../../hooks/useSessionData'
import { SESSION_DEFINITIONS, getSessionAtHour } from '../../engine/sessions/sessionMap'
import { buildGlobalFibonacci } from '../../engine/zones/globalFibonacci'
import type { ForecastHorizon } from '../../engine/prediction/macroOutlook'
import { buildMacroContext } from '../../engine/prediction/macroOutlook'

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
  const chartPreferences = useAppStore((s) => s.chartPreferences)
  const setChartPreferences = useAppStore((s) => s.setChartPreferences)
  const sessionSettings = useAppStore((s) => s.sessionSettings)
  const setSessionSettings = useAppStore((s) => s.setSessionSettings)
  const eqLiquidityMap = useAppStore((s) => s.liquidityMaps[symbol] ?? null)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const priceLineRefs = useRef<IPriceLine[]>([])
  const liqLineRefs = useRef<IPriceLine[]>([])

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

  const currentPrice = signal?.price ?? ticker?.price ?? 0
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

  const globalFib = useMemo(
    () =>
      buildGlobalFibonacci(
        candles1d.length >= 20 ? candles1d : candles,
        currentPrice
      ),
    [candles1d, candles, currentPrice]
  )

  /** OTE Killzone Box + signal-linked zones + global Fib reaction */
  const liquidityZones = useMemo((): LiquidityZone[] => {
    const fibZones = globalFib?.chartZones ?? []

    if (cleanMode) {
      // В чистом режиме — OTE + сильнейший OB + активные Fib-зоны
      const zones: LiquidityZone[] = []
      const obs = baseZones
        .filter((z) => z.type === 'ORDER_BLOCK')
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 1)
      zones.push(...obs)
      zones.push(...fibZones.filter((z) => (z.label ?? '').includes('◎')).slice(0, 2))
      if (fibZones.length && !zones.some((z) => z.type === 'FIBONACCI')) {
        zones.push(
          ...[...fibZones].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0)).slice(0, 1)
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
    return zones
  }, [baseZones, signal, candles, globalFib, cleanMode])

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
    newsScore
  )

  const macroCtx = useMemo(() => {
    if (forecastHorizon !== 'MACRO' || !alignment || candles1d.length < 20) {
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

    const load = async () => {
      try {
        const data = await fetchOhlcv(symbol, timeframe, CANDLE_LIMIT[timeframe])
        if (cancelled) return
        if (!data.length) {
          setError(t('chart_empty'))
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
        if (!cancelled) setError(t('chart_error'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
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
      },
      rightPriceScale: { borderColor: '#2a2a2a' },
      width: containerRef.current.clientWidth,
      height: CHART_HEIGHT,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    })

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00ff41',
      downColor: '#ff003c',
      borderUpColor: '#00ff41',
      borderDownColor: '#ff003c',
      wickUpColor: '#00ff4180',
      wickDownColor: '#ff003c80',
    })

    chartRef.current = chart
    candleRef.current = candleSeries
    setChartInstance(chart)
    setChartReady((n) => n + 1)

    const ro = new ResizeObserver((entries) => {
      if (!entries.length) return
      chart.applyOptions({
        width: entries[0].contentRect.width,
        height: CHART_HEIGHT,
      })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
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
    candleRef.current.setData(lwcData)
    chartRef.current?.timeScale().fitContent()
  }, [lwcData])

  useEffect(() => {
    if (!candleRef.current || !ticker || !lwcData.length) return
    if (timeframe === '4h' || timeframe === '1d') return

    const last = lwcData[lwcData.length - 1]
    const p = ticker.price
    if (Math.abs(last.close - p) < Number.EPSILON) return

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

    const addLine = (
      price: number,
      color: string,
      title: string,
      lineStyle: 0 | 1 | 2 | 3 | 4 = 2
    ) => {
      try {
        const line = series.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: true,
          title: chartPreferences.showLabels ? title : '',
        })
        priceLineRefs.current.push(line)
      } catch {
        /* ignore */
      }
    }

    for (const level of priceLevels) {
      addLine(level.price, level.color, level.label, level.lineStyle ?? 2)
    }

    if (signal?.sl != null) addLine(signal.sl, 'rgba(239, 68, 68, 0.8)', 'SL')
    if (signal?.tp1 != null) addLine(signal.tp1, 'rgba(34, 197, 94, 0.8)', 'TP1')
    if (signal?.tp2 != null) addLine(signal.tp2, 'rgba(34, 197, 94, 0.6)', 'TP2')
    if (signal?.tpDaily != null) {
      addLine(signal.tpDaily, 'rgba(100, 200, 255, 0.7)', 'TP Daily')
    }
    if (signal?.invalidationPrice != null) {
      addLine(
        signal.invalidationPrice,
        'rgba(251, 191, 36, 0.95)',
        '⚠ INVALIDATION',
        1
      )
    }
  }, [priceLevels, chartPreferences.showLabels, chartReady, lwcData, signal])

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
    !!signal?.hasActiveSetup && !showForecast && chartReady > 0 && lastCandleTs > 0

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
                const next = h === 'INTRA' ? 'MACRO' : 'INTRA'
                if (
                  next === 'MACRO' &&
                  (timeframe === '1m' ||
                    timeframe === '5m' ||
                    timeframe === '15m')
                ) {
                  setTimeframe('4h')
                }
                return next
              })
            }}
            className={`rounded px-2 py-1 font-mono text-[10px] font-bold uppercase transition-colors ${
              showForecast && forecastHorizon === 'MACRO'
                ? 'border border-cyan-400/50 bg-cyan-500/15 text-cyan-300'
                : 'border border-hull-border text-holo/40 hover:text-holo/70'
            }`}
            title="Недельная картина: ликвидность, новости, A/B/C"
          >
            {forecastHorizon === 'MACRO' ? 'WEEK' : 'INTRA'}
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
        style={{ height: chartHeight }}
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
        <div ref={containerRef} className="h-full w-full" />
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
          />
          {forecastHorizon === 'MACRO' && (
            <MacroOutlookPanel
              summary={forecast.macroSummary}
              scenarios={forecast.scenarios}
              macro={macroCtx}
            />
          )}
        </>
      )}

      <ChartSettings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

export default LiveChart
