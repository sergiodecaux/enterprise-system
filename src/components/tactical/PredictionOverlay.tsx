import { useEffect, useRef } from 'react'
import type {
  IChartApi,
  ISeriesApi,
  Time,
  LineData,
} from 'lightweight-charts'
import type { PriceForecast, PriceScenario } from '../../engine/prediction/types'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  forecast: PriceForecast | null
  activeScenarios: Set<string>
  containerRef: React.RefObject<HTMLDivElement>
}

const LINE_STYLE_MAP: Record<string, 0 | 1 | 2 | 3 | 4> = {
  A: 0, // solid — основной
  B: 2, // dashed — альтернатива
  C: 3, // sparse — слом
}

function buildSeriesData(
  scenario: PriceScenario,
  lastCandleTs: number
): LineData[] {
  return scenario.path
    .map((pp) => ({
      time: (lastCandleTs + pp.timeOffsetSeconds) as Time,
      value: pp.price,
    }))
    .filter(
      (point, i, arr) =>
        i === 0 || (point.time as number) > (arr[i - 1].time as number)
    )
}

const PredictionOverlay = ({
  chart,
  series,
  forecast,
  activeScenarios,
  containerRef,
}: Props) => {
  const forecastSeriesRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!chart) return

    const scenarioIds = ['A', 'B', 'C']

    for (const id of scenarioIds) {
      if (forecastSeriesRefs.current[id]) {
        try {
          chart.removeSeries(forecastSeriesRefs.current[id])
        } catch {
          /* ignore */
        }
        delete forecastSeriesRefs.current[id]
      }
    }

    if (!forecast) return

    const active = forecast.scenarios.filter((sc) => activeScenarios.has(sc.id))
    if (active.length === 0) return

    const maxOffsetSec = Math.max(
      0,
      ...active.flatMap((sc) => sc.path.map((pp) => pp.timeOffsetSeconds))
    )
    const candleSec = Math.max(1, forecast.candleTimeframeSeconds)
    const rightBars = Math.ceil(maxOffsetSec / candleSec) + 4

    chart.timeScale().applyOptions({ rightOffset: rightBars })

    // Рисуем C → B → A, чтобы A был сверху
    const ordered = [...active].sort((x, y) => {
      const rank = { C: 0, B: 1, A: 2 }
      return rank[x.id] - rank[y.id]
    })

    for (const sc of ordered) {
      const data = buildSeriesData(sc, forecast.lastCandleTimestamp)
      if (data.length < 2) continue

      const isPrimary = sc.id === 'A'
      const lineSeries = chart.addLineSeries({
        color: isPrimary ? sc.color : `${sc.color}99`,
        lineWidth: isPrimary ? 2 : 1,
        lineStyle: LINE_STYLE_MAP[sc.id] ?? 1,
        crosshairMarkerVisible: false,
        lastValueVisible: isPrimary,
        priceLineVisible: false,
        title: isPrimary ? `A ${sc.probability}%` : `${sc.id}`,
      })

      lineSeries.setData(data)
      forecastSeriesRefs.current[sc.id] = lineSeries
    }

    return () => {
      for (const id of scenarioIds) {
        if (forecastSeriesRefs.current[id]) {
          try {
            chart.removeSeries(forecastSeriesRefs.current[id])
          } catch {
            /* ignore */
          }
          delete forecastSeriesRefs.current[id]
        }
      }
      try {
        chart.timeScale().applyOptions({ rightOffset: 4 })
      } catch {
        /* ignore */
      }
    }
  }, [chart, forecast, activeScenarios])

  // Canvas: только мягкий конус для A — без badge-спама по ликвидности
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !chart || !series) return

    const redraw = () => {
      const W = container.clientWidth
      const H = container.clientHeight
      if (W <= 0 || H <= 0) return

      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      if (!forecast || !activeScenarios.has('A')) return

      const dominant = forecast.scenarios.find((s) => s.id === 'A')
      if (!dominant) return

      const timeScale = chart.timeScale()
      const priceToY = (p: number) => series.priceToCoordinate(p)
      const timeToX = (ts: number) =>
        timeScale.timeToCoordinate(ts as Time) as number | null

      const pts = dominant.path
        .map((pp) => {
          const ts = forecast.lastCandleTimestamp + pp.timeOffsetSeconds
          const x = timeToX(ts)
          const y = priceToY(pp.price)
          return x !== null && y !== null
            ? { x: x as number, y: y as number }
            : null
        })
        .filter(Boolean) as Array<{ x: number; y: number }>

      if (pts.length < 2) return

      const priceTop = priceToY(forecast.currentPrice * 1.004)
      const priceBottom = priceToY(forecast.currentPrice * 0.996)
      const halfCone =
        priceTop !== null && priceBottom !== null
          ? Math.abs((priceBottom as number) - (priceTop as number)) / 2
          : 6

      const gradient = ctx.createLinearGradient(
        pts[0].x,
        0,
        pts[pts.length - 1].x,
        0
      )
      gradient.addColorStop(0, `${dominant.color}28`)
      gradient.addColorStop(1, `${dominant.color}04`)

      ctx.beginPath()
      pts.forEach((p, i) => {
        const spread = halfCone * (1 + i * 0.35)
        if (i === 0) ctx.moveTo(p.x, p.y - spread)
        else ctx.lineTo(p.x, p.y - spread)
      })
      ;[...pts].reverse().forEach((p, i) => {
        const spread = halfCone * (1 + (pts.length - 1 - i) * 0.35)
        ctx.lineTo(p.x, p.y + spread)
      })
      ctx.closePath()
      ctx.fillStyle = gradient
      ctx.fill()

      // Метка вероятности у конца A
      const last = pts[pts.length - 1]
      ctx.font = 'bold 9px monospace'
      ctx.fillStyle = `${dominant.color}cc`
      ctx.fillText(`A ${dominant.probability}%`, last.x - 28, last.y - 8)
    }

    redraw()

    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw)
    chart.subscribeCrosshairMove(redraw)

    const ro = new ResizeObserver(redraw)
    ro.observe(container)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw)
      chart.unsubscribeCrosshairMove(redraw)
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
