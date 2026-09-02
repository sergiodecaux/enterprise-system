/**
 * Scenario arrows on a canvas overlay — never a chart series.
 * Compact paths from the last bar, not stretched across empty right padding.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { StructureRead } from '../../engine/smc/structureRead'
import type { PathPoint } from '../../engine/prediction/types'

interface Props {
  chart: IChartApi | null
  series?: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  read: StructureRead | null
  lastCandleTs: number
  barSeconds: number
  showPath: boolean
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n))
}

function drawArrow(
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
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-size, -size * 0.42)
  ctx.lineTo(-size * 0.68, 0)
  ctx.lineTo(-size, size * 0.42)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function compact(points: PathPoint[]): PathPoint[] {
  if (points.length <= 3) return points
  const a = points[0]
  const b = points[points.length - 1]
  if (!a || !b) return points
  let mid = points[Math.floor(points.length / 2)] ?? b
  let best = 0
  const dt = b.timeOffsetSeconds - a.timeOffsetSeconds || 1
  const dp = b.price - a.price
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    const t = (p.timeOffsetSeconds - a.timeOffsetSeconds) / dt
    const d = Math.abs(p.price - (a.price + dp * t))
    if (d >= best) {
      best = d
      mid = p
    }
  }
  return [a, mid, b]
}

function toXy(
  points: PathPoint[],
  x0: number,
  x1: number,
  yOf: (price: number) => number | null,
  h: number
): Array<{ x: number; y: number }> {
  const src = compact(points)
  const maxT = Math.max(
    1,
    ...src.map((p) => p.timeOffsetSeconds).filter((t) => t > 0)
  )
  const out: Array<{ x: number; y: number }> = []
  for (const p of src) {
    if (!(p.price > 0) || !Number.isFinite(p.price)) continue
    const t = clamp(p.timeOffsetSeconds / maxT, 0, 1)
    const yRaw = yOf(p.price)
    if (yRaw == null || !Number.isFinite(yRaw)) continue
    out.push({
      x: x0 + (x1 - x0) * t,
      y: clamp(yRaw, 14, h - 16),
    })
  }
  return out
}

const StructureOverlay = ({
  chart,
  series,
  containerRef,
  read,
  lastCandleTs,
  barSeconds,
  showPath,
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const box = containerRef.current
    const list =
      showPath && read?.scenarios?.scenarios.length
        ? read.scenarios.scenarios.filter((sc) => sc.path.length >= 2)
        : []

    if (!canvas || !chart || !series || !box || !lastCandleTs || !list.length) {
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

        const xStart = chart.timeScale().timeToCoordinate(lastCandleTs as never)
        const x0 =
          xStart != null && Number.isFinite(Number(xStart)) ? Number(xStart) : w * 0.78
        const bars = barSeconds >= 86_400 ? 3 : barSeconds >= 14_400 ? 4 : 6
        const xHint = chart
          .timeScale()
          .timeToCoordinate((lastCandleTs + barSeconds * bars) as never)
        const spanCap = Math.min(92, Math.max(48, w * 0.22))
        const xEndHint =
          xHint != null && Number.isFinite(Number(xHint)) ? Number(xHint) : x0 + spanCap
        const x1base = clamp(xEndHint, x0 + 44, x0 + spanCap)

        const yOf = (price: number): number | null => {
          const y = series.priceToCoordinate(price)
          if (y == null) return null
          const n = Number(y)
          return Number.isFinite(n) ? n : null
        }

        for (let i = list.length - 1; i >= 0; i--) {
          const sc = list[i]
          const lead = i === 0
          const x1 = lead ? x1base : x0 + (x1base - x0) * (0.72 - i * 0.08)
          const pts = toXy(sc.path, x0, Math.max(x0 + 36, x1), yOf, h)
          if (pts.length < 2) continue
          ctx.beginPath()
          ctx.moveTo(pts[0].x, pts[0].y)
          if (pts.length === 2) {
            ctx.lineTo(pts[1].x, pts[1].y)
          } else {
            const c = pts[1]
            const n = pts[2]
            ctx.quadraticCurveTo(c.x, c.y, n.x, n.y)
          }
          ctx.strokeStyle = sc.color
          ctx.lineWidth = lead ? 2.35 : 1.35
          ctx.setLineDash(lead ? [] : [4, 4])
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.globalAlpha = lead ? 0.96 : 0.62
          ctx.stroke()
          ctx.setLineDash([])
          ctx.globalAlpha = 1

          const a = pts[pts.length - 2]
          const b = pts[pts.length - 1]
          const angle = Math.atan2(b.y - a.y, b.x - a.x)
          drawArrow(ctx, b.x, b.y, angle, sc.color, lead ? 10 : 7)

          const label = `${sc.id} ${sc.probability}%`
          ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace'
          const tw = ctx.measureText(label).width
          const lx = clamp(b.x - tw - 4, 4, w - tw - 6)
          const ly = clamp(b.y + (i === 0 ? (b.y > h / 2 ? -11 : 13) : i * 12), 12, h - 8)
          ctx.fillStyle = 'rgba(8,10,14,0.78)'
          ctx.fillRect(lx - 3, ly - 9, tw + 6, 13)
          ctx.fillStyle = sc.color
          ctx.fillText(label, lx, ly)
        }
      } catch {
        /* overlay must never kill the chart */
      }
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
  }, [chart, series, containerRef, read, lastCandleTs, barSeconds, showPath])

  if (!showPath) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[12] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

export default StructureOverlay
