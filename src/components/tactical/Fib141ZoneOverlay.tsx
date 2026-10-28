/**
 * 141–161 bands on the price scale. Sweep (reversal) and continuation
 * can be drawn together, with different colors and tags.
 * Band geometry is unchanged; caption Y goes through the shared label layout.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { Fib141State } from '../../engine/smc/structureRead'
import {
  LABEL_PRIORITY,
  labelAnchor,
  publishLabels,
  useChartLabels,
  watchLayer,
  type LabelRequest,
} from './chartLabels/LabelLayoutManager'

export interface FibZoneLayer {
  kind: 'sweep' | 'cont'
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
  zones: FibZoneLayer[]
}

interface FibCaption {
  id: string
  text: string
  y: number
  color: string
  xShift: number
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(2)
  return p.toPrecision(4)
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function paintZone(
  ctx: CanvasRenderingContext2D,
  series: ISeriesApi<'Candlestick'>,
  zone: FibZoneLayer,
  _w: number,
  h: number,
  plotRight: number,
  captions: FibCaption[],
  requests: LabelRequest[],
) {
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
  const hold = zone.state === 'BOUNCE' || zone.state === 'RECLAIM'
  const fail = zone.state === 'BREAK'
  const inside = zone.state === 'INSIDE'
  const quiet = zone.state === 'NONE' || zone.state === 'APPROACHING'
  const cont = zone.kind === 'cont'
  const long = zone.bias === 'LONG'
  const stroke = fail
    ? 'rgba(148, 163, 184, 0.85)'
    : cont
      ? hold
        ? 'rgba(167, 139, 250, 0.98)'
        : 'rgba(96, 165, 250, 0.95)'
      : hold
        ? 'rgba(52, 211, 153, 0.95)'
        : long
          ? 'rgba(52, 211, 153, 0.9)'
          : 'rgba(251, 113, 133, 0.9)'
  const fill = fail
    ? 'rgba(148, 163, 184, 0.05)'
    : inside
      ? cont
        ? 'rgba(96, 165, 250, 0.14)'
        : long
          ? 'rgba(52, 211, 153, 0.14)'
          : 'rgba(251, 113, 133, 0.14)'
      : cont
        ? 'rgba(96, 165, 250, 0.05)'
        : long
          ? 'rgba(52, 211, 153, 0.045)'
          : 'rgba(251, 113, 133, 0.045)'

  const bandW = Math.max(2, plotRight - 1)
  ctx.fillStyle = fill
  ctx.fillRect(0, top, bandW, Math.max(2, bot - top))
  ctx.strokeStyle = stroke
  ctx.globalAlpha = quiet ? 0.4 : 0.72
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, top + 0.5, bandW - 1, Math.max(2, bot - top))
  ctx.globalAlpha = 1

  const tag = cont ? 'CONT' : 'SWEEP'
  const xShift = cont ? 96 : 0
  const push = (id: string, text: string, y: number) => {
    // Keep the caption clear of the symbol legend in the top-left corner.
    const ly = Math.max(118, Math.min(h - 6, y))
    captions.push({ id, text, y: ly, color: stroke, xShift })
    requests.push({
      id,
      priceY: ly,
      text,
      priority: LABEL_PRIORITY.fib,
      sourceLayer: 'fib',
      height: 14,
    })
  }
  // 1.41 / 1.61 edges: a short leader by the price axis instead of a
  // full-width dashed line cutting the candles in half.
  const mark = (price: number | null, id: string, text: string) => {
    if (price == null) return
    const y = yOf(price)
    if (y == null) return
    ctx.strokeStyle = stroke
    ctx.globalAlpha = 0.55
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(Math.max(0, plotRight - 46), y + 0.5)
    ctx.lineTo(plotRight, y + 0.5)
    ctx.stroke()
    ctx.globalAlpha = 1
    push(id, text, y)
  }

  mark(zone.price141, `${zone.kind}:141`, `${tag} 141 ${fmtPx(zone.price141 ?? 0)}`)
  mark(zone.price161, `${zone.kind}:161`, `${tag} 161 ${fmtPx(zone.price161 ?? 0)}`)
  if (hold) push(`${zone.kind}:state`, `${tag} HOLD`, (top + bot) / 2)
  if (fail) push(`${zone.kind}:state`, `${tag} BREAK`, (top + bot) / 2)
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  caption: FibCaption,
  y: number,
  anchorY: number,
  plotRight: number,
) {
  ctx.save()
  ctx.font = '600 9px Inter, ui-sans-serif, system-ui, sans-serif'
  const padX = 5
  const tw = ctx.measureText(caption.text).width
  const bw = tw + padX * 2
  // TradingView puts a rectangle caption at its top-left corner.
  const x = Math.max(6, Math.min(6 + caption.xShift, plotRight - bw - 6))
  const top = y - 9
  if (Math.abs(y - anchorY) > 10) {
    ctx.setLineDash([2, 3])
    ctx.strokeStyle = caption.color
    ctx.globalAlpha = 0.4
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x + 6, anchorY)
    ctx.lineTo(x + 6, y > anchorY ? top : top + 13)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
  roundRect(ctx, x, top, bw, 13, 2)
  ctx.fillStyle = 'rgba(19,23,34,0.88)'
  ctx.fill()
  ctx.strokeStyle = caption.color
  ctx.globalAlpha = 0.42
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.fillStyle = caption.color
  ctx.textBaseline = 'middle'
  ctx.fillText(caption.text, x + padX, top + 6.5)
  ctx.restore()
}

const Fib141ZoneOverlay = ({ chart, series, containerRef, zones }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layout = useChartLabels()

  useEffect(() => {
    const canvas = canvasRef.current
    const box = containerRef.current
    const clear = () => {
      const ctx = canvas?.getContext('2d')
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    if (!canvas || !chart || !series || !box || zones.length === 0) {
      clear()
      layout.clear('fib')
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

        let plotRight = w - 56
        try {
          const axisW = chart.priceScale('right').width()
          if (typeof axisW === 'number' && axisW > 8) plotRight = w - axisW
        } catch {
          /* ignore */
        }

        const captions: FibCaption[] = []
        const requests: LabelRequest[] = []
        for (const zone of zones) {
          paintZone(ctx, series, zone, w, h, plotRight, captions, requests)
        }
        const placed = publishLabels(layout, 'fib', fromListener, requests)
        for (const caption of captions) {
          const y = labelAnchor(placed, caption.id, caption.y)
          if (y == null) continue
          drawCaption(ctx, caption, y, caption.y, plotRight)
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
    const unsub = watchLayer(layout, 'fib', onLayout)
    chart.timeScale().subscribeVisibleLogicalRangeChange(paint)
    const ro = new ResizeObserver(() => paint())
    ro.observe(box)
    return () => {
      unsub()
      layout.clear('fib')
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(paint)
      } catch {
        /* ignore */
      }
      ro.disconnect()
    }
  }, [chart, series, containerRef, zones, layout])

  if (zones.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[7] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

export default Fib141ZoneOverlay
