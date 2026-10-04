/**
 * Thin ICT marks — last BOS/CHoCH, one FVG, PDH/PDL, one strong/weak pair.
 * Forecast arrows stay primary; this layer must stay quiet.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { IctOverlayMark } from '../../engine/smc/ictStructure'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  marks: IctOverlayMark[]
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n))
}

const IctMarksOverlay = ({ chart, series, containerRef, marks }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const box = containerRef.current
    if (!canvas || !chart || !series || !box || !marks.length) {
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

        const yOf = (price: number): number | null => {
          const y = series.priceToCoordinate(price)
          if (y == null) return null
          const n = Number(y)
          return Number.isFinite(n) ? n : null
        }
        const xOf = (timeSec: number): number | null => {
          const x = chart.timeScale().timeToCoordinate(timeSec as never)
          if (x == null) return null
          const n = Number(x)
          return Number.isFinite(n) ? n : null
        }

        const usedY: number[] = []
        const placeLabelY = (raw: number): number => {
          let y = clamp(raw, 12, h - 10)
          for (let i = 0; i < 5; i++) {
            if (!usedY.some((u) => Math.abs(u - y) < 12)) break
            y = clamp(y + 12, 12, h - 10)
          }
          usedY.push(y)
          return y
        }

        for (const m of marks) {
          const y = yOf(m.price)
          if (y == null) continue
          const yClamped = clamp(y, 4, h - 4)
          const xStart =
            m.timeSec != null
              ? clamp(xOf(m.timeSec) ?? w * 0.18, 8, w - 40)
              : w * 0.16

          if (m.style === 'box' && m.top != null && m.bottom != null) {
            const yTop = yOf(m.top)
            const yBot = yOf(m.bottom)
            if (yTop != null && yBot != null) {
              const top = Math.min(yTop, yBot)
              const bot = Math.max(yTop, yBot)
              ctx.fillStyle = m.color.replace(/[\d.]+\)$/, '0.12)')
              ctx.fillRect(xStart, top, Math.max(28, w - 16 - xStart), Math.max(3, bot - top))
              ctx.strokeStyle = m.color
              ctx.globalAlpha = 0.45
              ctx.lineWidth = 1
              ctx.setLineDash([3, 3])
              ctx.strokeRect(xStart, top, Math.max(28, w - 16 - xStart), Math.max(3, bot - top))
              ctx.setLineDash([])
              ctx.globalAlpha = 1
            }
          } else if (m.style === 'label') {
            ctx.strokeStyle = m.color
            ctx.globalAlpha = 0.7
            ctx.lineWidth = 1
            ctx.setLineDash([4, 3])
            ctx.beginPath()
            ctx.moveTo(xStart, yClamped)
            ctx.lineTo(w - 10, yClamped)
            ctx.stroke()
            ctx.setLineDash([])
            ctx.globalAlpha = 1
          } else {
            ctx.strokeStyle = m.color
            ctx.globalAlpha = 0.55
            ctx.lineWidth = 1
            ctx.setLineDash(m.kind === 'PDH' || m.kind === 'PDL' ? [6, 4] : [3, 4])
            ctx.beginPath()
            ctx.moveTo(12, yClamped)
            ctx.lineTo(w - 10, yClamped)
            ctx.stroke()
            ctx.setLineDash([])
            ctx.globalAlpha = 1
          }

          const text = m.label
          ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
          const tw = ctx.measureText(text).width
          const ly = placeLabelY(m.style === 'box' ? yClamped - 8 : yClamped - 3)
          const lx = clamp(w - tw - 14, 6, w - tw - 6)
          ctx.fillStyle = 'rgba(8,10,14,0.72)'
          ctx.fillRect(lx - 2, ly - 8, tw + 4, 11)
          ctx.fillStyle = m.color
          ctx.fillText(text, lx, ly)
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
  }, [chart, series, containerRef, marks])

  if (!marks.length) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[8] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

export default IctMarksOverlay
