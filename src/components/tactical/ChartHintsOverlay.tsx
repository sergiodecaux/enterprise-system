import { useEffect, useMemo, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import {
  buildChartHints,
  type ChartHint,
} from '../../engine/sequence/buildChartHints'
import type { SequenceHit } from '../../engine/sequence'
import type { MarketRegime } from '../../engine/regime/marketRegime'
import type { WhaleWatcherState } from '../../engine/types'
import type { LiveSignalResult } from '../../engine/trades/findLiveSignal'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  visible: boolean
  symbol: string
  price: number
  regime: MarketRegime
  sequence: SequenceHit | null
  whale: WhaleWatcherState | null
  liveSignal: LiveSignalResult | null
  bookImbalance: number | null
  /** Recompute when process updates */
  refreshKey?: number
}

/**
 * Remizov coach bubbles on the chart — toggleable.
 */
const ChartHintsOverlay = ({
  chart,
  series,
  containerRef,
  visible,
  symbol,
  price,
  regime,
  sequence,
  whale,
  liveSignal,
  bookImbalance,
  refreshKey = 0,
}: Props) => {
  const overlayRef = useRef<HTMLDivElement>(null)

  const hints = useMemo(
    () =>
      visible
        ? buildChartHints({
            symbol,
            price,
            regime,
            sequence,
            whale,
            liveSignal,
            bookImbalance,
          })
        : [],
    [
      visible,
      symbol,
      price,
      regime,
      sequence,
      whale,
      liveSignal,
      bookImbalance,
      refreshKey,
    ]
  )

  useEffect(() => {
    const overlay = overlayRef.current
    if (
      !visible ||
      !overlay ||
      !chart ||
      !series ||
      !containerRef.current ||
      !hints.length
    ) {
      if (overlay) overlay.innerHTML = ''
      return
    }

    const redraw = () => {
      const box = containerRef.current
      if (!box) return
      const h = box.clientHeight
      const w = box.clientWidth
      overlay.innerHTML = ''

      const usedY: number[] = []
      const placeY = (raw: number): number => {
        let y = Math.max(28, Math.min(h - 36, raw))
        for (let i = 0; i < 8; i++) {
          if (!usedY.some((u) => Math.abs(u - y) < 52)) break
          y = Math.min(h - 36, y + 52)
        }
        usedY.push(y)
        return y
      }

      // Price-anchored first, then floating INFO
      const ordered = [...hints].sort((a, b) => {
        const ap = a.price != null ? 0 : 1
        const bp = b.price != null ? 0 : 1
        if (ap !== bp) return ap - bp
        return b.priority - a.priority
      })

      let floatIdx = 0
      for (const hint of ordered) {
        let y: number
        if (hint.price != null && hint.price > 0) {
          const yCoord = series.priceToCoordinate(hint.price)
          if (yCoord == null || Number.isNaN(Number(yCoord))) {
            y = placeY(40 + floatIdx * 56)
            floatIdx++
          } else {
            y = placeY(Number(yCoord))
          }
        } else {
          y = placeY(32 + floatIdx * 56)
          floatIdx++
        }

        const colors = palette(hint.side)
        const card = document.createElement('div')
        // Left side — doesn't fight whale badges on the right
        const maxW = Math.min(200, Math.floor(w * 0.46))
        card.style.cssText = `
          position: absolute;
          left: 6px;
          top: ${y - 22}px;
          z-index: 7;
          max-width: ${maxW}px;
          pointer-events: none;
          padding: 5px 8px;
          border-radius: 8px;
          border: 1px solid ${colors.border};
          background: rgba(6, 8, 12, 0.88);
          backdrop-filter: blur(8px);
          box-shadow: 0 2px 12px rgba(0,0,0,0.45);
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        `
        card.innerHTML = `
          <div style="display:flex;align-items:center;gap:5px;margin-bottom:2px;">
            <span style="width:5px;height:5px;border-radius:99px;background:${colors.dot};flex-shrink:0;"></span>
            <span style="font-size:9px;font-weight:800;letter-spacing:0.03em;color:${colors.title};">
              ${escapeHtml(hint.title)}
            </span>
          </div>
          <div style="font-size:8px;line-height:1.35;color:rgba(210,220,230,0.62);">
            ${escapeHtml(hint.body)}
          </div>
        `
        overlay.appendChild(card)

        // Connector tick to price when anchored
        if (hint.price != null) {
          const tick = document.createElement('div')
          tick.style.cssText = `
            position: absolute;
            left: ${maxW + 6}px;
            top: ${y}px;
            width: ${Math.max(12, w * 0.08)}px;
            height: 0;
            border-top: 1px dashed ${colors.border};
            opacity: 0.55;
            pointer-events: none;
            z-index: 6;
          `
          overlay.appendChild(tick)
        }
      }
    }

    redraw()
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw)
    chart.subscribeCrosshairMove(redraw)
    const ro = new ResizeObserver(() => redraw())
    ro.observe(containerRef.current)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw)
      chart.unsubscribeCrosshairMove(redraw)
      ro.disconnect()
      overlay.innerHTML = ''
    }
  }, [visible, chart, series, containerRef, hints])

  if (!visible) return null

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 z-[7] overflow-hidden"
      aria-hidden
    />
  )
}

function palette(side: ChartHint['side']): {
  border: string
  title: string
  dot: string
} {
  if (side === 'LONG') {
    return {
      border: 'rgba(34, 211, 238, 0.45)',
      title: 'rgba(103, 232, 249, 0.95)',
      dot: 'rgba(34, 211, 238, 0.95)',
    }
  }
  if (side === 'SHORT') {
    return {
      border: 'rgba(251, 146, 60, 0.45)',
      title: 'rgba(253, 186, 116, 0.95)',
      dot: 'rgba(251, 146, 60, 0.95)',
    }
  }
  return {
    border: 'rgba(148, 163, 184, 0.35)',
    title: 'rgba(203, 213, 225, 0.9)',
    dot: 'rgba(148, 163, 184, 0.85)',
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export default ChartHintsOverlay
