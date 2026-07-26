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
  /** Highlight this zone id (selected setup / found zone) */
  highlightId?: string | null
  /** Always show SSL/BSL/Fib context pills */
  forceContextLabels?: boolean
}

type Rgba = { r: number; g: number; b: number }

function baseHue(zone: LiquidityZone): Rgba {
  switch (zone.type) {
    case 'ORDER_BLOCK':
      return zone.side === 'BULLISH'
        ? { r: 34, g: 197, b: 94 }
        : { r: 239, g: 68, b: 68 }
    case 'FVG':
      return zone.side === 'BULLISH'
        ? { r: 59, g: 130, b: 246 }
        : { r: 168, g: 85, b: 247 }
    case 'POC':
      return { r: 249, g: 115, b: 22 }
    case 'VALUE_AREA':
      return { r: 148, g: 163, b: 184 }
    case 'OTE':
      return zone.side === 'BEARISH'
        ? { r: 239, g: 68, b: 68 }
        : { r: 16, g: 185, b: 129 }
    case 'FIBONACCI':
      return zone.side === 'BULLISH'
        ? { r: 251, g: 191, b: 36 }
        : { r: 192, g: 132, b: 252 }
    case 'SSL':
    case 'LIQ':
      // Teal — support / hold to go up
      return { r: 45, g: 212, b: 191 }
    case 'BSL':
      // Rose — resistance / hold to go down (short)
      return { r: 251, g: 113, b: 133 }
    default:
      return { r: 100, g: 200, b: 255 }
  }
}

function tierOf(zone: LiquidityZone): 'WEAK' | 'MEDIUM' | 'STRONG' {
  if (zone.strengthTier) return zone.strengthTier
  const s = zone.strength ?? 5
  if (s >= 9) return 'STRONG'
  if (s >= 7) return 'MEDIUM'
  return 'WEAK'
}

/** Strength → fill alpha multiplier + border weight */
function strengthVisual(
  zone: LiquidityZone,
  baseOpacityPct: number,
  highlighted: boolean
) {
  const tier = tierOf(zone)
  const isFib141 =
    zone.type === 'FIBONACCI' &&
    ((zone.id ?? '').includes('141') || (zone.label ?? '').includes('141'))

  const tierMul = tier === 'STRONG' ? 1.15 : tier === 'MEDIUM' ? 0.85 : 0.55
  let op = (baseOpacityPct / 100) * tierMul
  if (isFib141) op = Math.max(op, 0.32)
  if (highlighted) op = Math.min(0.55, op * 1.45)
  else op *= 0.92

  const borderA =
    tier === 'STRONG' ? 0.95 : tier === 'MEDIUM' ? 0.72 : 0.45
  const borderW = highlighted ? 2 : tier === 'STRONG' ? 1.5 : 1
  const stripeW = tier === 'STRONG' ? 4 : tier === 'MEDIUM' ? 3 : 2

  return {
    fillA: Math.min(0.5, Math.max(0.08, op)),
    borderA: highlighted ? 1 : borderA,
    borderW,
    stripeW,
    tier,
    isFib141,
  }
}

