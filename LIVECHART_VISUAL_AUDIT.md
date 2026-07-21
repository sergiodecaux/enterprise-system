# LiveChart Visual Audit — Prediction & Overlays

**Дата:** 2026-07-20  
**Статус:** только аудит (без правок кода)

---

## Краткие ответы Q1–Q7

| # | Вердикт |
|---|---------|
| **Q1** | Сначала `timeScale.timeToCoordinate(nowTs + offset)`. Для будущего почти всегда **null**. Fallback: `projectPathToPixels` → `x = lastBarX + offset * (barSpacingPx / candleSec)` |
| **Q2** | Тот же `containerRef`, что у LWC host div. Canvas **динамический**: `clientWidth/Height × dpr`. **Не** fixed 800 |
| **Q3** | Макс LWC lines: **10** (EMA×3 + SMA×3 + BB×3 + VWAP). Forecast — canvas, не series |
| **Q4** | ChartOverlay `z-index: 1`; PredictionOverlay `z-index: 2` → прогноз поверх зон |
| **Q5** | `Math.floor(Date.now() / 1000)` — **не** last candle time |
| **Q6** | **Нет** auto-scroll. `fitContent()` только на свечи. Path часто за правым краем / clipped |
| **Q7** | Динамический по container. Fixed width=800 **нет** |

### Критичные визуальные баги
1. Future path часто off-screen (нет right padding)
2. Якорь времени = wall clock, не last bar
3. Pixel spacing ≠ реальная ширина бара LWC при zoom
4. `overflow-hidden` обрезает badges

---


## Q1 — X для будущего времени

```ts
const nowTs = Math.floor(Date.now() / 1000)
const ts = (nowTs + pp.timeOffsetSeconds) as Time
let x = timeScale.timeToCoordinate(ts)  // null вне шкалы баров
if (x == null) {
  // lastBarX = logicalToCoordinate(floor(visibleLogicalRange.to)) || W*0.85
  // barSpacing = max(2, W / visibleBars)
  x = lastBarX + offset * (barSpacing / candleTimeframeSeconds)
}
```

LWC v4: `timeToCoordinate` для timestamp без бара → **null**.

## Q2 — containerRef

- Передаётся тот же `containerRef`, что host LWC (`div.h-full.w-full`).
- Parent: `relative` height 260 + `overflow-hidden`.
- Canvas: `absolute inset-0`, size = `container.clientWidth/Height × devicePixelRatio`.

## Q3 — Line series max

`ema20, ema50, ema200, sma9, sma21, sma50, bb_upper, bb_middle, bb_lower, vwap` = **10** + 1 candlestick.  
Forecast paths не в LWC series → нет конфликта series z-order; canvas поверх.

## Q4 — Overlays z-index

| Layer | z-index |
|-------|---------|
| LWC | 0 |
| ChartOverlay (OB/FVG DOM) | **1** |
| PredictionOverlay (canvas) | **2** |
| loading/error | 10 |

## Q5 — Текущее время

`Date.now()/1000`, не `candles[last][0]/1000`.

## Q6 — Auto scroll

Нет. Только `fitContent()` на свечи. Будущий path — pixel projection вправо.

## Q7 — Canvas size

Динамический. Нет `width={800}`.

---

## APPENDIX: полные файлы


### 1. LiveChart.tsx

