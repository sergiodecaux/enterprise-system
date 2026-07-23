import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { LiquidityZone } from '../../engine/indicators/types'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  zones: LiquidityZone[]
  containerRef: React.RefObject<HTMLDivElement>
  opacity: number
  showLabels: boolean
}

function getZoneColors(zone: LiquidityZone, opacity: number) {
  const op = opacity / 100

  switch (zone.type) {
    case 'ORDER_BLOCK':
      return zone.side === 'BULLISH'
        ? { bg: `rgba(34, 197, 94, ${op})`, border: 'rgba(34, 197, 94, 0.8)' }
        : { bg: `rgba(239, 68, 68, ${op})`, border: 'rgba(239, 68, 68, 0.8)' }
    case 'FVG':
      return zone.side === 'BULLISH'
        ? { bg: `rgba(59, 130, 246, ${op})`, border: 'rgba(59, 130, 246, 0.8)' }
        : { bg: `rgba(168, 85, 247, ${op})`, border: 'rgba(168, 85, 247, 0.8)' }
    case 'POC':
      return { bg: `rgba(249, 115, 22, ${op})`, border: 'rgba(249, 115, 22, 0.9)' }
    case 'VALUE_AREA':
      return {
        bg: `rgba(148, 163, 184, ${op * 0.5})`,
        border: 'rgba(148, 163, 184, 0.3)',
      }
    case 'OTE':
      return zone.side === 'BEARISH'
        ? { bg: `rgba(239, 68, 68, ${op * 0.7})`, border: 'rgba(239, 68, 68, 0.85)' }
        : { bg: `rgba(34, 197, 94, ${op * 0.75})`, border: 'rgba(34, 197, 94, 0.9)' }
    case 'FIBONACCI':
      return zone.side === 'BULLISH'
        ? { bg: `rgba(251, 191, 36, ${op * 0.55})`, border: 'rgba(251, 191, 36, 0.9)' }
        : { bg: `rgba(168, 85, 247, ${op * 0.5})`, border: 'rgba(168, 85, 247, 0.85)' }
    case 'SSL':
    case 'LIQ':
      return {
        bg: `rgba(16, 185, 129, ${op * 0.65})`,
        border: 'rgba(16, 185, 129, 0.95)',
      }
    case 'BSL':
      return {
        bg: `rgba(244, 63, 94, ${op * 0.65})`,
        border: 'rgba(244, 63, 94, 0.95)',
      }
    default:
      return { bg: `rgba(100, 200, 255, ${op})`, border: 'rgba(100, 200, 255, 0.6)' }
  }
}

const ChartOverlay = ({
  chart,
  series,
  zones,
  containerRef,
  opacity,
  showLabels,
}: Props) => {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!chart || !series || !overlayRef.current || !containerRef.current) return

    const overlay = overlayRef.current
    const timeScale = chart.timeScale()

    const redraw = () => {
      overlay.innerHTML = ''
      const containerWidth = containerRef.current!.clientWidth
      const containerHeight = containerRef.current!.clientHeight

      // До 8 зон — найденные SSL/BSL/Fib + OB/OTE
      const visibleZones = [...zones]
        .sort((a, b) => (b.strength ?? 5) - (a.strength ?? 5))
        .slice(0, 8)

      for (const zone of visibleZones) {
        const topY = series.priceToCoordinate(zone.top)
        const bottomY = series.priceToCoordinate(zone.bottom)
        const rawStartX = timeScale.timeToCoordinate(zone.startTime as Time)
        const endX = timeScale.timeToCoordinate(
          (zone.endTime ?? zone.startTime) as Time
        )

        // HTF fib start often predates visible chart range — clamp to left edge
        const startXNum = rawStartX == null ? 0 : Number(rawStartX)
        const endXNum = endX == null ? containerWidth : Number(endX)

        if (topY == null || bottomY == null) continue

        const height = Math.abs(Number(bottomY) - Number(topY))
        const yPos = Math.min(Number(topY), Number(bottomY))
        const width =
          endXNum > startXNum ? endXNum - startXNum : containerWidth - startXNum

        // Allow slightly off-screen Y so extension bands (141 above price) still peek
        if (height < 1 || yPos < -80 || yPos > containerHeight + 80) continue
        if (startXNum > containerWidth) continue

        const isFib141 =
          zone.type === 'FIBONACCI' &&
          ((zone.id ?? '').includes('141') || (zone.label ?? '').includes('141'))
        const fibOpacityBoost = zone.type === 'FIBONACCI' ? Math.max(opacity, 28) : opacity
        const colors = getZoneColors(zone, isFib141 ? Math.max(fibOpacityBoost, 40) : fibOpacityBoost)

        const div = document.createElement('div')
        div.style.cssText = `
          position: absolute;
          left: ${Math.max(0, startXNum)}px;
          top: ${yPos}px;
          width: ${Math.min(Math.max(width, 4), containerWidth - Math.max(0, startXNum))}px;
          height: ${Math.max(height, isFib141 ? 4 : 2)}px;
          background: ${colors.bg};
          border-top: 1px solid ${colors.border};
          border-bottom: 1px solid ${colors.border};
          pointer-events: none;
          box-sizing: border-box;
          overflow: hidden;
        `

        const forceLabel = isFib141 || (showLabels && zone.label)
        if (forceLabel && zone.label) {
          const label = document.createElement('span')
          label.textContent = isFib141
            ? zone.label.includes('◎')
              ? zone.label
              : `141 · ${zone.label}`
            : zone.label
          label.style.cssText = `
            position: absolute;
            right: 4px;
            top: 50%;
            transform: translateY(-50%);
            font-size: ${isFib141 ? '10px' : '9px'};
            font-family: monospace;
            font-weight: ${isFib141 ? '700' : '400'};
            color: ${isFib141 ? 'rgba(251, 191, 36, 0.95)' : colors.border};
            white-space: nowrap;
            opacity: 0.95;
            text-shadow: 0 0 4px rgba(0,0,0,0.8);
          `
          div.appendChild(label)
        }

        overlay.appendChild(div)
      }
    }

    redraw()

    const onVisible = () => redraw()
    timeScale.subscribeVisibleLogicalRangeChange(onVisible)
    chart.subscribeCrosshairMove(onVisible)

    const ro = new ResizeObserver(() => redraw())
    ro.observe(containerRef.current)

    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(onVisible)
      chart.unsubscribeCrosshairMove(onVisible)
      ro.disconnect()
      overlay.innerHTML = ''
    }
  }, [chart, series, zones, opacity, showLabels, containerRef])

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 1 }}
    />
  )
}

export default ChartOverlay
