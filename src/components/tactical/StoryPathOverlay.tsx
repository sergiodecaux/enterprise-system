/**
 * TradingView-style future window + SMC arrows from the take zone:
 * bold hold path (sweep → displacement → liquidity), faint fail path on pullback.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type {
  ChartStoryFuture,
  StoryArrow,
} from '../../engine/smc/chartStory'
import { fmtStoryPrice } from '../../engine/smc/chartStory'
import type { PathPoint } from '../../engine/prediction/types'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  lastCandleTs: number
  barSeconds: number
  future: ChartStoryFuture | null
  lastPrice: number
  arrows?: StoryArrow[]
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
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-size, -size * 0.42)
  ctx.lineTo(-size * 0.68, 0)
  ctx.lineTo(-size, size * 0.42)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function strokePath(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  color: string,
  width: number,
  alpha: number,
  dash: number[]
) {
  if (pts.length < 2) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    ctx.quadraticCurveTo((prev.x + cur.x) / 2, prev.y, cur.x, cur.y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

const StoryPathOverlay = ({
  chart,
  series,
  containerRef,
  lastCandleTs,
  barSeconds,
  future,
  lastPrice,
  arrows = [],
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
          plotRight - x0 - 4,
          Math.max(compact ? 64 : 48, Math.min(future.bars, compact ? 12 : 14) * barPx)
        )
        const x1 = x0 + span

        const yOf = (price: number): number | null => {
          const y = series.priceToCoordinate(price)
          if (y == null) return null
          const n = Number(y)
          return Number.isFinite(n) ? n : null
        }

        const xOfTime = (sec: number): number | null => {
          if (!(sec > 0)) return null
          const x = chart.timeScale().timeToCoordinate(sec as Time)
          if (x == null) return null
          const n = Number(x)
          return Number.isFinite(n) ? n : null
        }

        const hold = arrows.find((a) => a.kind === 'PRIMARY') ?? arrows[0] ?? null
        const fail = arrows.find((a) => a.kind === 'FAIL') ?? null

        let xZone = x0
        if (hold) {
          const xEnd = xOfTime(hold.zoneEndSec)
          const xBeg = xOfTime(hold.zoneStartSec)
          const xRight = xEnd != null ? Math.min(xEnd, x0) : x0
          if (xBeg != null && Number.isFinite(xBeg)) {
            xZone = xBeg + Math.max(12, (xRight - xBeg) * 0.78)
          } else if (xEnd != null) {
            xZone = xRight
          }
        }
        xZone = clamp(xZone, 8, Math.max(8, x0 - Math.max(22, barPx * 2.2)))

        const yHi = yOf(future.boxHigh)
        const yLo = yOf(future.boxLow)
        const yNow = yOf(lastPrice > 0 ? lastPrice : future.path[0]?.price ?? 0)
        if (yHi == null || yLo == null) return

        const top = clamp(Math.min(yHi, yLo), 8, h - 10)
        const bot = clamp(Math.max(yHi, yLo), 12, h - 8)
        const boxH = Math.max(18, bot - top)

        ctx.fillStyle = compact ? 'rgba(212, 175, 110, 0.16)' : 'rgba(212, 175, 110, 0.14)'
        ctx.strokeStyle = 'rgba(212, 175, 110, 0.42)'
        ctx.lineWidth = compact ? 1.25 : 1
        ctx.beginPath()
        ctx.rect(x0, top, Math.max(8, x1 - x0), boxH)
        ctx.fill()
        ctx.stroke()

        ctx.setLineDash([3, 4])
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.28)'
        ctx.beginPath()
        ctx.moveTo(x0, 6)
        ctx.lineTo(x0, h - 6)
        ctx.stroke()
        ctx.setLineDash([])

        const xAtOffset = (t: number, maxT: number): number => {
          if (t <= 0) {
            const tMin = Math.min(0, -bar * 2.4)
            if (tMin >= 0) return x0
            return xZone + (x0 - xZone) * (t - tMin) / (0 - tMin)
          }
          return x0 + (x1 - x0) * clamp(t / Math.max(1, maxT), 0, 1)
        }

        const mapPts = (src: PathPoint[]): Array<{ x: number; y: number; label?: string }> => {
          const maxT = Math.max(
            1,
            ...src.map((p) => p.timeOffsetSeconds).filter((t) => t > 0),
            bar * future.bars
          )
          const pts: Array<{ x: number; y: number; label?: string }> = []
          for (const p of src) {
            if (!(p.price > 0) || !Number.isFinite(p.price)) continue
            const y = yOf(p.price)
            if (y == null) continue
            pts.push({
              x: xAtOffset(p.timeOffsetSeconds, maxT),
              y: clamp(y, 14, h - 16),
              label: p.label,
            })
          }
          return pts
        }

        let holdPts = mapPts(future.path)
        if (holdPts.length < 2 && yNow != null) {
          const yT = yOf(future.targetPrice)
          const yFrom = hold ? yOf(hold.fromPrice) : yNow
          if (yT != null && yFrom != null) {
            holdPts = [
              { x: xZone, y: clamp(yFrom, 14, h - 16), label: 'зона' },
              { x: x0, y: clamp(yNow, 14, h - 16), label: 'сейчас' },
              { x: x1 - 6, y: clamp(yT, 14, h - 16), label: future.targetLabel },
            ]
          }
        }

        const failPts =
          future.failPath && future.failPath.length >= 2
            ? mapPts(future.failPath)
            : []

        const holdColor = future.side === 'LONG' ? '#86efac' : '#fda4af'
        const failColor = future.side === 'LONG' ? '#fda4af' : '#86efac'

        if (failPts.length >= 2) {
          strokePath(ctx, failPts, failColor, compact ? 1.35 : 1.15, 0.38, [5, 5])
          const fa = failPts[failPts.length - 2]
          const fb = failPts[failPts.length - 1]
          ctx.globalAlpha = 0.4
          drawArrowHead(
            ctx,
            fb.x,
            fb.y,
            Math.atan2(fb.y - fa.y, fb.x - fa.x),
            failColor,
            compact ? 9 : 7
          )
          ctx.globalAlpha = 1
          if (fail) {
            const tag = `${fail.label} ${Math.round(fail.oddsPct)}%`
            const fontPx = compact ? 11 : 9
            ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`
            const tw = ctx.measureText(tag).width
            const padY = compact ? 12 : 10
            const lx = clamp(x0 + 6, x0 + 2, Math.max(x0 + 2, plotRight - tw - 8))
            const ly = clamp(fb.y + (fb.y > h / 2 ? 14 : -10), padY, h - 8)
            ctx.fillStyle = 'rgba(8,10,14,0.62)'
            ctx.fillRect(lx - 4, ly - fontPx + 1, tw + 8, fontPx + 6)
            ctx.fillStyle = 'rgba(248,250,252,0.62)'
            ctx.fillText(tag, lx, ly)
          }
        }

        if (holdPts.length >= 2) {
          strokePath(ctx, holdPts, holdColor, compact ? 2.7 : 2.35, 0.96, [])
          const a = holdPts[holdPts.length - 2]
          const b = holdPts[holdPts.length - 1]
          drawArrowHead(
            ctx,
            b.x,
            b.y,
            Math.atan2(b.y - a.y, b.x - a.x),
            holdColor,
            compact ? 13 : 11
          )

          const dir = hold?.label ?? (future.side === 'LONG' ? 'лонг' : 'шорт')
          const pct = hold ? Math.round(hold.oddsPct) : null
          const head = pct != null ? `${dir} ${pct}%` : dir
          const tgt = fmtStoryPrice(future.targetPrice)
          const tag = compact ? head : `${head} → ${tgt}`
          const fontPx = compact ? 12 : 10
          ctx.font = `bold ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`
          const tw = ctx.measureText(tag).width
          const mid = holdPts[Math.min(holdPts.length - 1, Math.max(1, Math.floor(holdPts.length * 0.62)))]
          const labelX = Math.max(x0 + 4, mid.x)
          const lx = clamp(labelX - tw * 0.2, x0 + 2, Math.max(x0 + 2, plotRight - tw - 8))
          const ly = clamp(mid.y + (mid.y > h / 2 ? 18 : -14), compact ? 18 : 14, h - 10)
          ctx.fillStyle = 'rgba(8,10,14,0.86)'
          ctx.fillRect(lx - 5, ly - fontPx, tw + 10, fontPx + 8)
          ctx.fillStyle = holdColor
          ctx.fillText(tag, lx, ly)
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
        compactFuture ? 20 : 28,
        Math.max(compactFuture ? 12 : 14, future.bars + 4)
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
  }, [chart, series, containerRef, lastCandleTs, barSeconds, future, lastPrice, arrows])

  if (!future) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[11] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

export default StoryPathOverlay
