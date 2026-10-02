/**
 * TradingView-style path-to-target: one 1–2 segment polyline + arrowhead.
 * Extra SMC scenarios live in ScenarioBoard — not overlapping doodles.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type {
  ChartStoryFuture,
  StoryScenario,
  StoryScenarioId,
} from '../../engine/smc/chartStory'
import type { PathPoint } from '../../engine/prediction/types'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  lastCandleTs: number
  barSeconds: number
  future: ChartStoryFuture | null
  lastPrice: number
  scenarios?: StoryScenario[]
  activeId?: StoryScenarioId | null
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n))
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  color: string,
  size: number
) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = color
  ctx.strokeStyle = 'rgba(8,10,14,0.92)'
  ctx.lineWidth = Math.max(1.2, size * 0.08)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-size, -size * 0.42)
  ctx.lineTo(-size * 0.55, 0)
  ctx.lineTo(-size, size * 0.42)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function strokePolyline(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  color: string,
  width: number,
  dash: number[]
) {
  if (pts.length < 2) return
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

function pathColor(sc: StoryScenario | null, fallbackSide: 'LONG' | 'SHORT'): string {
  if (!sc) return fallbackSide === 'LONG' ? '#86efac' : '#fda4af'
  if (sc.id === 'chop') return '#fbbf24'
  if (sc.id === 'break') return sc.side === 'LONG' ? '#86efac' : '#fda4af'
  return sc.side === 'LONG' ? '#4ade80' : '#fb7185'
}

const StoryPathOverlay = ({
  chart,
  series,
  containerRef,
  lastCandleTs,
  barSeconds,
  future,
  lastPrice,
  scenarios = [],
  activeId = 'hold',
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const box = containerRef.current
    if (!canvas || !chart || !series || !box || !lastCandleTs || !future) {
      const ctx = canvas?.getContext('2d')
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }

    const redraw = () => {
      try {
        const host = containerRef.current
        if (!host) return
        const w = host.clientWidth
        const h = host.clientHeight
        if (w < 80 || h < 40) return
        const compact = w < 560
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const pw = Math.round(w * dpr)
        const ph = Math.round(h * dpr)
        if (canvas.width !== pw || canvas.height !== ph) {
          canvas.width = pw
          canvas.height = ph
          canvas.style.width = `${w}px`
          canvas.style.height = `${h}px`
        }
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)

        let priceScaleW = 56
        try {
          const sw = chart.priceScale('right').width()
          if (typeof sw === 'number' && sw > 8) priceScaleW = sw
        } catch {
          /* ignore */
        }
        const plotRight = Math.max(72, w - priceScaleW - 4)

        const xStart = chart.timeScale().timeToCoordinate(lastCandleTs as never)
        const x0 =
          xStart != null && Number.isFinite(Number(xStart))
            ? Number(xStart)
            : w * 0.72
        if (x0 >= plotRight - 12) return

        const bar = Math.max(1, barSeconds)
        let barPx = 7
        try {
          const vr = chart.timeScale().getVisibleLogicalRange()
          if (vr) {
            const bars = Math.max(1, vr.to - vr.from)
            barPx = Math.max(3, (plotRight - 8) / bars)
          }
        } catch {
          /* ignore */
        }
        const span = Math.min(
          plotRight - x0 - 6,
          Math.max(compact ? 56 : 48, Math.min(future.bars, compact ? 10 : 12) * barPx)
        )
        const x1 = x0 + span

        const yOf = (price: number): number | null => {
          const y = series.priceToCoordinate(price)
          if (y == null) return null
          const n = Number(y)
          return Number.isFinite(n) ? n : null
        }

        const selected =
          activeId && activeId !== 'hold'
            ? scenarios.find((s) => s.id === activeId) ?? null
            : null
        const active =
          selected ??
          scenarios.find((s) => s.id === 'hold') ??
          null
        const src: PathPoint[] =
          selected?.path && selected.path.length >= 2
            ? selected.path
            : future.path

        const xAtOffset = (t: number, maxT: number): number => {
          if (t <= 0) {
            return clamp(x0 + t * (barPx / bar), 12, x0)
          }
          return x0 + (x1 - x0) * clamp(t / Math.max(1, maxT), 0, 1)
        }

        const maxT = Math.max(
          1,
          ...src.map((p) => p.timeOffsetSeconds).filter((t) => t > 0),
          bar * future.bars
        )
        let pts: Array<{ x: number; y: number }> = []
        for (const p of src) {
          if (!(p.price > 0) || !Number.isFinite(p.price)) continue
          const y = yOf(p.price)
          if (y == null) continue
          pts.push({
            x: clamp(xAtOffset(p.timeOffsetSeconds, maxT), 8, plotRight - 6),
            y: clamp(y, 12, h - 14),
          })
        }

        if (pts.length < 2) {
          const yFrom = yOf(
            active?.path[0]?.price ?? lastPrice ?? future.path[0]?.price ?? 0
          )
          const yTo = yOf(active?.toPrice ?? future.targetPrice)
          if (yFrom != null && yTo != null) {
            pts = [
              { x: clamp(x0 - barPx * 2, 12, x0), y: clamp(yFrom, 12, h - 14) },
              { x: x1 - 4, y: clamp(yTo, 12, h - 14) },
            ]
          }
        }
        if (pts.length < 2) return

        const color = pathColor(active, future.side)
        const dashed =
          selected != null && (selected.id === 'break' || selected.id === 'chop')
        const width = compact ? 3.6 : 3.2
        const halo = compact ? 6.4 : 5.6

        strokePolyline(ctx, pts, 'rgba(8,10,14,0.88)', halo, dashed ? [7, 5] : [])
        strokePolyline(ctx, pts, color, width, dashed ? [7, 5] : [])

        const a = pts[pts.length - 2]
        const b = pts[pts.length - 1]
        drawArrowHead(
          ctx,
          b.x,
          b.y,
          Math.atan2(b.y - a.y, b.x - a.x),
          color,
          compact ? 16 : 14
        )
      } catch {
        /* overlay must never kill the chart */
      }
    }

    try {
      const ts = chart.timeScale()
      const current = ts.options().rightOffset ?? 8
      const compactFuture = (containerRef.current?.clientWidth ?? 400) < 560
      const need = Math.min(
        compactFuture ? 16 : 22,
        Math.max(compactFuture ? 10 : 12, future.bars + 3)
      )
      if (need > current) ts.applyOptions({ rightOffset: need })
    } catch {
      /* ignore */
    }

    redraw()
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw)
    const ro = new ResizeObserver(() => redraw())
    ro.observe(box)
    return () => {
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw)
      } catch {
        /* ignore */
      }
      ro.disconnect()
    }
  }, [
    chart,
    series,
    containerRef,
    lastCandleTs,
    barSeconds,
    future,
    lastPrice,
    scenarios,
    activeId,
  ])

  if (!future) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[11] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

export default StoryPathOverlay
