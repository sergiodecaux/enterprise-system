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

      // Максимум 6 самых сильных зон — меньше визуального шума
      const visibleZones = [...zones]
        .sort((a, b) => (b.strength ?? 5) - (a.strength ?? 5))
        .slice(0, 6)

      for (const zone of visibleZones) {
        const colors = getZoneColors(zone, opacity)
        const topY = series.priceToCoordinate(zone.top)
        const bottomY = series.priceToCoordinate(zone.bottom)
        const startX = timeScale.timeToCoordinate(zone.startTime as Time)
        const endX = timeScale.timeToCoordinate(
          (zone.endTime ?? zone.startTime) as Time
        )

        if (topY == null || bottomY == null || startX == null) continue

        const height = Math.abs(bottomY - topY)
        const yPos = Math.min(topY, bottomY)
        const resolvedEndX = endX ?? containerWidth
        const width =
          resolvedEndX > startX ? resolvedEndX - startX : containerWidth - startX

        if (height < 1 || yPos < -20 || yPos > containerHeight + 20) continue
        if (startX > containerWidth) continue

        const div = document.createElement('div')
        div.style.cssText = `
          position: absolute;
          left: ${Math.max(0, startX)}px;
          top: ${yPos}px;
          width: ${Math.min(Math.max(width, 4), containerWidth - Math.max(0, startX))}px;
          height: ${Math.max(height, 2)}px;
          background: ${colors.bg};
          border-top: 1px solid ${colors.border};
          border-bottom: 1px solid ${colors.border};
          pointer-events: none;
          box-sizing: border-box;
          overflow: hidden;
        `

        if (showLabels && zone.label) {
          const label = document.createElement('span')
          label.textContent = zone.label
          label.style.cssText = `
            position: absolute;
            right: 4px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 9px;
            font-family: monospace;
            color: ${colors.border};
            white-space: nowrap;
            opacity: 0.9;
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
