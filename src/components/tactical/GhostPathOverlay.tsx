import { useEffect, useMemo, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { CoinSignal } from '../../engine/types'
import { calculateAtr } from '../../engine/smc'
import { buildGhostPath, sampleCubicBezier } from '../../engine/prediction/ghostPath'
import type { OhlcvCandle } from '../../api/mexc'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  signal: CoinSignal | null
  candles: OhlcvCandle[]
  containerRef: React.RefObject<HTMLDivElement>
  lastCandleTs: number
}

/**
 * Ghost Path — прогнозная траектория Безье entry → TP с ATR-реализмом.
 */
const GhostPathOverlay = ({
  chart,
  series,
  signal,
  candles,
  containerRef,
  lastCandleTs,
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const ghost = useMemo(() => {
    if (
      !signal?.direction ||
      signal.sl == null ||
      signal.tp1 == null ||
      signal.price <= 0
    ) {
      return null
    }

    const atr = calculateAtr(candles, 14) ?? signal.price * 0.005
    const dailyAtr = calculateAtr(candles.slice(-24), 14) ?? atr
    const style = signal.tradeStyle ?? 'INTRADAY'

    return buildGhostPath({
      entry: signal.ltfChoCH?.surgicalEntryPrice ?? signal.price,
      tp1: signal.tp1,
      tp2: signal.tp2,
      sl: signal.sl,
      direction: signal.direction,
      atr,
      dailyAtrPct: (dailyAtr / signal.price) * 100,
      style,
      candleTimeframeSeconds:
        style === 'SCALP' ? 60 : style === 'SWING' ? 14_400 : 900,
    })
  }, [
    signal?.direction,
    signal?.sl,
    signal?.tp1,
    signal?.tp2,
    signal?.price,
    signal?.tradeStyle,
    signal?.ltfChoCH?.surgicalEntryPrice,
    candles,
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !chart || !series || !ghost) return

    const redraw = () => {
      const W = container.clientWidth
      const H = container.clientHeight
      if (W <= 0 || H <= 0) return

      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      const timeScale = chart.timeScale()
      const samples = sampleCubicBezier(ghost.bezierControls, 40)
      const duration = ghost.expectedDurationSec

      const pts: Array<{ x: number; y: number }> = []
      for (const s of samples) {
        const ts = lastCandleTs + s.t * duration
        const x = timeScale.timeToCoordinate(ts as Time)
        const y = series.priceToCoordinate(s.price)
        if (x == null || y == null) continue
        pts.push({ x: x as number, y: y as number })
      }

      if (pts.length < 2) return

      const isLong = signal?.direction === 'LONG'
      const color = ghost.unrealisticTp
        ? '#f59e0b'
        : isLong
          ? '#22c55e'
          : '#ef4444'

      ctx.beginPath()
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = `${color}aa`
      ctx.lineWidth = 2
      pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y)
        else ctx.lineTo(p.x, p.y)
      })
      ctx.stroke()
      ctx.setLineDash([])

      // Ghost candle silhouettes along path
      for (let i = 1; i < pts.length; i += 3) {
        const p = pts[i]
        const prev = pts[i - 1]
        const bodyH = Math.max(4, Math.abs(p.y - prev.y) * 0.6)
        ctx.fillStyle = `${color}22`
        ctx.strokeStyle = `${color}55`
        ctx.lineWidth = 1
        ctx.fillRect(p.x - 3, Math.min(p.y, prev.y), 6, bodyH)
        ctx.strokeRect(p.x - 3, Math.min(p.y, prev.y), 6, bodyH)
      }

      if (ghost.warning) {
        ctx.font = '9px monospace'
        ctx.fillStyle = '#f59e0bcc'
        ctx.fillText('⚠ Нереалистичный TP → ATR-коррекция', 8, 14)
      }
    }

    redraw()
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw)
    const ro = new ResizeObserver(redraw)
    ro.observe(container)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw)
      ro.disconnect()
    }
  }, [chart, series, ghost, containerRef, lastCandleTs, signal?.direction])

  if (!ghost) return null

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 3 }}
    />
  )
}

export default GhostPathOverlay
