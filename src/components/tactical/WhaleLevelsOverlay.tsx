import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { WhaleSitCluster } from '../../engine/orderbook/whaleSitLevels'
import { formatSitVolume } from '../../engine/orderbook/whaleSitLevels'
import {
  LABEL_PRIORITY,
  labelAnchor,
  labelShown,
  publishLabels,
  useChartLabels,
  watchLayer,
  type LabelRequest,
} from './chartLabels/LabelLayoutManager'

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
 * The "$…M" volume is a secondary caption and drops when it would cover BOS/Fib.
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
  const layout = useChartLabels()

  useEffect(() => {
    const overlay = overlayRef.current
    const live = clusters.filter((c) => !c.spent)
    if (!overlay || !chart || !series || !containerRef.current || !live.length) {
      if (overlay) overlay.innerHTML = ''
      layout.clear('whale')
      return
    }

    let fromListener = false

    const paint = () => {
      const box = containerRef.current
      if (!box) return
      const h = box.clientHeight
      overlay.innerHTML = ''

      const hunted = live.filter((c) => c.hunted)
      const extras = live
        .filter((c) => !c.hunted)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, 4 - hunted.length))
      const drawList = [...hunted, ...extras].slice(0, 4)

      const requests: LabelRequest[] = []
      const rows: {
        id: string
        volId: string
        vol: string
        rawY: number
        clipped: 'none' | 'top' | 'bottom'
        color: string
        soft: string
        isHunt: boolean
        shortLabel: string
        dist: string
        title: string
        lineY: number | null
      }[] = []

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
        const id = `whale:${side}:${price}`
        const volId = `${id}:vol`

        let rawY: number
        let clipped: 'none' | 'top' | 'bottom' = 'none'
        let lineY: number | null = null
        if (yCoord == null || Number.isNaN(Number(yCoord))) {
          clipped = isLong ? 'bottom' : 'top'
          rawY = isLong ? h - 22 : 22
        } else {
          const raw = Number(yCoord)
          if (raw < 8) {
            clipped = 'top'
            rawY = 18
          } else if (raw > h - 8) {
            clipped = 'bottom'
            rawY = h - 18
          } else {
            rawY = raw
            lineY = raw
          }
        }

        const edgeHint = clipped === 'top' ? ' ↑' : clipped === 'bottom' ? ' ↓' : ''
        requests.push({
          id,
          priceY: rawY,
          text: `${shortLabel}${edgeHint} ${dist}`,
          priority: LABEL_PRIORITY.whale,
          sourceLayer: 'whale',
          height: 20,
        })
        if (vol) {
          requests.push({
            id: volId,
            priceY: rawY,
            text: vol,
            priority: LABEL_PRIORITY.secondary,
            sourceLayer: 'whale',
            height: 14,
            attachTo: id,
          })
        }
        rows.push({
          id,
          volId,
          vol,
          rawY,
          clipped,
          color,
          soft,
          isHunt,
          shortLabel,
          dist,
          title: `${cluster.label} · ${sourceNote} · ${fmtPrice(price)}`,
          lineY,
        })
      }

      const placed = publishLabels(layout, 'whale', fromListener, requests)

      for (const row of rows) {
        const y = labelAnchor(placed, row.id, row.rawY)
        const showVol = row.vol !== '' && labelShown(placed, row.volId)
        if (row.lineY != null) {
          const line = document.createElement('div')
          line.style.cssText = `
            position: absolute;
            left: 58%;
            right: 52px;
            top: ${row.lineY}px;
            height: 0;
            border-top: ${row.isHunt ? '1.5px' : '1px'} dashed ${row.color};
            opacity: ${row.isHunt ? 0.9 : 0.45};
            pointer-events: none;
            z-index: 1;
          `
          overlay.appendChild(line)

          if (row.isHunt) {
            const band = document.createElement('div')
            band.style.cssText = `
              position: absolute;
              left: 70%;
              right: 52px;
              top: ${row.lineY - 4}px;
              height: 8px;
              background: linear-gradient(90deg, transparent 0%, ${row.soft} 100%);
              pointer-events: none;
              z-index: 0;
            `
            overlay.appendChild(band)
          }
        }

        if (y == null) continue
        const edgeHint =
          row.clipped === 'top' ? ' ↑' : row.clipped === 'bottom' ? ' ↓' : ''
        const badge = document.createElement('div')
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
            border: 1px solid ${row.color};
            background: rgba(8, 10, 14, 0.86);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            white-space: nowrap;
            ${row.isHunt ? `box-shadow: 0 0 8px ${row.color};` : ''}
          " title="${row.title}">
            <span style="
              width: 5px; height: 5px; border-radius: 99px;
              background: ${row.color}; flex-shrink: 0;
            "></span>
            <span style="font-size: 9px; font-weight: 700; letter-spacing: 0.03em; color: ${row.color};">
              ${row.shortLabel}${edgeHint}
            </span>
            ${
              showVol
                ? `<span style="font-size: 9px; font-weight: 700; color: rgba(240,245,250,0.9);">${row.vol}</span>`
                : ''
            }
            <span style="font-size: 8px; color: rgba(200,210,220,0.5);">${row.dist}</span>
          </div>
        `
        overlay.appendChild(badge)
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
    const unsub = watchLayer(layout, 'whale', onLayout)
    chart.timeScale().subscribeVisibleLogicalRangeChange(paint)
    chart.subscribeCrosshairMove(paint)
    const ro = new ResizeObserver(() => paint())
    ro.observe(containerRef.current)

    return () => {
      unsub()
      layout.clear('whale')
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(paint)
      chart.unsubscribeCrosshairMove(paint)
      ro.disconnect()
      overlay.innerHTML = ''
    }
  }, [chart, series, containerRef, clusters, priceFloor, priceCeil, layout])

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
