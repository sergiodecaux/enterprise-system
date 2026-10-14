/**
 * Canvas arrows from limit entry → hold target for bounce mode.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { BounceArrow } from '../../engine/trades/findBounceSetups'
import { useViewportRedraw } from './useViewportRedraw'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  arrows: BounceArrow[]
  lastCandleTs: number
  visible: boolean
  interactingRef?: React.MutableRefObject<boolean>
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n))
}

function drawHead(
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
  ctx.lineTo(-size, -size * 0.4)
  ctx.lineTo(-size * 0.55, 0)
  ctx.lineTo(-size, size * 0.4)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

const BounceArrowsOverlay = ({
  chart,
  series,
  containerRef,
  arrows,
  lastCandleTs,
  visible,
  interactingRef,
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const redrawRef = useRef<() => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    const box = containerRef.current
    if (!visible || !canvas || !chart || !series || !box || !arrows.length) {
      const ctx = canvas?.getContext('2d')
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
      redrawRef.current = () => {}
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

        let priceScaleW = 56
        try {
          const sw = chart.priceScale('right').width()
          if (typeof sw === 'number' && sw > 8) priceScaleW = sw
        } catch {
          /* ignore */
        }
        const plotRight = Math.max(72, w - priceScaleW - 8)

        let x0: number | null = null
        try {
          const x = chart.timeScale().timeToCoordinate(lastCandleTs as never)
          if (x != null && Number.isFinite(Number(x))) x0 = Number(x)
        } catch {
          /* ignore */
        }
        if (x0 == null) x0 = Math.min(w * 0.62, plotRight - 120)
        const x1 = clamp(x0 + Math.min(160, (plotRight - x0) * 0.72), x0 + 48, plotRight - 8)

        for (const a of arrows) {
          if (!(a.from > 0) || !(a.to > 0)) continue
          const yFrom = series.priceToCoordinate(a.from)
          const yTo = series.priceToCoordinate(a.to)
          if (yFrom == null || yTo == null) continue
          const y0 = clamp(Number(yFrom), 16, h - 16)
          const y1 = clamp(Number(yTo), 16, h - 16)
          const long = a.side === 'LONG'
          const color = long
            ? 'rgba(45, 212, 191, 0.95)'
            : 'rgba(251, 113, 133, 0.95)'

          ctx.save()
          ctx.strokeStyle = 'rgba(8,10,14,0.85)'
          ctx.lineWidth = 5
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          ctx.stroke()
          ctx.strokeStyle = color
          ctx.lineWidth = 2.6
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          ctx.stroke()
          drawHead(
            ctx,
            x1,
            y1,
            Math.atan2(y1 - y0, x1 - x0),
            color,
            14
          )

          // Limit tick
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(x0, y0, 3.5, 0, Math.PI * 2)
          ctx.fill()

          const label = a.label
          ctx.font = '800 10px ui-monospace, SFMono-Regular, Menlo, monospace'
          const tw = ctx.measureText(label).width
          const lx = clamp(x1 - tw - 6, 8, plotRight - tw - 8)
          const ly = clamp(y1 + (long ? -10 : 16), 14, h - 8)
          ctx.fillStyle = 'rgba(8,10,14,0.82)'
          ctx.fillRect(lx - 4, ly - 11, tw + 8, 16)
          ctx.strokeStyle = color
          ctx.lineWidth = 1
          ctx.strokeRect(lx - 4, ly - 11, tw + 8, 16)
          ctx.fillStyle = color
          ctx.fillText(label, lx, ly)
          ctx.restore()
        }
      } catch {
        /* never kill chart */
      }
    }

    redrawRef.current = redraw
    redraw()
    return () => {
      redrawRef.current = () => {}
    }
  }, [chart, series, containerRef, arrows, lastCandleTs, visible])

  useViewportRedraw(
    chart,
    containerRef.current,
    () => redrawRef.current(),
    { interactingRef, crosshair: false }
  )

  if (!visible || !arrows.length) return null

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 11 }}
    />
  )
}

export default BounceArrowsOverlay