```tsx

import { useEffect, useRef, useState, useCallback } from 'react'
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
import {
  CHART_TIMEFRAMES,
  fetchOhlcv,
  type MexcTimeframe,
  type OhlcvCandle,
} from '../../api/mexc'
import type { CoinSignal } from '../../engine/types'
import { logger } from '../../utils/logger'
import { useChartIndicators } from '../../hooks/useChartIndicators'
import { useChartZones } from '../../hooks/useChartZones'
import { useMultiTFAnalysis } from '../../hooks/useMultiTFAnalysis'
import { usePriceForecast } from '../../hooks/usePriceForecast'
import ChartSettings from './ChartSettings'
import ChartOverlay from './ChartOverlay'
import VolumePanel from './VolumePanel'
import OscillatorPanel from './OscillatorPanel'
import MultiTFPanel from './MultiTFPanel'
import PredictionOverlay from './PredictionOverlay'
import ScenarioLegend from './ScenarioLegend'

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

const CHART_HEIGHT = 260

const LiveChart = ({ symbol, flatSymbol, signal = null }: LiveChartProps) => {
  const { t } = useTranslation()

  const ticker = useAppStore((s) => s.liveTickets[flatSymbol])
  const chartPreferences = useAppStore((s) => s.chartPreferences)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const priceLineRefs = useRef<IPriceLine[]>([])

  const [timeframe, setTimeframe] = useState<MexcTimeframe>('1h')
  const [candles, setCandles] = useState<OhlcvCandle[]>([])
  const [lwcData, setLwcData] = useState<CandlestickData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chartReady, setChartReady] = useState(0)
  const [showForecast, setShowForecast] = useState(true)
  const [activeScenarios, setActiveScenarios] = useState<Set<string>>(
    () => new Set(['A', 'B', 'C'])
  )

  const currentPrice = signal?.price ?? ticker?.price ?? 0

  const indicators = useChartIndicators(candles, chartPreferences.indicators)
  const { liquidityZones, priceLevels } = useChartZones(candles, chartPreferences.zones)

  const { alignment, liquidityMap, isLoading: mtfLoading } = useMultiTFAnalysis(
    symbol,
    currentPrice,
    true
  )

  const forecast = usePriceForecast(
    candles,
    alignment,
    liquidityMap,
    currentPrice,
    symbol,
    timeframe
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
      chart.remove()
      chartRef.current = null
      candleRef.current = null
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
  }, [priceLevels, chartPreferences.showLabels, chartReady, lwcData, signal])

  const oscillators: Array<'rsi' | 'macd' | 'stochastic' | 'atr'> = []
  if (chartPreferences.indicators.rsi) oscillators.push('rsi')
  if (chartPreferences.indicators.macd) oscillators.push('macd')
  if (chartPreferences.indicators.stochastic) oscillators.push('stochastic')
  if (chartPreferences.indicators.atr) oscillators.push('atr')

  const toggleScenario = (id: string) => {
    setActiveScenarios((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs uppercase tracking-wider text-holo/40">
          {t('chart_title')}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-1">
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
        style={{ height: CHART_HEIGHT }}
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
      </div>

      {chartPreferences.indicators.volume && indicators.volume.length > 0 && (
        <VolumePanel volumeData={indicators.volume} height={50} />
      )}

      {oscillators.map((mode) => (
        <OscillatorPanel
          key={mode}
          mode={mode}
          rsiData={indicators.rsi}
          macdData={indicators.macd}
          stochasticData={indicators.stochastic}
          atrData={indicators.atr}
          height={80}
        />
      ))}

      <MultiTFPanel alignment={alignment} isLoading={mtfLoading} />

      {showForecast && forecast && (
        <ScenarioLegend
          scenarios={forecast.scenarios}
          dominantId={forecast.dominantScenario}
          activeScenarios={activeScenarios}
          onToggle={toggleScenario}
        />
      )}

      <ChartSettings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

export default LiveChart


```


### 2. PredictionOverlay.tsx

