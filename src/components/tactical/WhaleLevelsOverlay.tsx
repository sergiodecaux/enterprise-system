import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { WhaleSitCluster } from '../../engine/orderbook/whaleSitLevels'
import { formatSitVolume } from '../../engine/orderbook/whaleSitLevels'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  clusters: WhaleSitCluster[]
  /** Visible candle price span — skip drawing if level is absurdly far */
  priceFloor?: number
  priceCeil?: number
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

/**
 * Right-edge sit marks — no essay over candles.
 * Hunted = nearest unused cluster above/below.
 */
const WhaleLevelsOverlay = ({
  chart,
  series,
  containerRef,
  clusters,
  priceFloor,
  priceCeil,
}: Props) => {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    const live = clusters.filter((c) => !c.spent)
    if (!overlay || !chart || !series || !containerRef.current || !live.length) {
      if (overlay) overlay.innerHTML = ''
      return
    }

    const redraw = () => {
      const box = containerRef.current
      if (!box) return
      const h = box.clientHeight
      overlay.innerHTML = ''

      const usedY: number[] = []
      const placeY = (raw: number): number => {
        let y = Math.max(16, Math.min(h - 18, raw))
        for (let i = 0; i < 6; i++) {
          const clash = usedY.some((u) => Math.abs(u - y) < 22)
          if (!clash) break
          y = Math.min(h - 18, y + 22)
        }
        usedY.push(y)
        return y
      }

      const hunted = live.filter((c) => c.hunted)
      const extras = live
        .filter((c) => !c.hunted)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, 4 - hunted.length))
      const drawList = [...hunted, ...extras].slice(0, 4)

      for (const cluster of drawList) {
        const { price, side, shortLabel, sourceNote, volumeUsd, distancePct, hunted: isHunt } =
          cluster
        if (
          priceFloor != null &&
          priceCeil != null &&
          priceFloor > 0 &&
          (price < priceFloor * 0.85 || price > priceCeil * 1.15)
        ) {
          continue
        }

        const yCoord = (() => {
          try {
            return series.priceToCoordinate(price)
          } catch {
            return null
          }
        })()
        const isLong = side === 'LONG'
        const color = isLong
          ? 'rgba(52, 211, 153, 0.94)'
          : 'rgba(251, 146, 60, 0.94)'
        const soft = isLong
          ? 'rgba(52, 211, 153, 0.16)'
          : 'rgba(251, 146, 60, 0.16)'
        const vol = volumeUsd >= 250_000 ? formatSitVolume(volumeUsd) : ''
        const dist = `${isLong ? '↓' : '↑'}${distancePct.toFixed(2)}%`

        let y: number
        let clipped: 'none' | 'top' | 'bottom' = 'none'
        if (yCoord == null || Number.isNaN(Number(yCoord))) {
          clipped = isLong ? 'bottom' : 'top'
          y = placeY(isLong ? h - 22 : 22)
        } else {
          const raw = Number(yCoord)
          if (raw < 8) {
            clipped = 'top'
            y = placeY(18)
          } else if (raw > h - 8) {
            clipped = 'bottom'
            y = placeY(h - 18)
          } else {
            y = placeY(raw)
          }
        }

        if (clipped === 'none') {
          const line = document.createElement('div')
          line.style.cssText = `
            position: absolute;
            left: 58%;
            right: 52px;
            top: ${y}px;
            height: 0;
            border-top: ${isHunt ? '1.5px' : '1px'} dashed ${color};
            opacity: ${isHunt ? 0.9 : 0.45};
            pointer-events: none;
            z-index: 1;
          `
          overlay.appendChild(line)

          if (isHunt) {
            const band = document.createElement('div')
            band.style.cssText = `
              position: absolute;
              left: 70%;
              right: 52px;
              top: ${y - 4}px;
              height: 8px;
              background: linear-gradient(90deg, transparent 0%, ${soft} 100%);
              pointer-events: none;
              z-index: 0;
            `
            overlay.appendChild(band)
          }
        }

        const badge = document.createElement('div')
        const edgeHint =
          clipped === 'top' ? ' ↑' : clipped === 'bottom' ? ' ↓' : ''
        badge.style.cssText = `
          position: absolute;
          right: 4px;
          top: ${y - 10}px;
          z-index: 4;
          pointer-events: none;
        `
        badge.innerHTML = `
          <div style="
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 6px;
            border-radius: 5px;
            border: 1px solid ${color};
            background: rgba(8, 10, 14, 0.86);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            white-space: nowrap;
            ${isHunt ? `box-shadow: 0 0 8px ${color};` : ''}
          " title="${cluster.label} · ${sourceNote} · ${fmtPrice(price)}">
            <span style="
              width: 5px; height: 5px; border-radius: 99px;
              background: ${color}; flex-shrink: 0;
            "></span>
            <span style="font-size: 9px; font-weight: 700; letter-spacing: 0.03em; color: ${color};">
              ${shortLabel}${edgeHint}
            </span>
            ${
              vol
                ? `<span style="font-size: 9px; font-weight: 700; color: rgba(240,245,250,0.9);">${vol}</span>`
                : ''
            }
            <span style="font-size: 8px; color: rgba(200,210,220,0.5);">${dist}</span>
          </div>
        `
        overlay.appendChild(badge)
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
  }, [chart, series, containerRef, clusters, priceFloor, priceCeil])

  if (!clusters.some((c) => !c.spent)) return null

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
      aria-hidden
    />
  )
}

export default WhaleLevelsOverlay
