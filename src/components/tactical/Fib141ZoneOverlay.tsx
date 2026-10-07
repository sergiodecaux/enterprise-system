/**
 * Fibonacci 141–161 band on the price scale. Full visible width.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { Fib141State } from '../../engine/smc/structureRead'

export interface Fib141ZoneView {
  top: number
  bottom: number
  bias: 'LONG' | 'SHORT'
  price141: number | null
  price161: number | null
  state: Fib141State
}

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  zone: Fib141ZoneView | null
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(2)
  return p.toPrecision(4)
}

const Fib141ZoneOverlay = ({ chart, series, containerRef, zone }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const box = containerRef.current
    const clear = () => {
      const ctx = canvas?.getContext('2d')
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    if (!canvas || !chart || !series || !box || !zone) {
      clear()
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
          if (y == null || !Number.isFinite(Number(y))) return null
          return Number(y)
        }
        const yTop = yOf(zone.top)
        const yBot = yOf(zone.bottom)
        if (yTop == null || yBot == null) return
        const top = Math.min(yTop, yBot)
        const bot = Math.max(yTop, yBot)
        const long = zone.bias === 'LONG'
        const hold = zone.state === 'BOUNCE' || zone.state === 'RECLAIM'
        const fail = zone.state === 'BREAK'
        const inside = zone.state === 'INSIDE'
        const quiet = zone.state === 'NONE' || zone.state === 'APPROACHING'
        const stroke = fail
          ? 'rgba(148, 163, 184, 0.85)'
          : hold
            ? 'rgba(52, 211, 153, 0.95)'
            : long
              ? 'rgba(52, 211, 153, 0.9)'
              : 'rgba(251, 113, 133, 0.9)'
        const fill = fail
          ? 'rgba(148, 163, 184, 0.08)'
          : inside
            ? long
              ? 'rgba(52, 211, 153, 0.22)'
              : 'rgba(251, 113, 133, 0.22)'
            : long
              ? 'rgba(52, 211, 153, 0.08)'
              : 'rgba(251, 113, 133, 0.08)'

        ctx.fillStyle = fill
        ctx.fillRect(0, top, w, Math.max(2, bot - top))
        ctx.strokeStyle = stroke
        ctx.lineWidth = hold || inside ? 2 : 1.25
        ctx.setLineDash(quiet ? [6, 4] : [])
        ctx.strokeRect(0.5, top + 0.5, w - 1, Math.max(2, bot - top))
        ctx.setLineDash([])

        const mark = (price: number | null, text: string) => {
          if (price == null) return
          const y = yOf(price)
          if (y == null) return
          ctx.strokeStyle = stroke
          ctx.globalAlpha = 0.7
          ctx.lineWidth = 1
          ctx.setLineDash([3, 3])
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(w, y)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.globalAlpha = 1
          label(text, y)
        }
        const label = (text: string, y: number) => {
          ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
          const tw = ctx.measureText(text).width
          const x = Math.max(6, w - tw - 10)
          const ly = Math.max(12, Math.min(h - 6, y))
          ctx.fillStyle = 'rgba(8,10,14,0.88)'
          ctx.fillRect(x - 3, ly - 10, tw + 6, 14)
          ctx.fillStyle = stroke
          ctx.fillText(text, x, ly)
        }

        mark(zone.price141, `141 ${fmtPx(zone.price141 ?? 0)}`)
        mark(zone.price161, `161 ${fmtPx(zone.price161 ?? 0)}`)
        label(fmtPx(zone.top), top)
        label(fmtPx(zone.bottom), bot)
        if (hold) label('HOLD', (top + bot) / 2)
        if (fail) label('BREAK', (top + bot) / 2)
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
  }, [chart, series, containerRef, zone])

  if (!zone) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[7] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

export default Fib141ZoneOverlay