```tsx

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { PriceForecast } from '../../engine/prediction/types'
import {
  estimateBarSpacing,
  projectPathToPixels,
} from '../../engine/prediction/pathProjector'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  forecast: PriceForecast | null
  activeScenarios: Set<string>
  containerRef: React.RefObject<HTMLDivElement>
}

const PredictionOverlay = ({
  chart,
  series,
  forecast,
  activeScenarios,
  containerRef,
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const redraw = () => {
      const W = container.clientWidth
      const H = container.clientHeight
      if (W <= 0 || H <= 0) return

      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      if (!chart || !series || !forecast) return

      const timeScale = chart.timeScale()
      const priceToY = (price: number): number | null => series.priceToCoordinate(price)

      // Anchor future path to last known bar X
      let lastBarX: number | null = null
      try {
        const logical = timeScale.getVisibleLogicalRange()
        if (logical) {
          const lastLogical = Math.floor(logical.to)
          lastBarX = timeScale.logicalToCoordinate(lastLogical as never)
        }
      } catch {
        /* ignore */
      }

      if (lastBarX == null) {
        // Fallback: try last candle time from forecast path start
        lastBarX = W * 0.85
      }

      const visible = timeScale.getVisibleLogicalRange()
      const visibleBars = visible ? Math.max(1, visible.to - visible.from) : 40
      const barSpacing = estimateBarSpacing(W, visibleBars)

      for (const sc of forecast.scenarios) {
        if (!activeScenarios.has(sc.id)) continue
        if (sc.path.length < 2) continue

        // Prefer LWC coords when available; else project from last bar
        const points: Array<{ x: number; y: number; label?: string; isKey?: boolean }> = []
        const nowTs = Math.floor(Date.now() / 1000)

        for (const pp of sc.path) {
          const y = priceToY(pp.price)
          if (y == null) continue

          const ts = (nowTs + pp.timeOffsetSeconds) as Time
          let x: number | null = timeScale.timeToCoordinate(ts) as number | null
          if (x == null) {
            const projected = projectPathToPixels(
              [pp],
              lastBarX!,
              barSpacing,
              forecast.candleTimeframeSeconds,
              priceToY
            )
            if (!projected[0]) continue
            x = projected[0].x
          }

          points.push({
            x,
            y: y as number,
            label: pp.label,
            isKey: pp.isKeyLevel,
          })
        }

        if (points.length < 2) continue

        const color = sc.color
        const currentY = priceToY(forecast.currentPrice)

        if (currentY != null) {
          ctx.beginPath()
          ctx.moveTo(points[0].x, points[0].y)
          points.forEach((p) => ctx.lineTo(p.x, p.y))
          ctx.lineTo(points[points.length - 1].x, currentY)
          ctx.lineTo(points[0].x, currentY)
          ctx.closePath()
          ctx.fillStyle = `${color}18`
          ctx.fill()
        }

        ctx.beginPath()
        ctx.setLineDash([6, 4])
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.moveTo(points[0].x, points[0].y)
        points.forEach((p) => ctx.lineTo(p.x, p.y))
        ctx.stroke()
        ctx.setLineDash([])

        points.forEach((p, i) => {
          const isLast = i === points.length - 1
          ctx.beginPath()
          ctx.arc(p.x, p.y, isLast || p.isKey ? 5 : 3, 0, Math.PI * 2)
          ctx.fillStyle = isLast || p.isKey ? color : `${color}80`
          ctx.strokeStyle = '#111'
          ctx.lineWidth = 1
          ctx.fill()
          ctx.stroke()

          if (p.label && p.isKey) {
            ctx.font = 'bold 10px monospace'
            ctx.fillStyle = color
            ctx.textAlign = 'left'
            ctx.fillText(p.label, p.x + 8, p.y - 4)
          }
        })

        const firstP = points[0]
        const badgeText = `${sc.id}: ${sc.probability}%`
        ctx.font = 'bold 9px monospace'
        const tw = ctx.measureText(badgeText).width
        ctx.fillStyle = `${color}cc`
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(firstP.x - 4, firstP.y - 22, tw + 8, 16, 4)
        } else {
          ctx.rect(firstP.x - 4, firstP.y - 22, tw + 8, 16)
        }
        ctx.fill()
        ctx.fillStyle = '#111'
        ctx.textAlign = 'left'
        ctx.fillText(badgeText, firstP.x, firstP.y - 10)
      }

      // Liquidity horizontals (top 6)
      for (const liq of forecast.liquidityMap.slice(0, 6)) {
        const y = priceToY(liq.price)
        if (y == null || y < 0 || y > H) continue

        ctx.beginPath()
        ctx.setLineDash([3, 6])
        ctx.strokeStyle =
          liq.side === 'BUY_SIDE' ? 'rgba(34, 197, 94, 0.35)' : 'rgba(239, 68, 68, 0.35)'
        ctx.lineWidth = 1
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
        ctx.stroke()
        ctx.setLineDash([])

        ctx.font = '9px monospace'
        ctx.fillStyle =
          liq.side === 'BUY_SIDE' ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)'
        ctx.textAlign = 'right'
        ctx.fillText(liq.label, W - 4, y - 3)
      }
    }

    redraw()

    const onVisible = () => redraw()
    chart?.timeScale().subscribeVisibleLogicalRangeChange(onVisible)
    chart?.subscribeCrosshairMove(onVisible)

    const ro = new ResizeObserver(() => redraw())
    ro.observe(container)

    return () => {
      chart?.timeScale().unsubscribeVisibleLogicalRangeChange(onVisible)
      chart?.unsubscribeCrosshairMove(onVisible)
      ro.disconnect()
    }
  }, [chart, series, forecast, activeScenarios, containerRef])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 2 }}
    />
  )
}

export default PredictionOverlay


```


### 3. ChartOverlay.tsx

