/**
 * Smooth (Catmull-Rom) flight paths — not straight polylines.
 * Maps future offsets via logical coordinates so arrows render past the last candle.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts'
import type { PathPoint } from '../../engine/prediction/types'

export interface CurvePath {
  id: string
  points: PathPoint[]
  color: string
  label: string
  emphasis: boolean
}

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  lastLogicalIndex: number
  barSeconds: number
  paths: CurvePath[]
}

function catmullToBezier(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }
  return d
}

function arrowPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  size = 8
): string {
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const a1 = ang - Math.PI / 7
  const a2 = ang + Math.PI / 7
  const x1 = to.x - size * Math.cos(a1)
  const y1 = to.y - size * Math.sin(a1)
  const x2 = to.x - size * Math.cos(a2)
  const y2 = to.y - size * Math.sin(a2)
  return `M ${to.x} ${to.y} L ${x1} ${y1} L ${x2} ${y2} Z`
}

const CurvePathOverlay = ({
  chart,
  series,
  containerRef,
  lastLogicalIndex,
  barSeconds,
  paths,
}: Props) => {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!chart || !series || !svgRef.current || !containerRef.current) return
    const svg = svgRef.current
    const timeScale = chart.timeScale()
    const bar = Math.max(1, barSeconds)

    const maxBars = Math.max(
      0,
      ...paths.flatMap((p) => p.points.map((pt) => pt.timeOffsetSeconds / bar))
    )
    const extra = Math.min(40, Math.ceil(maxBars) + 6)
    try {
      const current = timeScale.options().rightOffset ?? 8
      if (extra > current + 1) timeScale.applyOptions({ rightOffset: extra })
    } catch {
      /* ignore */
    }

    const redraw = () => {
      const w = containerRef.current!.clientWidth
      const h = containerRef.current!.clientHeight
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
      svg.setAttribute('width', String(w))
      svg.setAttribute('height', String(h))
      svg.innerHTML = ''
      if (lastLogicalIndex < 0 || !paths.length) return
      let priceScaleW = 56
      try {
        const pw = chart.priceScale('right').width()
        if (typeof pw === 'number' && pw > 8) priceScaleW = pw
      } catch {
        /* ignore */
      }
      const plotRight = Math.max(40, w - priceScaleW - 2)

      for (const path of paths) {
        if (path.points.length < 2) continue
        const coords: { x: number; y: number }[] = []
        for (const p of path.points) {
          const logical = (lastLogicalIndex +
            p.timeOffsetSeconds / bar) as Logical
          const x = timeScale.logicalToCoordinate(logical)
          const y = series.priceToCoordinate(p.price)
          if (x == null || y == null) continue
          coords.push({ x: Number(x), y: Number(y) })
        }
        if (coords.length < 2) continue

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        stroke.setAttribute('d', catmullToBezier(coords))
        stroke.setAttribute('fill', 'none')
        stroke.setAttribute('stroke', path.color)
        stroke.setAttribute('stroke-width', path.emphasis ? '2.4' : '1.5')
        stroke.setAttribute('stroke-linecap', 'round')
        stroke.setAttribute('stroke-linejoin', 'round')
        stroke.setAttribute('opacity', path.emphasis ? '0.95' : '0.55')
        if (!path.emphasis) stroke.setAttribute('stroke-dasharray', '5 4')
        g.appendChild(stroke)

        const last = coords[coords.length - 1]
        const prev = coords[coords.length - 2]
        const head = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        head.setAttribute('d', arrowPoints(prev, last, path.emphasis ? 9 : 7))
        head.setAttribute('fill', path.color)
        head.setAttribute('opacity', path.emphasis ? '0.95' : '0.55')
        g.appendChild(head)

        const mid = coords[Math.floor(coords.length * 0.55)]
        if (mid && path.label) {
          const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          const tx = Math.min(mid.x + 6, plotRight - 28)
          text.setAttribute('x', String(tx))
          text.setAttribute('y', String(mid.y - 6))
          text.setAttribute('fill', path.color)
          text.setAttribute('font-size', '10')
          text.setAttribute('font-family', 'ui-monospace, Menlo, monospace')
          text.setAttribute('font-weight', '700')
          text.textContent = path.label
          g.appendChild(text)
        }
        svg.appendChild(g)
      }
    }

    redraw()
    const raf = window.requestAnimationFrame(redraw)
    const onVis = () => redraw()
    timeScale.subscribeVisibleLogicalRangeChange(onVis)
    chart.subscribeCrosshairMove(onVis)
    const ro = new ResizeObserver(() => redraw())
    ro.observe(containerRef.current)
    return () => {
      window.cancelAnimationFrame(raf)
      timeScale.unsubscribeVisibleLogicalRangeChange(onVis)
      chart.unsubscribeCrosshairMove(onVis)
      ro.disconnect()
      svg.innerHTML = ''
    }
  }, [chart, series, containerRef, lastLogicalIndex, barSeconds, paths])

  if (!paths.length) return null
  return (
    <svg
      ref={svgRef}
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 6 }}
    />
  )
}

export default CurvePathOverlay
