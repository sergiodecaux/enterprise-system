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

function paintZone(
  ctx: CanvasRenderingContext2D,
  series: ISeriesApi<'Candlestick'>,
  zone: FibZoneLayer,
  w: number,
  h: number,
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
    ? 'rgba(148, 163, 184, 0.08)'
    : inside
      ? cont
        ? 'rgba(96, 165, 250, 0.22)'
        : long
          ? 'rgba(52, 211, 153, 0.22)'
          : 'rgba(251, 113, 133, 0.22)'
      : cont
        ? 'rgba(96, 165, 250, 0.1)'
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

  const tag = cont ? 'CONT' : 'SWEEP'
  const xShift = cont ? 118 : 8
  const push = (id: string, text: string, y: number) => {
    const ly = Math.max(12, Math.min(h - 6, y))
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
  const mark = (price: number | null, id: string, text: string) => {
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
    push(id, text, y)
  }

  mark(zone.price141, `${zone.kind}:141`, `${tag} 141 ${fmtPx(zone.price141 ?? 0)}`)
  mark(zone.price161, `${zone.kind}:161`, `${tag} 161 ${fmtPx(zone.price161 ?? 0)}`)
  push(`${zone.kind}:top`, `${tag} ${fmtPx(zone.top)}`, top)
  push(`${zone.kind}:bottom`, fmtPx(zone.bottom), bot)
  if (hold) push(`${zone.kind}:state`, `${tag} HOLD`, (top + bot) / 2)
  if (fail) push(`${zone.kind}:state`, `${tag} BREAK`, (top + bot) / 2)
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  caption: FibCaption,
  y: number,
  w: number,
) {
  ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  const tw = ctx.measureText(caption.text).width
  const x = Math.max(6, w - tw - caption.xShift)
  ctx.fillStyle = 'rgba(8,10,14,0.88)'
  ctx.fillRect(x - 3, y - 10, tw + 6, 14)
  ctx.fillStyle = caption.color
  ctx.fillText(caption.text, x, y)
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

        const captions: FibCaption[] = []
        const requests: LabelRequest[] = []
        for (const zone of zones) {
          paintZone(ctx, series, zone, w, h, captions, requests)
        }
        const placed = publishLabels(layout, 'fib', fromListener, requests)
        for (const caption of captions) {
          const y = labelAnchor(placed, caption.id, caption.y)
          if (y == null) continue
          drawCaption(ctx, caption, y, w)
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
