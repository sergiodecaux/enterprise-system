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
  A: 1,
  B: 2,
  C: 3,
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

  // Forecast as native LWC line series + rightOffset for future area
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

    const maxOffsetSec = Math.max(
      0,
      ...forecast.scenarios.flatMap((sc) => sc.path.map((pp) => pp.timeOffsetSeconds))
    )
    const candleSec = Math.max(1, forecast.candleTimeframeSeconds)
    const rightBars = Math.ceil(maxOffsetSec / candleSec) + 3

    chart.timeScale().applyOptions({ rightOffset: rightBars })

    for (const sc of forecast.scenarios) {
      if (!activeScenarios.has(sc.id)) continue

      const data = buildSeriesData(sc, forecast.lastCandleTimestamp)
      if (data.length < 2) continue

      const lineSeries = chart.addLineSeries({
        color: sc.color,
        lineWidth: sc.id === 'A' ? 2 : 1,
        lineStyle: LINE_STYLE_MAP[sc.id] ?? 1,
        crosshairMarkerVisible: false,
        lastValueVisible: true,
        priceLineVisible: false,
        title: `${sc.id} ${sc.probability}%`,
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
        chart.timeScale().applyOptions({ rightOffset: 3 })
      } catch {
        /* ignore */
      }
    }
  }, [chart, forecast, activeScenarios])

  // Canvas: probability cone fill + top liquidity levels
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

      if (!forecast) return

      const timeScale = chart.timeScale()
      const priceToY = (p: number) => series.priceToCoordinate(p)
      const timeToX = (ts: number) =>
        timeScale.timeToCoordinate(ts as Time) as number | null

      const dominant = forecast.scenarios.find(
        (s) => s.id === forecast.dominantScenario
      )
      if (dominant && activeScenarios.has(dominant.id)) {
        const pts = dominant.path
          .map((pp) => {
            const ts = forecast.lastCandleTimestamp + pp.timeOffsetSeconds
            const x = timeToX(ts)
            const y = priceToY(pp.price)
            return x !== null && y !== null ? { x: x as number, y: y as number } : null
          })
          .filter(Boolean) as Array<{ x: number; y: number }>

        if (pts.length >= 2) {
          const priceTop = priceToY(forecast.currentPrice * 1.003)
          const priceBottom = priceToY(forecast.currentPrice * 0.997)
          const halfCone =
            priceTop !== null && priceBottom !== null
              ? Math.abs((priceBottom as number) - (priceTop as number)) / 2
              : 8

          const gradient = ctx.createLinearGradient(
            pts[0].x,
            0,
            pts[pts.length - 1].x,
            0
          )
          gradient.addColorStop(0, `${dominant.color}40`)
          gradient.addColorStop(1, `${dominant.color}05`)

          ctx.beginPath()
          pts.forEach((p, i) => {
            const spread = halfCone * (1 + i * 0.4)
            if (i === 0) ctx.moveTo(p.x, p.y - spread)
            else ctx.lineTo(p.x, p.y - spread)
          })
          ;[...pts].reverse().forEach((p, i) => {
            const spread = halfCone * (1 + (pts.length - 1 - i) * 0.4)
            ctx.lineTo(p.x, p.y + spread)
          })
          ctx.closePath()
          ctx.fillStyle = gradient
          ctx.fill()
        }
      }

      const topLiquidity = forecast.liquidityMap
        .filter((l) => Math.abs(l.distancePercent) > 0.1)
        .slice(0, 4)

      for (const liq of topLiquidity) {
        const y = priceToY(liq.price)
        if (y === null || (y as number) < 2 || (y as number) > H - 2) continue

        const isBuy = liq.side === 'BUY_SIDE'
        const color = isBuy ? '#22c55e' : '#ef4444'
        const yNum = y as number

        ctx.beginPath()
        ctx.setLineDash([4, 8])
        ctx.strokeStyle = `${color}40`
        ctx.lineWidth = 1
        ctx.moveTo(0, yNum)
        ctx.lineTo(W * 0.7, yNum)
        ctx.stroke()
        ctx.setLineDash([])

        const badgeText = liq.label.split(' ').slice(0, 2).join(' ')
        ctx.font = '8px monospace'
        const tw = ctx.measureText(badgeText).width + 6
        const bx = 4
        const by = Math.max(2, yNum - 9)
        const bh = 12

        ctx.fillStyle = `${color}22`
        ctx.strokeStyle = `${color}60`
        ctx.lineWidth = 0.5
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bx, by, tw, bh, 2)
        } else {
          ctx.rect(bx, by, tw, bh)
        }
        ctx.fill()
        ctx.stroke()

        ctx.fillStyle = `${color}cc`
        ctx.textAlign = 'left'
        ctx.fillText(badgeText, bx + 3, by + 9)
      }
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
