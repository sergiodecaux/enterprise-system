import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { EntryCluster, LiqHeatmapModel } from '../../engine/derivatives/liqHeatmap'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  model: LiqHeatmapModel | null
  visible: boolean
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
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
  const radius = Math.min(r, h / 2, w / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/**
 * On-chart map: green = where longs were taken, red = shorts.
 * Right strip = estimated liquidation density.
 */
const LiqHeatmapOverlay = ({
  chart,
  series,
  containerRef,
  model,
  visible,
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const labels = labelsRef.current
    const box = containerRef.current
    if (!canvas || !chart || !series || !box || !model || !visible) {
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx?.clearRect(0, 0, canvas.width, canvas.height)
      }
      if (labels) labels.innerHTML = ''
      return
    }

    const redraw = () => {
      const host = containerRef.current
      if (!host) return
      const w = host.clientWidth
      const h = host.clientHeight
      if (w < 80 || h < 40) return

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const leftW = Math.min(78, Math.max(52, w * 0.14))
      const rightW = Math.min(70, Math.max(48, w * 0.13))
      const maxLong = model.maxLongEntry
      const maxShort = model.maxShortEntry
      const maxLiq = model.maxLiq

      for (const bin of model.bins) {
        const yTop = series.priceToCoordinate(bin.priceHigh)
        const yBot = series.priceToCoordinate(bin.priceLow)
        if (yTop == null || yBot == null) continue
        const top = Number(yTop)
        const bot = Number(yBot)
        if (!Number.isFinite(top) || !Number.isFinite(bot)) continue
        const y = Math.min(top, bot)
        const bh = Math.max(1.2, Math.abs(bot - top))
        if (y > h + 6 || y + bh < -6) continue

        const longN = maxLong > 0 ? bin.longEntry / maxLong : 0
        const shortN = maxShort > 0 ? bin.shortEntry / maxShort : 0
        const heat = Math.max(longN, shortN)

        if (heat > 0.08) {
          const band = ctx.createLinearGradient(leftW, y, w - rightW, y)
          if (longN >= shortN) {
            band.addColorStop(0, `rgba(16, 185, 129, ${0.04 + heat * 0.2})`)
            band.addColorStop(0.55, `rgba(16, 185, 129, ${0.02 + heat * 0.1})`)
            band.addColorStop(1, 'rgba(16, 185, 129, 0)')
          } else {
            band.addColorStop(0, `rgba(244, 63, 94, ${0.04 + heat * 0.2})`)
            band.addColorStop(0.55, `rgba(244, 63, 94, ${0.02 + heat * 0.1})`)
            band.addColorStop(1, 'rgba(244, 63, 94, 0)')
          }
          ctx.fillStyle = band
          ctx.fillRect(leftW, y, w - rightW - leftW, bh)
        }

        const barH = Math.max(1.5, bh - 0.6)
        if (longN > 0.05) {
          const bw = longN * (leftW - 10)
          const grad = ctx.createLinearGradient(4, y, 4 + bw, y)
          grad.addColorStop(0, 'rgba(16, 185, 129, 0.15)')
          grad.addColorStop(1, 'rgba(52, 211, 153, 0.92)')
          ctx.fillStyle = grad
          ctx.shadowColor = 'rgba(16, 185, 129, 0.55)'
          ctx.shadowBlur = 6
          roundRect(ctx, 4, y + 0.3, bw, barH * 0.72, 3)
          ctx.fill()
          ctx.shadowBlur = 0
        }
        if (shortN > 0.05) {
          const bw = shortN * (leftW - 10)
          const grad = ctx.createLinearGradient(4, y, 4 + bw, y)
          grad.addColorStop(0, 'rgba(244, 63, 94, 0.12)')
          grad.addColorStop(1, 'rgba(251, 113, 133, 0.9)')
          ctx.fillStyle = grad
          ctx.shadowColor = 'rgba(244, 63, 94, 0.45)'
          ctx.shadowBlur = 5
          const yOff = longN > 0.05 ? barH * 0.42 : 0.3
          roundRect(ctx, 4, y + yOff, bw, barH * 0.55, 3)
          ctx.fill()
          ctx.shadowBlur = 0
        }

        if (maxLiq > 0) {
          const liqL = bin.longLiq / maxLiq
          const liqS = bin.shortLiq / maxLiq
          if (liqS > 0.06) {
            const bw = liqS * (rightW - 8)
            const grad = ctx.createLinearGradient(w - 4 - bw, y, w - 4, y)
            grad.addColorStop(0, 'rgba(251, 191, 36, 0.05)')
            grad.addColorStop(1, 'rgba(251, 146, 60, 0.88)')
            ctx.fillStyle = grad
            roundRect(ctx, w - 4 - bw, y + 0.2, bw, barH * 0.9, 2)
            ctx.fill()
          }
          if (liqL > 0.06) {
            const bw = liqL * (rightW - 8)
            const grad = ctx.createLinearGradient(w - 4 - bw, y, w - 4, y)
            grad.addColorStop(0, 'rgba(34, 211, 238, 0.05)')
            grad.addColorStop(1, 'rgba(34, 211, 238, 0.8)')
            ctx.globalAlpha = 0.85
            ctx.fillStyle = grad
            roundRect(ctx, w - 4 - bw, y + 0.2, bw, barH * 0.9, 2)
            ctx.fill()
            ctx.globalAlpha = 1
          }
        }
      }

      const yPx = series.priceToCoordinate(model.currentPrice)
      if (yPx != null && Number.isFinite(Number(yPx))) {
        const y = Number(yPx)
        ctx.strokeStyle = 'rgba(255,255,255,0.28)'
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(2, y)
        ctx.lineTo(leftW - 2, y)
        ctx.moveTo(w - rightW + 2, y)
        ctx.lineTo(w - 2, y)
        ctx.stroke()
        ctx.setLineDash([])
      }

      if (labels) {
        labels.innerHTML = ''
        const usedY: number[] = []
        const place = (raw: number) => {
          let y = Math.max(16, Math.min(h - 18, raw))
          for (let i = 0; i < 5; i++) {
            if (!usedY.some((u) => Math.abs(u - y) < 22)) break
            y = Math.min(h - 18, y + 22)
          }
          usedY.push(y)
          return y
        }
        const addPill = (cluster: EntryCluster, x: number) => {
          const yCoord = series.priceToCoordinate(cluster.price)
          if (yCoord == null) return
          const y = place(Number(yCoord))
          const isLong = cluster.side === 'LONG'
          const color = isLong ? '#34d399' : '#fb7185'
          const bg = isLong ? 'rgba(6, 40, 28, 0.88)' : 'rgba(48, 12, 22, 0.88)'
          const pill = document.createElement('div')
          pill.style.cssText = [
            'position:absolute',
            `left:${x}px`,
            `top:${y - 11}px`,
            'z-index:2',
            'display:flex',
            'align-items:center',
            'gap:5px',
            'padding:2px 7px',
            'border-radius:999px',
            `border:1px solid ${color}99`,
            `background:${bg}`,
            'backdrop-filter:blur(8px)',
            'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
            'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
            'white-space:nowrap',
            'pointer-events:none',
          ].join(';')
          pill.innerHTML = `<span style="width:6px;height:6px;border-radius:99px;background:${color};box-shadow:0 0 6px ${color}"></span>
            <span style="font-size:9px;font-weight:700;letter-spacing:0.06em;color:${color}">${isLong ? 'ЛОНГ' : 'ШОРТ'}</span>
            <span style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.9)">${fmtPx(cluster.price)}</span>`
          labels.appendChild(pill)
        }
        for (const c of model.longClusters) addPill(c, 8)
        for (const c of model.shortClusters) addPill(c, Math.max(8, leftW + 6))
      }
    }

    redraw()
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw)
    chart.subscribeCrosshairMove(redraw)
    const ro = new ResizeObserver(() => redraw())
    ro.observe(box)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw)
      chart.unsubscribeCrosshairMove(redraw)
      ro.disconnect()
    }
  }, [chart, series, containerRef, model, visible])

  if (!visible) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[11] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div ref={labelsRef} className="absolute inset-0" />
      {model && (
        <div className="absolute right-12 top-9 z-[12] flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-white/70 backdrop-blur-md">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
            лонг
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400 shadow-[0_0_6px_#fb7185]" />
            шорт
          </span>
          <span className="text-white/25">·</span>
          <span className="inline-flex items-center gap-1 text-orange-300/80">
            <span className="h-1.5 w-3 rounded-sm bg-gradient-to-l from-orange-400 to-cyan-400" />
            liq
          </span>
        </div>
      )}
    </div>
  )
}

export default LiqHeatmapOverlay