```tsx

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { LiquidityZone } from '../../engine/indicators/types'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  zones: LiquidityZone[]
  containerRef: React.RefObject<HTMLDivElement>
  opacity: number
  showLabels: boolean
}

function getZoneColors(zone: LiquidityZone, opacity: number) {
  const op = opacity / 100

  switch (zone.type) {
    case 'ORDER_BLOCK':
      return zone.side === 'BULLISH'
        ? { bg: `rgba(34, 197, 94, ${op})`, border: 'rgba(34, 197, 94, 0.8)' }
        : { bg: `rgba(239, 68, 68, ${op})`, border: 'rgba(239, 68, 68, 0.8)' }
    case 'FVG':
      return zone.side === 'BULLISH'
        ? { bg: `rgba(59, 130, 246, ${op})`, border: 'rgba(59, 130, 246, 0.8)' }
        : { bg: `rgba(168, 85, 247, ${op})`, border: 'rgba(168, 85, 247, 0.8)' }
    case 'POC':
      return { bg: `rgba(249, 115, 22, ${op})`, border: 'rgba(249, 115, 22, 0.9)' }
    case 'VALUE_AREA':
      return {
        bg: `rgba(148, 163, 184, ${op * 0.5})`,
        border: 'rgba(148, 163, 184, 0.3)',
      }
    default:
      return { bg: `rgba(100, 200, 255, ${op})`, border: 'rgba(100, 200, 255, 0.6)' }
  }
}

const ChartOverlay = ({
  chart,
  series,
  zones,
  containerRef,
  opacity,
  showLabels,
}: Props) => {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!chart || !series || !overlayRef.current || !containerRef.current) return

    const overlay = overlayRef.current
    const timeScale = chart.timeScale()

    const redraw = () => {
      overlay.innerHTML = ''
      const containerWidth = containerRef.current!.clientWidth
      const containerHeight = containerRef.current!.clientHeight

      for (const zone of zones) {
        const colors = getZoneColors(zone, opacity)
        const topY = series.priceToCoordinate(zone.top)
        const bottomY = series.priceToCoordinate(zone.bottom)
        const startX = timeScale.timeToCoordinate(zone.startTime as Time)
        const endX = timeScale.timeToCoordinate(
          (zone.endTime ?? zone.startTime) as Time
        )

        if (topY == null || bottomY == null || startX == null) continue

        const height = Math.abs(bottomY - topY)
        const yPos = Math.min(topY, bottomY)
        const resolvedEndX = endX ?? containerWidth
        const width =
          resolvedEndX > startX ? resolvedEndX - startX : containerWidth - startX

        if (height < 1 || yPos < -20 || yPos > containerHeight + 20) continue
        if (startX > containerWidth) continue

        const div = document.createElement('div')
        div.style.cssText = `
          position: absolute;
          left: ${Math.max(0, startX)}px;
          top: ${yPos}px;
          width: ${Math.min(Math.max(width, 4), containerWidth - Math.max(0, startX))}px;
          height: ${Math.max(height, 2)}px;
          background: ${colors.bg};
          border-top: 1px solid ${colors.border};
          border-bottom: 1px solid ${colors.border};
          pointer-events: none;
          box-sizing: border-box;
          overflow: hidden;
        `

        if (showLabels && zone.label) {
          const label = document.createElement('span')
          label.textContent = zone.label
          label.style.cssText = `
            position: absolute;
            right: 4px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 9px;
            font-family: monospace;
            color: ${colors.border};
            white-space: nowrap;
            opacity: 0.9;
          `
          div.appendChild(label)
        }

        overlay.appendChild(div)
      }
    }

    redraw()

    const onVisible = () => redraw()
    timeScale.subscribeVisibleLogicalRangeChange(onVisible)
    chart.subscribeCrosshairMove(onVisible)

    const ro = new ResizeObserver(() => redraw())
    ro.observe(containerRef.current)

    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(onVisible)
      chart.unsubscribeCrosshairMove(onVisible)
      ro.disconnect()
      overlay.innerHTML = ''
    }
  }, [chart, series, zones, opacity, showLabels, containerRef])

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 1 }}
    />
  )
}

export default ChartOverlay


```


### 4. scenarioBuilder.ts

