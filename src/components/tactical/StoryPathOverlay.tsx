/**
 * Four descriptive polylines. Lead / active path is bold;
 * others stay muted so the chart stays readable while panning.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type {
  ChartStoryFuture,
  StoryScenario,
  StoryScenarioId,
} from '../../engine/smc/chartStory'
import { storyPathColor, storyTipLabel } from '../../engine/smc/chartStory'
import type { PathPoint } from '../../engine/prediction/types'
import {
  LABEL_PRIORITY,
  labelAnchor,
  publishLabels,
  useChartLabels,
  watchLayer,
  type LabelRequest,
} from './chartLabels/LabelLayoutManager'
import { useViewportRedraw } from './useViewportRedraw'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  lastCandleTs: number
  barSeconds: number
  future: ChartStoryFuture | null
  lastPrice: number
  scenarios?: StoryScenario[]
  activeId?: StoryScenarioId | null
  interactingRef?: React.MutableRefObject<boolean>
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
  ctx.strokeStyle = 'rgba(8,10,14,0.92)'
  ctx.lineWidth = Math.max(1, size * 0.08)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-size, -size * 0.42)
  ctx.lineTo(-size * 0.55, 0)
  ctx.lineTo(-size, size * 0.42)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function drawWaypointLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  plotRight: number,
  h: number,
  _compact: boolean
) {
  const fontPx = 9
  ctx.save()
  ctx.font = `600 ${fontPx}px Inter, ui-sans-serif, system-ui, sans-serif`
  const padX = 5
  const padY = 2
  const tw = ctx.measureText(text).width
  const bw = tw + padX * 2
  const bh = fontPx + padY * 2
  let lx = x - bw / 2
  let ly = y + 10
  if (lx < 6) lx = 6
  if (lx + bw > plotRight - 4) lx = Math.max(6, plotRight - bw - 4)
  if (ly + bh > h - 4) ly = Math.max(4, y - bh - 8)
  roundRect(ctx, lx, ly, bw, bh, 2)
  ctx.fillStyle = 'rgba(14,17,22,0.82)'
  ctx.fill()
  ctx.strokeStyle = hexAlpha(color, 0.4)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = hexAlpha(color, 0.95)
  ctx.fillText(text, lx + padX, ly + bh - padY - 1)
  ctx.restore()
}

function drawTipLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  anchorY: number,
  text: string,
  color: string,
  plotRight: number,
  h: number,
  compact: boolean
) {
  const fontPx = compact ? 9 : 10
  ctx.save()
  ctx.font = `600 ${fontPx}px Inter, ui-sans-serif, system-ui, sans-serif`
  // Target first, reason never: "ломает вниз 143.1 → стопы снизу" reads as
  // "ломает вниз 143.1" on the chart; the why lives in the panels.
  const head = text.split('→')[0].trim()
  const shown = head.length > 26 ? `${head.slice(0, 25)}…` : head
  const padX = 6
  const padY = 3
  const tw = ctx.measureText(shown).width
  const bw = tw + padX * 2
  const bh = fontPx + padY * 2
  let lx = x + 10
  let ly = y - bh - 8
  if (lx + bw > plotRight - 4) lx = Math.max(8, x - bw - 10)
  if (ly < 4) ly = Math.min(h - bh - 4, y + 12)
  if (ly + bh > h - 4) ly = Math.max(4, h - bh - 4)
  // If the shared label layout pushed the caption away from the path tip,
  // keep the connection readable with a dotted leader.
  if (Math.abs(ly + bh / 2 - anchorY) > 12) {
    ctx.setLineDash([2, 3])
    ctx.strokeStyle = hexAlpha(color, 0.45)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, anchorY)
    ctx.lineTo(Math.max(lx + 4, Math.min(lx + bw - 4, x)), ly + (ly > anchorY ? 0 : bh))
    ctx.stroke()
    ctx.setLineDash([])
  }
  roundRect(ctx, lx, ly, bw, bh, 2)
  ctx.fillStyle = 'rgba(19,23,34,0.9)'
  ctx.fill()
  ctx.strokeStyle = hexAlpha(color, 0.55)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = 'rgba(240,244,250,0.94)'
  ctx.fillText(shown, lx + padX, ly + bh - padY - 1)
  ctx.restore()
}

function strokePolyline(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  color: string,
  width: number,
  dash: number[],
  alpha: number
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
    ctx.lineTo(pts[i].x, pts[i].y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

function hexAlpha(color: string, a: number): string {
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    const h =
      color.length === 4
        ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color
    const r = parseInt(h.slice(1, 3), 16)
    const g = parseInt(h.slice(3, 5), 16)
    const b = parseInt(h.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${a})`
  }
  return color
}

function drawSpentLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y: number,
  plotRight: number,
  compact: boolean
) {
  const x1 = Math.min(plotRight - 8, x0 + (compact ? 52 : 72))
  ctx.save()
  ctx.strokeStyle = 'rgba(107,114,128,0.7)'
  ctx.lineWidth = 1.2
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(x0, y)
  ctx.lineTo(x1, y)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

function drawSpentNote(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y: number,
  plotRight: number,
  note: string,
  compact: boolean
) {
  ctx.save()
  ctx.font = `700 ${compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`
  const padX = 5
  const padY = 3
  const tw = ctx.measureText(note).width
  const bw = tw + padX * 2
  const bh = (compact ? 10 : 11) + padY * 2
  const lx = Math.min(x0 + 8, plotRight - bw - 4)
  const ly = y - bh - 6
  roundRect(ctx, lx, ly, bw, bh, 4)
  ctx.fillStyle = 'rgba(17,19,24,0.88)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(107,114,128,0.85)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = 'rgba(209,213,219,0.9)'
  ctx.fillText(note, lx + padX, ly + bh - padY - 1)
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
  scenarios = [],
  activeId = null,
  interactingRef,
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const askedRight = useRef(0)
  const layout = useChartLabels()
  const fromListenerRef = useRef(false)
  const redrawRef = useRef<() => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    const box = containerRef.current
    if (!canvas || !chart || !series || !box || !lastCandleTs || !future) {
      const ctx = canvas?.getContext('2d')
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height)
      layout.clear('story')
      redrawRef.current = () => {}
      return
    }

    const redraw = () => {
      try {
        const fromListener = fromListenerRef.current
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

        const timeScale = chart.timeScale()
        const xStart = (() => {
          try {
            return timeScale.timeToCoordinate(lastCandleTs as never)
          } catch {
            return null
          }
        })()
        let x0 =
          xStart != null && Number.isFinite(Number(xStart))
            ? Number(xStart)
            : null
        const minGap = Math.min(260, Math.max(140, (plotRight - 16) * 0.32))
        if (x0 != null && x0 < plotRight - 4 && plotRight - x0 < minGap) {
          try {
            const logical = timeScale.coordinateToLogical(x0)
            const vr = timeScale.getVisibleLogicalRange()
            if (logical != null && vr && vr.to > vr.from) {
              const leftBars = Math.max(12, logical - vr.from)
              const fraction = minGap / Math.max(plotRight, 1)
              const extra = Math.ceil((fraction / Math.max(0.08, 1 - fraction)) * leftBars)
              const nextTo = Math.round(logical + extra)
              if (vr.to < nextTo - 1 && askedRight.current !== nextTo) {
                askedRight.current = nextTo
                timeScale.setVisibleLogicalRange({ from: vr.from, to: nextTo })
                return
              }
            }
          } catch {
            /* draw in the gap that exists */
          }
        } else if (x0 != null && plotRight - x0 >= minGap) {
          askedRight.current = 0
        }
        if (x0 == null) x0 = Math.min(w * 0.68, plotRight - minGap)
        if (x0 >= plotRight - 8) {
          if (!fromListener) layout.clear('story')
          return
        }

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
        const room = Math.max(24, plotRight - x0 - 10)
        const want = Math.max(
          compact ? 120 : 160,
          Math.min(future.bars, compact ? 18 : 24) * barPx
        )
        const span = Math.min(room, want)
        const x1 = x0 + span

        const yOf = (price: number): number | null => {
          try {
            const y = series.priceToCoordinate(price)
            if (y == null) return null
            const n = Number(y)
            return Number.isFinite(n) ? n : null
          } catch {
            return null
          }
        }

        const active = activeId
          ? scenarios.find((s) => s.id === activeId) ?? null
          : null

        const rows =
          scenarios.length >= 4
            ? scenarios.slice(0, 4)
            : active
              ? [active]
              : []

        const maxT = Math.max(
          1,
          bar * Math.max(8, future.bars * 0.7),
          ...rows.flatMap((sc) =>
            sc.path.map((p) => p.timeOffsetSeconds).filter((t) => t > 0)
          ),
          ...future.path.map((p) => p.timeOffsetSeconds).filter((t) => t > 0)
        )

        const xAtOffset = (t: number): number => {
          if (t <= 0) {
            return clamp(x0 + t * (barPx / bar), 12, x0)
          }
          return x0 + (x1 - x0) * clamp(t / maxT, 0, 1)
        }

        const yLo = 14
        const yHi = h - 16
        const yToward = (price: number): number | null => {
          const y = yOf(price)
          if (y != null) return clamp(y, yLo, yHi)
          if (!(lastPrice > 0) || !(price > 0)) return null
          return price > lastPrice ? yLo : yHi
        }

        const mapPath = (
          src: PathPoint[]
        ): Array<{ x: number; y: number; label?: string; key?: boolean }> => {
          const pts: Array<{ x: number; y: number; label?: string; key?: boolean }> = []
          for (const p of src) {
            if (!(p.price > 0) || !Number.isFinite(p.price)) continue
            const y = yOf(p.price) ?? yToward(p.price)
            if (y == null) continue
            pts.push({
              x: clamp(xAtOffset(p.timeOffsetSeconds), 8, plotRight - 6),
              y: clamp(y, yLo, yHi),
              label: p.label,
              key: p.isKeyLevel,
            })
          }
          return pts
        }

        const drawOne = (sc: StoryScenario, on: boolean, equal: boolean) => {
          if (sc.spent) {
            if (!on) return
            const y =
              sc.spentPrice != null && sc.spentPrice > 0
                ? yToward(sc.spentPrice)
                : yToward(lastPrice)
            if (y == null) return
            drawSpentLine(ctx, x0, y, plotRight, compact)
            const note = sc.spentNote || 'уже сняли'
            captions.push({
              id: `story:${sc.id}:spent`,
              kind: 'spent',
              text: note,
              x: x0,
              y,
              color: 'rgba(107,114,128,0.85)',
            })
            return
          }
          const src: PathPoint[] =
            sc.path && sc.path.length >= 2 ? sc.path : on ? future.path : []
          const pts = mapPath(src)
          if (pts.length < 2) return
          const color = storyPathColor(sc.id, sc.side)
          const dashed = sc.id === 'break' || sc.id === 'chop'
          const dash = dashed ? (on || equal ? [7, 5] : [5, 6]) : []
          const sweepThru =
            sc.id === 'sweep' && on && pts.length >= 3
              ? pts.slice(0, Math.min(3, pts.length))
              : null
          if (on) {
            strokePolyline(ctx, pts, 'rgba(8,10,14,0.75)', compact ? 4.6 : 4.2, dash, 1)
            strokePolyline(ctx, pts, color, compact ? 2.2 : 2, dash, 1)
            if (sweepThru && sweepThru.length >= 2) {
              strokePolyline(
                ctx,
                sweepThru,
                hexAlpha(color, 0.95),
                compact ? 3.2 : 2.8,
                [],
                1
              )
            }
          } else if (equal) {
            // Soft equal weight — lead still slightly stronger via pct sort order
            strokePolyline(ctx, pts, hexAlpha(color, 0.5), compact ? 1.4 : 1.2, dash, 1)
          } else {
            strokePolyline(ctx, pts, hexAlpha(color, 0.2), compact ? 1 : 0.9, dash, 1)
          }
          const a = pts[pts.length - 2]
          const b = pts[pts.length - 1]
          if (a && b) {
            drawArrowHead(
              ctx,
              b.x,
              b.y,
              Math.atan2(b.y - a.y, b.x - a.x),
              on ? color : equal ? hexAlpha(color, 0.6) : hexAlpha(color, 0.35),
              on ? (compact ? 17 : 16) : equal ? (compact ? 11 : 10) : compact ? 8 : 7
            )
          }
          if (on) {
            const tip =
              sc.tipLabel ||
              future.tipLabel ||
              (sc.toPrice && sc.toPrice > 0 ? storyTipLabel(sc.toPrice) : '')
            if (tip && b && tip !== 'уже сняли') {
              captions.push({
                id: `story:${sc.id}:tip`,
                kind: 'tip',
                text: tip,
                x: b.x,
                y: b.y,
                color,
              })
            }
            for (const marked of pts) {
              if (!marked.key || !marked.label || marked === b || marked.label === 'сейчас') continue
              captions.push({
                id: `story:${sc.id}:way:${marked.label}`,
                kind: 'way',
                text: marked.label,
                x: marked.x,
                y: marked.y,
                color,
              })
            }
          }
        }

        const captions: Array<{
          id: string
          kind: 'tip' | 'way' | 'spent'
          text: string
          x: number
          y: number
          color: string
        }> = []

        const lead =
          active ??
          [...rows].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] ??
          null
        const order = [...rows].sort((a, b) => {
          const ao = lead && a.id === lead.id ? 1 : 0
          const bo = lead && b.id === lead.id ? 1 : 0
          return ao - bo
        })
        const equal = !active && !lead
        for (const sc of order) {
          drawOne(sc, Boolean(lead && sc.id === lead.id), equal)
        }

        // Two scenarios usually point at the same level ("ломать вниз …").
        // Keep one tag per level so the chart doesn't repeat itself.
        const seenCaption = new Map<string, number>()
        const uniqueCaptions = captions.filter((c) => {
          // "ломает вниз 143.1 → стопы" and "ломает вниз 143.1" are the same idea.
          const key = c.text.split(/[·→—–]/)[0].replace(/\s+/g, ' ').trim().toLowerCase()
          const at = seenCaption.get(key)
          if (at == null) {
            seenCaption.set(key, captions.indexOf(c))
            return true
          }
          // Prefer the longer wording (it carries the "why").
          const prev = captions[at]
          if (prev && c.text.length > prev.text.length) {
            prev.text = c.text
          }
          return false
        })

        const requests: LabelRequest[] = uniqueCaptions.map((c) => ({
          id: c.id,
          priceY: c.y,
          text: c.text,
          priority: LABEL_PRIORITY.story,
          sourceLayer: 'story',
          height: c.kind === 'tip' ? 22 : 18,
        }))
        const placed = publishLabels(layout, 'story', fromListener, requests)
        for (const c of uniqueCaptions) {
          const y = labelAnchor(placed, c.id, c.y)
          if (y == null) continue
          if (c.kind === 'tip') {
            drawTipLabel(ctx, c.x, y, c.y, c.text, c.color, plotRight, h, compact)
          } else if (c.kind === 'way') {
            drawWaypointLabel(ctx, c.x, y, c.text, c.color, plotRight, h, compact)
          } else {
            drawSpentNote(ctx, c.x, y, plotRight, c.text, compact)
          }
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
        compactFuture ? 26 : 32,
        Math.max(compactFuture ? 16 : 18, future.bars + 4)
      )
      if (need > current) ts.applyOptions({ rightOffset: need })
    } catch {
      /* ignore */
    }

    const onLayout = () => {
      fromListenerRef.current = true
      try {
        redraw()
      } finally {
        fromListenerRef.current = false
      }
    }

    const unsub = watchLayer(layout, 'story', onLayout)
    redrawRef.current = redraw
    redraw()
    return () => {
      unsub()
      layout.clear('story')
      redrawRef.current = () => {}
    }
  }, [
    chart,
    series,
    containerRef,
    lastCandleTs,
    barSeconds,
    future,
    lastPrice,
    scenarios,
    activeId,
    layout,
  ])

  useViewportRedraw(
    chart,
    containerRef.current,
    () => redrawRef.current(),
    { interactingRef, crosshair: false }
  )

  if (!future) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[12] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

export default StoryPathOverlay
