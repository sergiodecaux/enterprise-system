import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { WhaleOrder, WhaleWatcherState } from '../../engine/types'
import { formatWhaleVolume } from '../../engine/orderbook/whaleDetector'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  whaleState: WhaleWatcherState | null
  /** Visible candle price span — skip drawing if level is absurdly far */
  priceFloor?: number
  priceCeil?: number
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

type LevelKind = 'BID' | 'ASK'

/**
 * Киты на графике без createPriceLine — не растягивают шкалу и не «висят» внизу.
 * Линия + бейдж у правого края; если уровень вне viewport — пилюля у края.
 */
const WhaleLevelsOverlay = ({
  chart,
  series,
  containerRef,
  whaleState,
  priceFloor,
  priceCeil,
}: Props) => {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || !chart || !series || !containerRef.current || !whaleState) {
      if (overlay) overlay.innerHTML = ''
      return
    }

    const levels: Array<{ order: WhaleOrder; kind: LevelKind }> = []
    if (whaleState.strongestSupport) {
      levels.push({ order: whaleState.strongestSupport, kind: 'BID' })
    }
    if (whaleState.strongestResistance) {
      levels.push({ order: whaleState.strongestResistance, kind: 'ASK' })
    }
    if (!levels.length) {
      overlay.innerHTML = ''
      return
    }

    const redraw = () => {
      const box = containerRef.current
      if (!box) return
      const h = box.clientHeight
      overlay.innerHTML = ''

      // Avoid stacking two badges on the same Y
      const usedY: number[] = []
      const placeY = (raw: number): number => {
        let y = Math.max(18, Math.min(h - 22, raw))
        for (let i = 0; i < 6; i++) {
          const clash = usedY.some((u) => Math.abs(u - y) < 26)
          if (!clash) break
          y = Math.min(h - 22, y + 26)
        }
        usedY.push(y)
        return y
      }

      for (const { order, kind } of levels) {
        const { price, volumeUsd, distancePct } = order
        // Skip if wildly outside candle range (stale / book glitch)
        if (
          priceFloor != null &&
          priceCeil != null &&
          priceFloor > 0 &&
          (price < priceFloor * 0.85 || price > priceCeil * 1.15)
        ) {
          continue
        }

        const yCoord = series.priceToCoordinate(price)
        const isBid = kind === 'BID'
        const color = isBid
          ? 'rgba(34, 211, 238, 0.92)'
          : 'rgba(251, 146, 60, 0.92)'
        const soft = isBid
          ? 'rgba(34, 211, 238, 0.18)'
          : 'rgba(251, 146, 60, 0.18)'
        // Без BID/ASK: опора = крупные покупают лимиткой снизу, крыша = продают сверху
        const label = isBid ? 'ОПОРА' : 'КРЫША'
        const meaning = isBid
          ? 'крупные хотят купить · стена снизу'
          : 'крупные хотят продать · стена сверху'
        const vol = formatWhaleVolume(volumeUsd)
        const dist = `${isBid ? 'ниже' : 'выше'} ${distancePct.toFixed(2)}%`

        let y: number
        let clipped: 'none' | 'top' | 'bottom' = 'none'
        if (yCoord == null || Number.isNaN(Number(yCoord))) {
          // Off-scale: pin to edge matching side
          clipped = isBid ? 'bottom' : 'top'
          y = placeY(isBid ? h - 28 : 28)
        } else {
          const raw = Number(yCoord)
          if (raw < 8) {
            clipped = 'top'
            y = placeY(22)
          } else if (raw > h - 8) {
            clipped = 'bottom'
            y = placeY(h - 22)
          } else {
            y = placeY(raw)
          }
        }

        // Horizontal guide (only when level is in view)
        if (clipped === 'none') {
          const line = document.createElement('div')
          line.style.cssText = `
            position: absolute;
            left: 0;
            right: 52px;
            top: ${y}px;
            height: 0;
            border-top: 1.5px dashed ${color};
            opacity: 0.85;
            pointer-events: none;
            z-index: 1;
          `
          overlay.appendChild(line)

          // Soft glow band
          const band = document.createElement('div')
          band.style.cssText = `
            position: absolute;
            left: 0;
            right: 52px;
            top: ${y - 5}px;
            height: 10px;
            background: linear-gradient(90deg, transparent 0%, ${soft} 40%, ${soft} 100%);
            pointer-events: none;
            z-index: 0;
          `
          overlay.appendChild(band)
        }

        const badge = document.createElement('div')
        const edgeHint =
          clipped === 'top' ? ' ↑' : clipped === 'bottom' ? ' ↓' : ''
        badge.style.cssText = `
          position: absolute;
          right: 4px;
          top: ${y - 14}px;
          z-index: 4;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 1px;
          max-width: 46%;
          pointer-events: none;
        `
        badge.innerHTML = `
          <div style="
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 3px 7px;
            border-radius: 6px;
            border: 1px solid ${color};
            background: rgba(8, 10, 14, 0.88);
            backdrop-filter: blur(6px);
            box-shadow: 0 2px 10px rgba(0,0,0,0.45);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            white-space: nowrap;
          ">
            <span style="
              width: 6px; height: 6px; border-radius: 99px;
              background: ${color}; flex-shrink: 0;
              ${distancePct <= 1 ? 'box-shadow: 0 0 6px ' + color + ';' : ''}
            "></span>
            <span style="font-size: 9px; font-weight: 700; letter-spacing: 0.04em; color: ${color};">
              ${label}${edgeHint}
            </span>
            <span style="font-size: 10px; font-weight: 700; color: rgba(240,245,250,0.92);">
              ${vol}
            </span>
            <span style="font-size: 9px; color: rgba(200,210,220,0.55);">
              ${dist}
            </span>
          </div>
          <div style="
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 8px;
            color: rgba(200,210,220,0.5);
            padding-right: 2px;
            text-align: right;
          ">${meaning} · ${fmtPrice(price)}</div>
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
  }, [chart, series, containerRef, whaleState, priceFloor, priceCeil])

  if (
    !whaleState?.strongestSupport &&
    !whaleState?.strongestResistance
  ) {
    return null
  }

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
      aria-hidden
    />
  )
}

export default WhaleLevelsOverlay
