/**
 * Scenario arrows on a canvas overlay — never a chart series.
 * Line series with future times squash candles on the time scale
 * the same way price lines squash them on the price scale.
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
  ctx.lineTo(-size, -size * 0.45)
  ctx.lineTo(-size * 0.7, 0)
  ctx.lineTo(-size, size * 0.45)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function toXy(
  points: PathPoint[],
  x0: number,
  x1: number,
  yOf: (price: number) => number | null,
  h: number
): Array<{ x: number; y: number }> {
  const maxT = Math.max(
    1,
    ...points.map((p) => p.timeOffsetSeconds).filter((t) => t > 0)
  )
  const out: Array<{ x: number; y: number }> = []
  for (const p of points) {
    if (!(p.price > 0) || !Number.isFinite(p.price)) continue
    const t = clamp(p.timeOffsetSeconds / maxT, 0, 1)
    const yRaw = yOf(p.price)
    let y: number
    if (yRaw == null || !Number.isFinite(yRaw)) {
      y = p.price >= points[0].price ? 16 : h - 18
    } else {
      y = yRaw
    }
    out.push({
      x: x0 + (x1 - x0) * t,
      y,
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
        const x0 = xStart != null && Number.isFinite(Number(xStart)) ? Number(xStart) : w * 0.72
        const x1 = Math.max(x0 + 36, w - 10)

        const yOf = (price: number): number | null => {
          const y = series.priceToCoordinate(price)
          if (y == null) return null
          const n = Number(y)
          return Number.isFinite(n) ? n : null
        }

        for (let i = list.length - 1; i >= 0; i--) {
          const sc = list[i]
          const xEnd = Math.max(x0 + 40, x1 - i * 14)
          const pts = toXy(sc.path, x0, xEnd, yOf, h)
          if (pts.length < 2) continue
          const lead = i === 0
          ctx.beginPath()
          ctx.moveTo(pts[0].x, pts[0].y)
          if (pts.length === 2) {
            ctx.lineTo(pts[1].x, pts[1].y)
          } else {
            for (let k = 1; k < pts.length - 1; k++) {
              const c = pts[k]
              const n = pts[k + 1]
              ctx.quadraticCurveTo(
                c.x,
                c.y,
                (c.x + n.x) / 2,
                (c.y + n.y) / 2
              )
            }
            const lastPt = pts[pts.length - 1]
            ctx.lineTo(lastPt.x, lastPt.y)
          }
          ctx.strokeStyle = sc.color
          ctx.lineWidth = lead ? 2.2 : 1.3
          ctx.setLineDash(lead ? [] : [5, 4])
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.globalAlpha = lead ? 0.95 : 0.72
          ctx.stroke()
          ctx.setLineDash([])
          ctx.globalAlpha = 1

          const a = pts[pts.length - 2]
          const b = pts[pts.length - 1]
          const angle = Math.atan2(b.y - a.y, b.x - a.x)
          drawArrow(ctx, b.x, b.y, angle, sc.color, lead ? 11 : 8)

          const label = `${sc.id} ${sc.probability}%`
          ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace'
          const tw = ctx.measureText(label).width
          const lx = clamp(b.x - tw - 6, 4, w - tw - 8)
          const ly = clamp(b.y + (b.y > h / 2 ? -12 : 14), 12, h - 8)
          ctx.fillStyle = 'rgba(8,10,14,0.72)'
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
  }, [chart, series, containerRef, read, lastCandleTs, showPath])

  if (!showPath) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[12] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

export default StructureOverlay