```tsx

import type { OhlcvCandle } from '../../api/mexc'
import type {
  PriceScenario,
  PathPoint,
  MultiTFAlignment,
  LiquidityLevel,
} from './types'
import { calculateAtr } from '../smc'
import { findNearestLiquidity } from './liquidityMap'

const SCENARIO_COLORS = {
  LONG: '#22c55e',
  SHORT: '#ef4444',
  RANGE: '#f59e0b',
}

function candleSeconds(tf: string): number {
  switch (tf) {
    case '1m':
      return 60
    case '5m':
      return 300
    case '15m':
      return 900
    case '1h':
      return 3600
    case '4h':
      return 14400
    case '1d':
      return 86400
    default:
      return 3600
  }
}

function buildLongPath(
  entry: number,
  target: number,
  atr: number,
  candleSec: number
): PathPoint[] {
  const retest = entry - atr * 0.3
  const midTarget = entry + (target - entry) * 0.5

  return [
    { timeOffsetSeconds: 0, price: entry, label: 'РўРѕС‡РєР° РІС…РѕРґР°' },
    { timeOffsetSeconds: candleSec * 2, price: retest, label: 'Р РµС‚РµСЃС‚ Р·РѕРЅС‹' },
    { timeOffsetSeconds: candleSec * 4, price: entry + atr * 0.5 },
    { timeOffsetSeconds: candleSec * 7, price: midTarget, label: 'TP1' },
    {
      timeOffsetSeconds: candleSec * 12,
      price: target,
      label: 'Р¦РµР»СЊ',
      isKeyLevel: true,
    },
  ]
}

function buildShortPath(
  entry: number,
  target: number,
  atr: number,
  candleSec: number
): PathPoint[] {
  const retest = entry + atr * 0.3
  const midTarget = entry - (entry - target) * 0.5

  return [
    { timeOffsetSeconds: 0, price: entry, label: 'РўРѕС‡РєР° РІС…РѕРґР°' },
    { timeOffsetSeconds: candleSec * 2, price: retest, label: 'Р РµС‚РµСЃС‚ Р·РѕРЅС‹' },
    { timeOffsetSeconds: candleSec * 4, price: entry - atr * 0.5 },
    { timeOffsetSeconds: candleSec * 7, price: midTarget, label: 'TP1' },
    {
      timeOffsetSeconds: candleSec * 12,
      price: target,
      label: 'Р¦РµР»СЊ',
      isKeyLevel: true,
    },
  ]
}

function buildRangePath(
  entry: number,
  rangeTop: number,
  rangeBottom: number,
  _atr: number,
  candleSec: number
): PathPoint[] {
  return [
    { timeOffsetSeconds: 0, price: entry },
    { timeOffsetSeconds: candleSec * 2, price: rangeTop, label: 'Р’РµСЂС… РґРёР°РїР°Р·РѕРЅР°' },
    { timeOffsetSeconds: candleSec * 5, price: rangeBottom, label: 'РќРёР· РґРёР°РїР°Р·РѕРЅР°' },
    { timeOffsetSeconds: candleSec * 8, price: entry, label: 'Р’РѕР·РІСЂР°С‚' },
    {
      timeOffsetSeconds: candleSec * 11,
      price: rangeTop,
      label: 'Р¦РµР»СЊ РІС‹С…РѕРґР°',
      isKeyLevel: true,
    },
  ]
}

function calcProbabilities(alignment: MultiTFAlignment): {
  longPct: number
  shortPct: number
  rangePct: number
} {
  const { score } = alignment
  let longBase = 33
  let shortBase = 33
  let rangeBase = 34

  if (score >= 4) {
    longBase = 65
    shortBase = 15
    rangeBase = 20
  } else if (score >= 2) {
    longBase = 55
    shortBase = 20
    rangeBase = 25
  } else if (score <= -4) {
    longBase = 15
    shortBase = 65
    rangeBase = 20
  } else if (score <= -2) {
    longBase = 20
    shortBase = 55
    rangeBase = 25
  }

  if (alignment.agreement) {
    if (score > 0) {
      longBase += 5
      rangeBase -= 5
    } else {
      shortBase += 5
      rangeBase -= 5
    }
  }

  const total = longBase + shortBase + rangeBase
  return {
    longPct: Math.round((longBase / total) * 100),
    shortPct: Math.round((shortBase / total) * 100),
    rangePct: Math.round((rangeBase / total) * 100),
  }
}

function buildReasoning(alignment: MultiTFAlignment, isLong: boolean): string[] {
  const reasons: string[] = []
  const want: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT'

  if (alignment.daily.bias === want) reasons.push(`1D: ${alignment.daily.biasReason}`)
  if (alignment.h4.bias === want) reasons.push(`4H: ${alignment.h4.biasReason}`)
  if (alignment.h1.bias === want) reasons.push(`1H: ${alignment.h1.biasReason}`)
  if (alignment.agreement) reasons.push('Р’СЃРµ TF СЃРѕРіР»Р°СЃРѕРІР°РЅС‹')
  if (reasons.length === 0) {
    reasons.push(`РЎС†РµРЅР°СЂРёР№ ${want} РїСЂРё MTF score: ${alignment.score}`)
  }
  return reasons
}

export function buildScenarios(
  candles: OhlcvCandle[],
  alignment: MultiTFAlignment,
  liquidityMap: LiquidityLevel[],
  currentPrice: number,
  activeTimeframe = '1h'
): PriceScenario[] {
  const atr = calculateAtr(candles, 14) ?? currentPrice * 0.005
  const candleSec = candleSeconds(activeTimeframe)
  const { longPct, shortPct, rangePct } = calcProbabilities(alignment)

  const nearestUp = findNearestLiquidity(liquidityMap, 'UP', 0.2)
  const nearestDown = findNearestLiquidity(liquidityMap, 'DOWN', 0.2)

  const upTarget = nearestUp ? nearestUp.price : currentPrice + atr * 3
  const downTarget = nearestDown ? nearestDown.price : currentPrice - atr * 3

  const isLong = alignment.dominantBias !== 'SHORT'

  const scenA: PriceScenario = {
    id: 'A',
    type: isLong ? 'LONG' : 'SHORT',
    label: 'РћСЃРЅРѕРІРЅРѕР№ СЃС†РµРЅР°СЂРёР№',
    probability: isLong ? longPct : shortPct,
    color: isLong ? SCENARIO_COLORS.LONG : SCENARIO_COLORS.SHORT,
    path: isLong
      ? buildLongPath(currentPrice, upTarget, atr, candleSec)
      : buildShortPath(currentPrice, downTarget, atr, candleSec),
    entry: currentPrice,
    target: isLong ? upTarget : downTarget,
    invalidation: isLong ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    liquidityTarget: {
      price: isLong ? upTarget : downTarget,
      type: (isLong ? nearestUp?.type : nearestDown?.type) ?? 'SWING_HIGH',
      strength: (isLong ? nearestUp?.strength : nearestDown?.strength) ?? 5,
      distancePercent: isLong
        ? ((upTarget - currentPrice) / currentPrice) * 100
        : ((currentPrice - downTarget) / currentPrice) * 100,
      direction: isLong ? 'UP' : 'DOWN',
      label: isLong
        ? (nearestUp?.label ?? `+${(atr * 3).toFixed(2)}`)
        : (nearestDown?.label ?? `-${(atr * 3).toFixed(2)}`),
    },
    reasoning: buildReasoning(alignment, isLong),
    triggerCondition: isLong
      ? 'РЈРґРµСЂР¶Р°РЅРёРµ РІС‹С€Рµ EMA20 + СЂРµС‚РµСЃС‚ OB'
      : 'РџСЂРѕР±РѕР№ РїРѕРґРґРµСЂР¶РєРё + СЂРµС‚РµСЃС‚ СЃРЅРёР·Сѓ',
    riskReward: Math.abs((isLong ? upTarget - currentPrice : currentPrice - downTarget) / atr),
    atrMultiple: Math.abs((isLong ? upTarget - currentPrice : currentPrice - downTarget) / atr),
  }

  const scenB: PriceScenario = {
    id: 'B',
    type: isLong ? 'SHORT' : 'LONG',
    label: 'РђР»СЊС‚РµСЂРЅР°С‚РёРІРЅС‹Р№ СЃС†РµРЅР°СЂРёР№',
    probability: isLong ? shortPct : longPct,
    color: isLong ? SCENARIO_COLORS.SHORT : SCENARIO_COLORS.LONG,
    path: isLong
      ? buildShortPath(currentPrice, downTarget, atr, candleSec)
      : buildLongPath(currentPrice, upTarget, atr, candleSec),
    entry: currentPrice,
    target: isLong ? downTarget : upTarget,
    invalidation: isLong ? currentPrice + atr * 2 : currentPrice - atr * 2,
    liquidityTarget: {
      price: isLong ? downTarget : upTarget,
      type: (isLong ? nearestDown?.type : nearestUp?.type) ?? 'SWING_LOW',
      strength: (isLong ? nearestDown?.strength : nearestUp?.strength) ?? 5,
      distancePercent: Math.abs(
        isLong
          ? ((currentPrice - downTarget) / currentPrice) * 100
          : ((upTarget - currentPrice) / currentPrice) * 100
      ),
      direction: isLong ? 'DOWN' : 'UP',
      label: isLong
        ? (nearestDown?.label ?? 'Swing Low')
        : (nearestUp?.label ?? 'Swing High'),
    },
    reasoning: buildReasoning(alignment, !isLong),
    triggerCondition: isLong
      ? 'РџСЂРѕР±РѕР№ С‚РµРєСѓС‰РµР№ РїРѕРґРґРµСЂР¶РєРё + Р·Р°РєСЂС‹С‚РёРµ РЅРёР¶Рµ'
      : 'РџСЂРѕР±РѕР№ СЃРѕРїСЂРѕС‚РёРІР»РµРЅРёСЏ + РѕР±СЉС‘Рј',
    riskReward: 2,
    atrMultiple: 2,
  }

  const scenC: PriceScenario = {
    id: 'C',
    type: 'RANGE',
    label: 'РљРѕРЅСЃРѕР»РёРґР°С†РёСЏ',
    probability: rangePct,
    color: SCENARIO_COLORS.RANGE,
    path: buildRangePath(
      currentPrice,
      currentPrice + atr * 1.5,
      currentPrice - atr * 1.5,
      atr,
      candleSec
    ),
    entry: currentPrice,
    target: isLong ? currentPrice + atr : currentPrice - atr,
    invalidation: isLong ? currentPrice - atr * 2 : currentPrice + atr * 2,
    liquidityTarget: {
      price: currentPrice,
      type: 'POC',
      strength: 5,
      distancePercent: 0,
      direction: 'UP',
      label: 'Р”РёР°РїР°Р·РѕРЅ',
    },
    reasoning: [
      `MTF score: ${alignment.score}`,
      '1D/4H/1H Р±РµР· С‡С‘С‚РєРѕРіРѕ СЃРѕРіР»Р°СЃРѕРІР°РЅРёСЏ',
      'РћР¶РёРґР°РЅРёРµ РЅР°РєРѕРїР»РµРЅРёСЏ',
    ],
    triggerCondition: 'Р¤Р»СЌС‚ СЃ СЃР¶Р°С‚РёРµРј РІРѕР»Р°С‚РёР»СЊРЅРѕСЃС‚Рё',
    riskReward: 1,
    atrMultiple: 1.5,
  }

  return [scenA, scenB, scenC].sort((a, b) => b.probability - a.probability)
}


```


