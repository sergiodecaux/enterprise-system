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
  /** TradingView-style: no in-chart pills / tags (prices live on the right axis) */
  quiet?: boolean
}

type Rgba = { r: number; g: number; b: number }

function baseHue(zone: LiquidityZone): Rgba {
  if ((zone.id ?? '').startsWith('cong_')) {
    return { r: 244, g: 114, b: 182 }
  }
  if ((zone.id ?? '').startsWith('sr_premium')) {
    return { r: 148, g: 163, b: 184 }
  }
  if ((zone.id ?? '').startsWith('sr_discount')) {
    return { r: 45, g: 180, b: 175 }
  }
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
  const isCong = (zone.id ?? '').startsWith('cong_')

  const isAction = zone.type === 'FVG' || zone.type === 'ORDER_BLOCK'
  const airy = isFib141 || ((zone.id ?? '').startsWith('sr_') && !isCong)
  const tierMul = tier === 'STRONG' ? 1.15 : tier === 'MEDIUM' ? 0.85 : 0.55
  let op = (baseOpacityPct / 100) * tierMul
  if (airy) op = Math.min(0.09, op * 0.28)
  if (isCong) op = 0.16
  if (highlighted) op = Math.min(0.55, op * 1.45)
  else op *= 0.92

  const borderA = isCong
    ? 0.38
    : isAction
      ? highlighted ? 0.85 : 0.62
    : airy
    ? 0.32
    : tier === 'STRONG'
      ? 0.95
      : tier === 'MEDIUM'
        ? 0.72
        : 0.45
  const borderW = highlighted ? 2 : isCong || airy ? 1 : tier === 'STRONG' ? 1.5 : 1
  const stripeW = airy ? 2 : tier === 'STRONG' ? 4 : tier === 'MEDIUM' ? 3 : 2

  return {
    fillA: isCong
      ? 0.16
      : isAction
        ? highlighted
          ? 0.26
          : 0.16
      : airy
      ? Math.min(0.1, Math.max(0.035, op))
      : Math.min(0.5, Math.max(0.08, op)),
    borderA: highlighted ? 1 : borderA,
    borderW,
    stripeW,
    tier,
    isFib141,
    isCong,
    isAction,
  }
}

