/**
 * Thin ICT marks — last BOS/CHoCH, one FVG, PDH/PDL, one strong/weak pair.
 * Lines stay on the price. Text Y comes from the shared label layout.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { IctOverlayKind, IctOverlayMark } from '../../engine/smc/ictStructure'
import {
  LABEL_PRIORITY,
  labelAnchor,
  publishLabels,
  useChartLabels,
  watchLayer,
  type LabelRequest,
} from './chartLabels/LabelLayoutManager'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  marks: IctOverlayMark[]
  lastPrice?: number
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n))
}

function layoutPriority(kind: IctOverlayKind): number {
  switch (kind) {
    case 'BOS':
    case 'CHOCH':
      return LABEL_PRIORITY.structure
    case 'PDH':
    case 'PDL':
    case 'PWH':
    case 'PWL':
    case 'DO':
    case 'WO':
      return LABEL_PRIORITY.daily
    case 'FVG':
    case 'OB':
      return LABEL_PRIORITY.zone
    case 'EQH':
    case 'EQL':
      return LABEL_PRIORITY.whale
    default:
      return LABEL_PRIORITY.zone
  }
}

const IctMarksOverlay = ({ chart, series, containerRef, marks, lastPrice = 0 }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layout = useChartLabels()

  useEffect(() => {
    const canvas = canvasRef.current
    const box = containerRef.current
    if (!canvas || !chart || !series || !box || !marks.length) {
      const ctx = canvas?.getContext('2d')
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
      layout.clear('ict')
      return
    }

    let fromListener = false

    const paint = () => {
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

        const yOf = (price: number): number => {
          const y = series.priceToCoordinate(price)
          if (y != null) {
            const n = Number(y)
            if (Number.isFinite(n)) return n
          }
          return lastPrice > 0 && price >= lastPrice ? 16 : h - 18
        }
        const xOf = (timeSec: number): number | null => {
          const x = chart.timeScale().timeToCoordinate(timeSec as never)
          if (x == null) return null
          const n = Number(x)
          return Number.isFinite(n) ? n : null
        }

        const requests: LabelRequest[] = []
        const rows: { mark: IctOverlayMark; ly: number }[] = []

        for (const m of marks) {
          const y = yOf(m.price)
          const yClamped = clamp(y, 6, h - 6)
          const xStart =
            m.timeSec != null
              ? clamp(xOf(m.timeSec) ?? w * 0.18, 8, w - 40)
              : w * 0.16

          if (m.style === 'box' && m.top != null && m.bottom != null) {
            const yTop = yOf(m.top)
            const yBot = yOf(m.bottom)
            const top = Math.min(yTop, yBot)
            const bot = Math.max(yTop, yBot)
            ctx.fillStyle = m.color.replace(/[\d.]+\)$/, '0.16)')
            ctx.fillRect(xStart, top, Math.max(28, w - 16 - xStart), Math.max(4, bot - top))
            ctx.strokeStyle = m.color
            ctx.globalAlpha = 0.7
            ctx.lineWidth = 1.6
            ctx.setLineDash([4, 3])
            ctx.strokeRect(xStart, top, Math.max(28, w - 16 - xStart), Math.max(4, bot - top))
            ctx.setLineDash([])
            ctx.globalAlpha = 1
          } else if (m.style === 'label') {
            ctx.strokeStyle = m.color
            ctx.globalAlpha = 0.88
            ctx.lineWidth = 1.8
            ctx.setLineDash([5, 3])
            ctx.beginPath()
            ctx.moveTo(xStart, yClamped)
            ctx.lineTo(w - 8, yClamped)
            ctx.stroke()
            ctx.setLineDash([])
            ctx.globalAlpha = 1
          } else {
            ctx.strokeStyle = m.color
            ctx.globalAlpha = 0.8
            ctx.lineWidth = 1.6
            ctx.setLineDash(m.kind === 'PDH' || m.kind === 'PDL' ? [7, 4] : [4, 4])
            ctx.beginPath()
            ctx.moveTo(10, yClamped)
            ctx.lineTo(w - 8, yClamped)
            ctx.stroke()
            ctx.setLineDash([])
            ctx.globalAlpha = 1
          }

          const ly = clamp(m.style === 'box' ? yClamped - 10 : yClamped - 2, 16, h - 14)
          rows.push({ mark: m, ly })
          requests.push({
            id: m.id,
            priceY: ly,
            text: m.label,
            priority: layoutPriority(m.kind),
            sourceLayer: 'ict',
            height: 16,
          })
        }

        const placed = publishLabels(layout, 'ict', fromListener, requests)

        ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace'
        for (const row of rows) {
          const ly = labelAnchor(placed, row.mark.id, row.ly)
          if (ly == null) continue
          const text = row.mark.label
          const tw = ctx.measureText(text).width
          const lx = clamp(w - tw - 18, 6, w - tw - 8)
          ctx.fillStyle = 'rgba(8,10,14,0.9)'
          ctx.fillRect(lx - 4, ly - 11, tw + 8, 16)
          ctx.strokeStyle = row.mark.color
          ctx.globalAlpha = 0.55
          ctx.lineWidth = 1
          ctx.strokeRect(lx - 4, ly - 11, tw + 8, 16)
          ctx.globalAlpha = 1
          ctx.fillStyle = row.mark.color
          ctx.fillText(text, lx, ly + 1)
        }
      } catch {
        /* overlay must never kill the chart */
      }
    }

    const onLayout = () => {
      fromListener = true
      try {
        paint()
      } finally {
        fromListener = false
      }
    }

    paint()
    const unsub = watchLayer(layout, 'ict', onLayout)
    chart.timeScale().subscribeVisibleLogicalRangeChange(paint)
    const ro = new ResizeObserver(() => paint())
    ro.observe(box)
    return () => {
      unsub()
      layout.clear('ict')
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(paint)
      } catch {
        /* ignore */
      }
      ro.disconnect()
    }
  }, [chart, series, containerRef, marks, lastPrice, layout])

  if (!marks.length) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[8] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

export default IctMarksOverlay
