/**
 * Intraday scenario path on canvas — break, reclaim, next, destination.
 * Uses the empty right of the chart, not a 6-bar scalp stub.
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

function toXy(
  points: PathPoint[],
  x0: number,
  x1: number,
  yOf: (price: number) => number | null,
  h: number
): Array<{ x: number; y: number; label?: string }> {
  const src = points.filter((p) => p.price > 0 && Number.isFinite(p.price)).slice(0, 6)
  const maxT = Math.max(
    1,
    ...src.map((p) => p.timeOffsetSeconds).filter((t) => t > 0)
  )
  const out: Array<{ x: number; y: number; label?: string }> = []
  for (const p of src) {
    const t = clamp(p.timeOffsetSeconds / maxT, 0, 1)
    const yRaw = yOf(p.price)
    if (yRaw == null || !Number.isFinite(yRaw)) continue
    out.push({
      x: x0 + (x1 - x0) * t,
      y: clamp(yRaw, 18, h - 20),
      label: p.label,
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
          xStart != null && Number.isFinite(Number(xStart)) ? Number(xStart) : w * 0.62
        const barsAhead =
          barSeconds >= 86_400 ? 3 : barSeconds >= 14_400 ? 6 : barSeconds >= 3_600 ? 12 : 32
        const xHint = chart
          .timeScale()
          .timeToCoordinate((lastCandleTs + barSeconds * barsAhead) as never)
        const xRight = w - 10
        const xEndHint =
          xHint != null && Number.isFinite(Number(xHint)) ? Number(xHint) : x0 + w * 0.32
        const x1base = clamp(xEndHint, x0 + 88, xRight)

        const yOf = (price: number): number | null => {
          const y = series.priceToCoordinate(price)
          if (y == null) return null
          const n = Number(y)
          return Number.isFinite(n) ? n : null
        }

        for (let i = list.length - 1; i >= 0; i--) {
          const sc = list[i]
          const lead = i === 0
          const x1 = lead ? x1base : x0 + (x1base - x0) * 0.78
          const pts = toXy(sc.path, x0, Math.max(x0 + 70, x1), yOf, h)
          if (pts.length < 2) continue
          ctx.beginPath()
          ctx.moveTo(pts[0].x, pts[0].y)
          for (let k = 1; k < pts.length; k++) {
            const prev = pts[k - 1]
            const cur = pts[k]
            const mx = (prev.x + cur.x) / 2
            ctx.quadraticCurveTo(mx, prev.y, cur.x, cur.y)
          }
          ctx.strokeStyle = sc.color
          ctx.lineWidth = lead ? 2.4 : 1.3
          ctx.setLineDash(lead ? [] : [5, 4])
          ctx.lineJoin = 'round'
          ctx.lineCap = 'round'
          ctx.globalAlpha = lead ? 0.96 : 0.55
          ctx.stroke()
          ctx.setLineDash([])
          ctx.globalAlpha = 1

          const a = pts[pts.length - 2]
          const b = pts[pts.length - 1]
          const angle = Math.atan2(b.y - a.y, b.x - a.x)
          drawArrow(ctx, b.x, b.y, angle, sc.color, lead ? 11 : 7)

          if (lead) {
            ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
            for (let k = 1; k < pts.length; k++) {
              const p = pts[k]
              const text = p.label
              if (!text || text === 'сейчас') continue
              const short = text.length > 22 ? `${text.slice(0, 20)}…` : text
              const tw = ctx.measureText(short).width
              const lx = clamp(p.x - tw / 2, 4, w - tw - 4)
              const ly = clamp(p.y + (p.y > h / 2 ? -10 : 14), 12, h - 8)
              ctx.fillStyle = 'rgba(8,10,14,0.78)'
              ctx.fillRect(lx - 2, ly - 8, tw + 4, 11)
              ctx.fillStyle = sc.color
              ctx.fillText(short, lx, ly)
            }
          }

          const tag = `${sc.id} ${sc.probability}%`
          ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace'
          const tw = ctx.measureText(tag).width
          const lx = clamp(b.x - tw - 4, 4, w - tw - 6)
          const ly = clamp(b.y + (lead ? (b.y > h / 2 ? 16 : -14) : i * 11), 12, h - 8)
          ctx.fillStyle = 'rgba(8,10,14,0.8)'
          ctx.fillRect(lx - 3, ly - 9, tw + 6, 13)
          ctx.fillStyle = sc.color
          ctx.fillText(tag, lx, ly)
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