### 5. useMultiTFAnalysis.ts

```tsx


```


### 6. usePriceForecast.ts

```tsx

import { useMemo } from 'react'
import type { OhlcvCandle } from '../api/mexc'
import type {
  PriceForecast,
  MultiTFAlignment,
  LiquidityLevel,
} from '../engine/prediction/types'
import { buildScenarios } from '../engine/prediction/scenarioBuilder'

function getCandleSeconds(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
    '1d': 86400,
  }
  return map[tf] ?? 3600
}

export function usePriceForecast(
  candles: OhlcvCandle[],
  alignment: MultiTFAlignment | null,
  liquidityMap: LiquidityLevel[],
  currentPrice: number,
  symbol: string,
  activeTimeframe: string
): PriceForecast | null {
  return useMemo(() => {
    if (!alignment || candles.length < 20 || currentPrice === 0) return null

    const scenarios = buildScenarios(
      candles,
      alignment,
      liquidityMap,
      currentPrice,
      activeTimeframe
    )

    return {
      symbol,
      currentPrice,
      scenarios,
      mtfAlignment: alignment,
      liquidityMap,
      dominantScenario: scenarios[0]?.id ?? 'A',
      generatedAt: Date.now(),
      candleTimeframeSeconds: getCandleSeconds(activeTimeframe),
    }
  }, [candles, alignment, liquidityMap, currentPrice, symbol, activeTimeframe])
}


```