function rgba(c: Rgba, a: number): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`
}

function zoneTitle(zone: LiquidityZone): string {
  if (zone.contextHint) {
    const short =
      zone.type === 'SSL'
        ? 'SSL'
        : zone.type === 'BSL'
          ? 'BSL'
          : zone.type === 'FIBONACCI'
            ? zone.label?.includes('141')
              ? 'F141'
              : 'Fib'
            : zone.type === 'OTE'
              ? 'OTE'
              : zone.type === 'ORDER_BLOCK'
                ? 'OB'
                : zone.label?.split('·')[0]?.trim() || zone.type
    const hold =
      zone.side === 'BULLISH' || zone.type === 'SSL'
        ? 'удерж ↑'
        : zone.side === 'BEARISH' || zone.type === 'BSL'
          ? 'удерж ↓'
          : ''
    const lost =
      zone.invalidation != null
        ? zone.side === 'BULLISH' || zone.type === 'SSL'
          ? `слом < ${fmtPx(zone.invalidation)}`
          : `слом > ${fmtPx(zone.invalidation)}`
        : ''
    return [short, hold, lost].filter(Boolean).join(' · ')
  }
  return zone.label ?? zone.type
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

const ChartOverlay = ({
  chart,
  series,
  zones,
  containerRef,
  opacity,
  showLabels,
  highlightId = null,
  forceContextLabels = false,
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

      const visibleZones = [...zones]
        .sort((a, b) => {
          const ah = a.id === highlightId ? 1 : 0
          const bh = b.id === highlightId ? 1 : 0
          if (ah !== bh) return bh - ah
          return (b.strength ?? 5) - (a.strength ?? 5)
        })
        .slice(0, forceContextLabels ? 6 : 8)

      for (const zone of visibleZones) {
        const topY = series.priceToCoordinate(zone.top)
        const bottomY = series.priceToCoordinate(zone.bottom)
        const rawStartX = timeScale.timeToCoordinate(zone.startTime as Time)
        const endX = timeScale.timeToCoordinate(
          (zone.endTime ?? zone.startTime) as Time
        )

        const startXNum = rawStartX == null ? 0 : Number(rawStartX)
        const endXNum = endX == null ? containerWidth : Number(endX)

        if (topY == null || bottomY == null) continue

        const height = Math.abs(Number(bottomY) - Number(topY))
        const yPos = Math.min(Number(topY), Number(bottomY))
        const left = Math.max(0, startXNum)
        const width = Math.min(
          Math.max(endXNum > startXNum ? endXNum - startXNum : containerWidth - startXNum, 8),
          containerWidth - left
        )

        if (height < 1 || yPos < -80 || yPos > containerHeight + 80) continue
        if (startXNum > containerWidth) continue

        const highlighted = Boolean(highlightId && zone.id === highlightId)
        const hue = baseHue(zone)
        const vis = strengthVisual(zone, opacity, highlighted)
        const dimmed =
          Boolean(highlightId) && !highlighted ? 0.45 : 1

        const div = document.createElement('div')
        const minH = vis.isFib141 || highlighted ? 5 : 3
        div.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${yPos}px;
          width: ${width}px;
          height: ${Math.max(height, minH)}px;
          background: linear-gradient(
            90deg,
            ${rgba(hue, vis.fillA * 1.15 * dimmed)} 0%,
            ${rgba(hue, vis.fillA * 0.55 * dimmed)} 55%,
            ${rgba(hue, vis.fillA * 0.25 * dimmed)} 100%
          );
          border-top: ${vis.borderW}px solid ${rgba(hue, vis.borderA * dimmed)};
          border-bottom: ${vis.borderW}px solid ${rgba(hue, vis.borderA * dimmed)};
          box-shadow: ${
            highlighted
              ? `0 0 12px ${rgba(hue, 0.35)}, inset 0 0 0 1px ${rgba(hue, 0.4)}`
              : vis.tier === 'STRONG'
                ? `inset 0 0 0 1px ${rgba(hue, 0.2)}`
                : 'none'
          };
          opacity: ${dimmed};
          pointer-events: none;
          box-sizing: border-box;
          overflow: hidden;
          border-radius: 2px;
        `

        // Left strength stripe
        const stripe = document.createElement('div')
        stripe.style.cssText = `
          position: absolute;
          left: 0; top: 0; bottom: 0;
          width: ${vis.stripeW}px;
          background: ${rgba(hue, vis.tier === 'STRONG' ? 0.95 : vis.tier === 'MEDIUM' ? 0.7 : 0.4)};
        `
        div.appendChild(stripe)

        const isKeyZone =
          zone.type === 'SSL' ||
          zone.type === 'BSL' ||
          zone.type === 'FIBONACCI' ||
          zone.type === 'OTE' ||
          highlighted
        const showPill =
          forceContextLabels ||
          showLabels ||
          vis.isFib141 ||
          highlighted ||
          (isKeyZone && vis.tier !== 'WEAK')

        if (showPill) {
          const pill = document.createElement('div')
          pill.textContent = zoneTitle(zone)
          pill.style.cssText = `
            position: absolute;
            right: 4px;
            top: 50%;
            transform: translateY(-50%);
            max-width: ${Math.max(80, width - 10)}px;
            padding: 1px 6px;
            border-radius: 4px;
            font-size: ${highlighted || vis.isFib141 ? '10px' : '9px'};
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-weight: ${vis.tier === 'STRONG' || highlighted ? '700' : '600'};
            letter-spacing: 0.01em;
            color: rgba(255,255,255,0.95);
            background: rgba(0,0,0,0.55);
            border: 1px solid ${rgba(hue, 0.55)};
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            text-shadow: 0 1px 2px rgba(0,0,0,0.85);
            backdrop-filter: blur(2px);
          `
          div.appendChild(pill)
        }

        // Strength dots on left of pill area for STRONG
        if (vis.tier === 'STRONG' && height >= 10) {
          const badge = document.createElement('span')
          badge.textContent = '●●●'
          badge.style.cssText = `
            position: absolute;
            left: ${vis.stripeW + 4}px;
            top: 2px;
            font-size: 7px;
            letter-spacing: 1px;
            color: ${rgba(hue, 0.9)};
            font-family: monospace;
          `
          div.appendChild(badge)
        } else if (vis.tier === 'MEDIUM' && height >= 10) {
          const badge = document.createElement('span')
          badge.textContent = '●●'
          badge.style.cssText = `
            position: absolute;
            left: ${vis.stripeW + 4}px;
            top: 2px;
            font-size: 7px;
            letter-spacing: 1px;
            color: ${rgba(hue, 0.7)};
            font-family: monospace;
          `
          div.appendChild(badge)
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
  }, [
    chart,
    series,
    zones,
    opacity,
    showLabels,
    containerRef,
    highlightId,
    forceContextLabels,
  ])

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 1 }}
    />
  )
}

export default ChartOverlay