function rgba(c: Rgba, a: number): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`
}

function compactLabel(zone: LiquidityZone): string {
  if (zone.contextHint) return zone.contextHint
  if (zone.type === 'FVG') {
    return zone.side === 'BULLISH' ? 'FVG · лонг с отката' : 'FVG · шорт с отката'
  }
  if (zone.type === 'ORDER_BLOCK') {
    return zone.side === 'BULLISH' ? 'OB · лонг с отката' : 'OB · шорт с отката'
  }
  return zone.label || zone.type
}

function isActionZone(zone: LiquidityZone): boolean {
  return (
    zone.type === 'FVG' ||
    zone.type === 'ORDER_BLOCK' ||
    Boolean(zone.contextHint && !(zone.id ?? '').startsWith('cong_'))
  )
}

const ChartOverlay = ({
  chart,
  series,
  zones,
  containerRef,
  opacity,
  showLabels,
  highlightId = null,
  quiet = true,
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
      let priceScaleW = 56
      try {
        const w = chart.priceScale('right').width()
        if (typeof w === 'number' && w > 8) priceScaleW = w
      } catch {
        /* ignore */
      }
      const plotRight = Math.max(80, containerWidth - priceScaleW)

      const visibleZones = [...zones]
        .sort((a, b) => {
          const ah = a.id === highlightId ? 1 : 0
          const bh = b.id === highlightId ? 1 : 0
          if (ah !== bh) return bh - ah
          const ak = isActionZone(a) ? 1 : 0
          const bk = isActionZone(b) ? 1 : 0
          if (ak !== bk) return bk - ak
          return (b.strength ?? 5) - (a.strength ?? 5)
        })
        .slice(0, 12)

      for (const zone of visibleZones) {
        const topY = series.priceToCoordinate(zone.top)
        const bottomY = series.priceToCoordinate(zone.bottom)
        const rawStartX = timeScale.timeToCoordinate(zone.startTime as Time)
        const endX = timeScale.timeToCoordinate(
          (zone.endTime ?? zone.startTime) as Time
        )

        const startXNum = rawStartX == null ? 0 : Number(rawStartX)
        const endXNum = endX == null ? plotRight : Number(endX)

        if (topY == null || bottomY == null) continue

        const height = Math.abs(Number(bottomY) - Number(topY))
        const yPos = Math.min(Number(topY), Number(bottomY))
        const left = Math.max(0, startXNum)
        const width = Math.min(
          Math.max(
            endXNum > startXNum ? endXNum - startXNum : plotRight - startXNum,
            8
          ),
          plotRight - left
        )

        if (height < 1 || yPos < -80 || yPos > containerHeight + 80) continue
        if (startXNum > plotRight) continue

        const highlighted = Boolean(highlightId && zone.id === highlightId)
        const hue = baseHue(zone)
        const vis = strengthVisual(zone, opacity, highlighted)
        const actionable = vis.isAction || isActionZone(zone)
        const dimmed =
          Boolean(highlightId) && !highlighted
            ? actionable
              ? 0.78
              : 0.42
            : 1

        const div = document.createElement('div')
        const minH = vis.isFib141 || vis.isCong || vis.isAction || highlighted ? 5 : 3
        const fillStart = vis.isCong
          ? vis.fillA * dimmed
          : vis.isFib141
            ? vis.fillA * 0.7 * dimmed
            : vis.fillA * 1.15 * dimmed
        const fillMid = vis.isCong
          ? vis.fillA * 0.92 * dimmed
          : vis.isFib141
            ? vis.fillA * 0.45 * dimmed
            : vis.fillA * 0.55 * dimmed
        const fillEnd = vis.isCong
          ? vis.fillA * 0.78 * dimmed
          : vis.isFib141
            ? vis.fillA * 0.2 * dimmed
            : vis.fillA * 0.25 * dimmed
        div.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${yPos}px;
          width: ${width}px;
          height: ${Math.max(height, minH)}px;
          background: ${
            vis.isAction
              ? `repeating-linear-gradient(-52deg, ${rgba(hue, vis.fillA * dimmed)} 0px, ${rgba(hue, vis.fillA * dimmed)} 5px, ${rgba(hue, vis.fillA * 0.45 * dimmed)} 5px, ${rgba(hue, vis.fillA * 0.45 * dimmed)} 10px)`
              : `linear-gradient(90deg, ${rgba(hue, fillStart)} 0%, ${rgba(hue, fillMid)} 55%, ${rgba(hue, fillEnd)} 100%)`
          };
          border-top: ${vis.borderW}px ${vis.isFib141 ? 'dashed' : 'solid'} ${rgba(hue, vis.borderA * dimmed)};
          border-bottom: ${vis.borderW}px ${vis.isFib141 ? 'dashed' : 'solid'} ${rgba(hue, vis.borderA * dimmed)};
          box-shadow: ${
            highlighted
              ? `0 0 12px ${rgba(hue, 0.35)}, inset 0 0 0 1px ${rgba(hue, 0.4)}`
              : vis.tier === 'STRONG' && !vis.isFib141
                ? `inset 0 0 0 1px ${rgba(hue, 0.2)}`
                : 'none'
          };
          opacity: ${dimmed};
          pointer-events: none;
          box-sizing: border-box;
          overflow: hidden;
          border-radius: 2px;
        `

        if (actionable && (width >= 48 || highlighted)) {
          const pill = document.createElement('div')
          pill.textContent = compactLabel(zone)
          pill.style.cssText = `
            position: absolute;
            left: 6px;
            top: 50%;
            transform: translateY(-50%);
            max-width: ${Math.max(64, Math.min(200, width - 12))}px;
            padding: 1px 6px;
            border-radius: 4px;
            font-size: ${highlighted ? '10px' : '9px'};
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-weight: ${highlighted ? '700' : '600'};
            letter-spacing: 0.01em;
            color: rgba(255,255,255,0.95);
            background: rgba(0,0,0,0.58);
            border: 1px solid ${rgba(hue, highlighted ? 0.75 : 0.5)};
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            text-shadow: 0 1px 2px rgba(0,0,0,0.85);
          `
          div.appendChild(pill)
        }

        if (!quiet && !actionable) {
        const stripe = document.createElement('div')
        stripe.style.cssText = `
          position: absolute;
          left: 0; top: 0; bottom: 0;
          width: ${vis.stripeW + (zone.type === 'SSL' || zone.type === 'BSL' ? 2 : 0)}px;
          background: ${rgba(hue, vis.tier === 'STRONG' ? 0.95 : vis.tier === 'MEDIUM' ? 0.7 : 0.4)};
        `
        div.appendChild(stripe)

        if (
          (zone.type === 'SSL' || zone.type === 'BSL' || zone.type === 'LIQ') &&
          height >= 12
        ) {
          const chev = document.createElement('div')
          const up = zone.type === 'SSL' || zone.type === 'LIQ'
          chev.textContent = up ? '▲ LONG' : '▼ SHORT'
          chev.style.cssText = `
            position: absolute;
            left: ${vis.stripeW + 6}px;
            bottom: 2px;
            font-size: 8px;
            font-weight: 800;
            letter-spacing: 0.04em;
            color: ${rgba(hue, 0.95)};
            font-family: ui-monospace, Menlo, monospace;
            text-shadow: 0 1px 2px rgba(0,0,0,0.85);
          `
          div.appendChild(chev)
        }

        const isKeyZone =
          zone.type === 'SSL' ||
          zone.type === 'BSL' ||
          zone.type === 'FIBONACCI' ||
          zone.type === 'OTE' ||
          highlighted
        const showPill =
          showLabels ||
          vis.isFib141 ||
          highlighted ||
          (isKeyZone && vis.tier !== 'WEAK')

        if (showPill) {
          const pill = document.createElement('div')
          pill.textContent = compactLabel(zone)
          pill.style.cssText = `
            position: absolute;
            left: ${vis.stripeW + 6}px;
            top: 50%;
            transform: translateY(-50%);
            max-width: ${Math.max(72, Math.min(180, width - 48))}px;
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

        } // !quiet decorations

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
    quiet,
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