### 7. multiTFAnalyzer.ts

```tsx

import type { OhlcvCandle } from '../../api/mexc'
import type {
  TFSnapshot,
  TFBias,
  MultiTFAlignment,
  AlignmentStrength,
  LiquidityTarget,
} from './types'
import { calculateEmaSeries } from '../indicators/trend'
import { calculateRsiSeries } from '../indicators/momentum'

function makeNeutralSnapshot(tf: '1d' | '4h' | '1h'): TFSnapshot {
  return {
    timeframe: tf,
    close: 0,
    open: 0,
    high: 0,
    low: 0,
    direction: 'DOJI',
    closePosition: 'MIDDLE',
    bodyPercent: 0,
    consecutiveSameSide: 1,
    ema20: null,
    ema200: null,
    aboveEma20: false,
    aboveEma200: false,
    rsi: 50,
    bias: 'NEUTRAL',
    biasReason: 'РќРµРґРѕСЃС‚Р°С‚РѕС‡РЅРѕ РґР°РЅРЅС‹С…',
  }
}

/** РђРЅР°Р»РёР· РїРѕСЃР»РµРґРЅРµРіРѕ Р·Р°РєСЂС‹С‚РѕРіРѕ Р±Р°СЂР° TF */
export function analyzeTFSnapshot(
  candles: OhlcvCandle[],
  timeframe: '1d' | '4h' | '1h'
): TFSnapshot {
  const closed = candles.slice(0, -1)
  const last = closed[closed.length - 1]
  const prev = closed[closed.length - 2]

  if (!last || !prev) {
    return makeNeutralSnapshot(timeframe)
  }

  const [, open, high, low, close] = last
  const range = high - low

  const bodySize = Math.abs(close - open)
  const bodyPercent = range > 0 ? (bodySize / range) * 100 : 0
  let direction: TFSnapshot['direction'] = 'DOJI'
  if (bodyPercent > 30) {
    direction = close > open ? 'BULLISH' : 'BEARISH'
  }

  const closeRatio = range > 0 ? (close - low) / range : 0.5
  const closePosition: TFSnapshot['closePosition'] =
    closeRatio > 0.66 ? 'UPPER' : closeRatio < 0.33 ? 'LOWER' : 'MIDDLE'

  let consecutiveSameSide = 1
  const currentDir = close > open ? 'bull' : 'bear'
  for (let i = closed.length - 2; i >= 0 && i >= closed.length - 10; i--) {
    const c = closed[i]
    const d = c[4] > c[1] ? 'bull' : 'bear'
    if (d === currentDir) consecutiveSameSide++
    else break
  }

  const ema20arr = calculateEmaSeries(closed, 20)
  const ema200arr = calculateEmaSeries(closed, 200)
  const ema20 = ema20arr.length ? ema20arr[ema20arr.length - 1].value : null
  const ema200 = ema200arr.length ? ema200arr[ema200arr.length - 1].value : null

  const rsiArr = calculateRsiSeries(closed, 14)
  const rsi = rsiArr.length ? rsiArr[rsiArr.length - 1].value : 50

  let biasScore = 0
  const reasons: string[] = []

  if (direction === 'BULLISH') {
    biasScore += 1
    reasons.push(`${timeframe} СЃРІРµС‡Р° Р±С‹С‡СЊСЏ`)
  } else if (direction === 'BEARISH') {
    biasScore -= 1
    reasons.push(`${timeframe} СЃРІРµС‡Р° РјРµРґРІРµР¶СЊСЏ`)
  }

  if (ema200 !== null) {
    if (close > ema200) {
      biasScore += 1
      reasons.push('Р’С‹С€Рµ EMA200')
    } else {
      biasScore -= 1
      reasons.push('РќРёР¶Рµ EMA200')
    }
  }

  if (closePosition === 'UPPER') {
    biasScore += 0.5
    reasons.push('Р—Р°РєСЂС‹С‚РёРµ РІ РІРµСЂС…РЅРµР№ С‡Р°СЃС‚Рё РґРёР°РїР°Р·РѕРЅР°')
  } else if (closePosition === 'LOWER') {
    biasScore -= 0.5
    reasons.push('Р—Р°РєСЂС‹С‚РёРµ РІ РЅРёР¶РЅРµР№ С‡Р°СЃС‚Рё РґРёР°РїР°Р·РѕРЅР°')
  }

  if (rsi > 55) {
    biasScore += 0.5
    reasons.push(`RSI ${rsi.toFixed(0)} > 55`)
  } else if (rsi < 45) {
    biasScore -= 0.5
    reasons.push(`RSI ${rsi.toFixed(0)} < 45`)
  }

  const bias: TFBias =
    biasScore >= 1.5 ? 'LONG' : biasScore <= -1.5 ? 'SHORT' : 'NEUTRAL'

  return {
    timeframe,
    close,
    open,
    high,
    low,
    direction,
    closePosition,
    bodyPercent,
    consecutiveSameSide,
    ema20,
    ema200,
    aboveEma20: ema20 !== null && close > ema20,
    aboveEma200: ema200 !== null && close > ema200,
    rsi,
    bias,
    biasReason: reasons.slice(0, 3).join(' вЂў '),
  }
}

function buildPrimaryTarget(
  daily: TFSnapshot,
  _h4: TFSnapshot,
  _h1: TFSnapshot,
  price: number,
  bias: TFBias
): LiquidityTarget {
  if (bias === 'LONG') {
    const target = daily.high > 0 ? daily.high * 1.002 : price * 1.01
    return {
      price: target,
      type: 'DAILY_HIGH',
      strength: 8,
      distancePercent: ((target - price) / price) * 100,
      direction: 'UP',
      label: `Daily High ${target.toFixed(2)}`,
    }
  }
  if (bias === 'SHORT') {
    const target = daily.low > 0 ? daily.low * 0.998 : price * 0.99
    return {
      price: target,
      type: 'DAILY_LOW',
      strength: 8,
      distancePercent: ((price - target) / price) * 100,
      direction: 'DOWN',
      label: `Daily Low ${target.toFixed(2)}`,
    }
  }
  return {
    price,
    type: 'POC',
    strength: 5,
    distancePercent: 0,
    direction: 'UP',
    label: 'РќРµР№С‚СЂР°Р»СЊРЅР°СЏ Р·РѕРЅР°',
  }
}

function buildSecondaryTarget(
  _daily: TFSnapshot,
  h4: TFSnapshot,
  _h1: TFSnapshot,
  price: number,
  bias: TFBias
): LiquidityTarget | null {
  if (bias === 'LONG') {
    const target = h4.high > 0 ? h4.high * 1.001 : price * 1.005
    return {
      price: target,
      type: 'SWING_HIGH',
      strength: 6,
      distancePercent: ((target - price) / price) * 100,
      direction: 'UP',
      label: `4H High ${target.toFixed(2)}`,
    }
  }
  if (bias === 'SHORT') {
    const target = h4.low > 0 ? h4.low * 0.999 : price * 0.995
    return {
      price: target,
      type: 'SWING_LOW',
      strength: 6,
      distancePercent: ((price - target) / price) * 100,
      direction: 'DOWN',
      label: `4H Low ${target.toFixed(2)}`,
    }
  }
  return null
}

export function calculateMTFAlignment(
  daily: TFSnapshot,
  h4: TFSnapshot,
  h1: TFSnapshot,
  currentPrice: number
): MultiTFAlignment {
  const tfScore = (snap: TFSnapshot): number => {
    if (snap.bias === 'LONG') return 2
    if (snap.bias === 'SHORT') return -2
    return 0
  }

  const score = tfScore(daily) + tfScore(h4) + tfScore(h1)
  const agreement = daily.bias === h4.bias && h4.bias === h1.bias && daily.bias !== 'NEUTRAL'

  const dominantBias: TFBias =
    score >= 2 ? 'LONG' : score <= -2 ? 'SHORT' : 'NEUTRAL'

  const strength: AlignmentStrength =
    score >= 5
      ? 'STRONG_LONG'
      : score >= 2
        ? 'LONG'
        : score <= -5
          ? 'STRONG_SHORT'
          : score <= -2
            ? 'SHORT'
            : 'NEUTRAL'

  return {
    daily,
    h4,
    h1,
    strength,
    score,
    agreement,
    dominantBias,
    primaryLiqTarget: buildPrimaryTarget(daily, h4, h1, currentPrice, dominantBias),
    secondaryLiqTarget: buildSecondaryTarget(daily, h4, h1, currentPrice, dominantBias),
    generatedAt: Date.now(),
  }
}


```


### 8. pathProjector.ts (связанный)

```tsx

import type { PathPoint } from './types'

/**
 * Project scenario path onto chart X axis when future timestamps
 * are outside LWC visible range (timeToCoordinate returns null).
 */
export function projectPathToPixels(
  path: PathPoint[],
  lastBarX: number,
  barSpacingPx: number,
  candleTimeframeSeconds: number,
  priceToY: (price: number) => number | null
): Array<{ x: number; y: number; label?: string; isKey?: boolean }> {
  const spacing =
    candleTimeframeSeconds > 0
      ? barSpacingPx / candleTimeframeSeconds
      : barSpacingPx / 3600

  const points: Array<{ x: number; y: number; label?: string; isKey?: boolean }> = []

  for (const pp of path) {
    const y = priceToY(pp.price)
    if (y == null) continue
    const x = lastBarX + pp.timeOffsetSeconds * spacing
    points.push({
      x,
      y,
      label: pp.label,
      isKey: pp.isKeyLevel,
    })
  }

  return points
}

export function estimateBarSpacing(
  containerWidth: number,
  visibleBars: number
): number {
  if (visibleBars <= 0) return 8
  return Math.max(2, containerWidth / visibleBars)
}


```

