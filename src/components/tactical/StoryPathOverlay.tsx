/**
 * TradingView-style path-to-target: 1–2 segment polyline + arrowhead + tip label.
 * Extra SMC scenarios live in ScenarioBoard — not overlapping doodles.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type {
  ChartStoryFuture,
  StoryScenario,
  StoryScenarioId,
} from '../../engine/smc/chartStory'
import { leadStoryScenario, storyTipLabel } from '../../engine/smc/chartStory'
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

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function drawTipLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  plotRight: number,
  h: number,
  compact: boolean
) {
  const fontPx = compact ? 11 : 12
  ctx.save()
  ctx.font = `700 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`
  const padX = compact ? 6 : 7
  const padY = compact ? 3 : 4
  const tw = ctx.measureText(text).width
  const bw = tw + padX * 2
  const bh = fontPx + padY * 2
  let lx = x + 10
  let ly = y - bh - 8
  if (lx + bw > plotRight - 4) lx = Math.max(8, x - bw - 10)
  if (ly < 4) ly = Math.min(h - bh - 4, y + 12)
  if (ly + bh > h - 4) ly = Math.max(4, h - bh - 4)
  roundRect(ctx, lx, ly, bw, bh, 4)
  ctx.fillStyle = 'rgba(8,10,14,0.9)'
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.2
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.fillText(text, lx + padX, ly + bh - padY - 1)
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
  activeId = null,
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
        const room = Math.max(24, plotRight - x0 - 10)
        const want = Math.max(
          compact ? 120 : 160,
          Math.min(future.bars, compact ? 18 : 22) * barPx
        )
        const span = Math.min(room, want)
        const x1 = x0 + span

        const yOf = (price: number): number | null => {
          const y = series.priceToCoordinate(price)
          if (y == null) return null
          const n = Number(y)
          return Number.isFinite(n) ? n : null
        }

        const selected = activeId
          ? scenarios.find((s) => s.id === activeId) ?? null
          : null
        const active =
          selected ?? leadStoryScenario(scenarios) ?? scenarios.find((s) => s.id === 'hold') ?? null
        const src: PathPoint[] =
          active?.path && active.path.length >= 2 ? active.path : future.path

        const xAtOffset = (t: number, maxT: number): number => {
          if (t <= 0) {
            return clamp(x0 + t * (barPx / bar), 12, x0)
          }
          return x0 + (x1 - x0) * clamp(t / Math.max(1, maxT), 0, 1)
        }

        const maxT = Math.max(
          1,
          ...src.map((p) => p.timeOffsetSeconds).filter((t) => t > 0),
          bar * Math.max(8, future.bars * 0.7)
        )
        const yLo = 14
        const yHi = h - 16
        const yToward = (price: number): number | null => {
          const y = yOf(price)
          if (y != null) return clamp(y, yLo, yHi)
          if (!(lastPrice > 0) || !(price > 0)) return null
          return price > lastPrice ? yLo : yHi
        }
        let pts: Array<{ x: number; y: number }> = []
        for (let i = 0; i < src.length; i++) {
          const p = src[i]
          if (!(p.price > 0) || !Number.isFinite(p.price)) continue
          const isEnd = i === src.length - 1
          const y = isEnd ? yToward(p.price) : yOf(p.price)
          if (y == null) continue
          pts.push({
            x: clamp(xAtOffset(p.timeOffsetSeconds, maxT), 8, plotRight - 6),
            y: clamp(y, yLo, yHi),
          })
        }

        const yFrom = yToward(
          active?.path[0]?.price ?? lastPrice ?? future.path[0]?.price ?? 0
        )
        const targetPx = active?.toPrice ?? future.targetPrice
        const yTo = yToward(targetPx)
        if (pts.length < 2) {
          if (yFrom != null && yTo != null) {
            pts = [
              { x: x0, y: yFrom },
              { x: x1 - 4, y: yTo },
            ]
          }
        } else if (yTo != null) {
          const last = pts[pts.length - 1]
          if (Math.abs(last.y - yTo) > 3 || last.x < x1 - 10) {
            pts[pts.length - 1] = { x: x1 - 4, y: yTo }
          }
        }
        if (pts.length < 2) return

        const color = pathColor(active, future.side)
        const dashed =
          active != null && (active.id === 'break' || active.id === 'chop')
        const width = compact ? 3.8 : 3.4
        const halo = compact ? 6.6 : 5.8

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
          compact ? 18 : 16
        )

        const tip =
          active?.tipLabel ||
          future.tipLabel ||
          (targetPx > 0 ? storyTipLabel(targetPx) : '')
        if (tip) {
          drawTipLabel(ctx, b.x, b.y, tip, color, plotRight, h, compact)
        }
      } catch {
        /* overlay must never kill the chart */
      }
    }

    try {
      const ts = chart.timeScale()
      const current = ts.options().rightOffset ?? 8
      const compactFuture = (containerRef.current?.clientWidth ?? 400) < 560
      const need = Math.min(
        compactFuture ? 24 : 30,
        Math.max(compactFuture ? 16 : 18, future.bars + 4)
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
