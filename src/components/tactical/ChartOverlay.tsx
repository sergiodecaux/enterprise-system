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
  /** One filled take-from zone; others faint */
  onlyStrong?: boolean
}

type Rgba = { r: number; g: number; b: number }

function baseHue(zone: LiquidityZone): Rgba {
  const id = zone.id ?? ''
  if (id.startsWith('cong_') || id.startsWith('sr_rng') || id.startsWith('sr_cong')) {
    return { r: 244, g: 114, b: 182 }
  }
  if (id.startsWith('sr_sup') || id.startsWith('sr_eql') || id.startsWith('sr_deal_lo')) {
    return { r: 45, g: 212, b: 191 }
  }
  if (id.startsWith('sr_res') || id.startsWith('sr_eqh') || id.startsWith('sr_deal_hi')) {
    return { r: 251, g: 113, b: 133 }
  }
  if (id.startsWith('sr_premium')) {
    return { r: 148, g: 163, b: 184 }
  }
  if (id.startsWith('sr_discount')) {
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
  highlighted: boolean,
  onlyStrong: boolean
) {
  const tier = tierOf(zone)
  const isPrimary = zone.storyRole === 'PRIMARY' || highlighted
  const isSecondary = zone.storyRole === 'SECONDARY'
  const isFib141 =
    zone.type === 'FIBONACCI' &&
    ((zone.id ?? '').includes('141') || (zone.label ?? '').includes('141'))
  const id = zone.id ?? ''
  const isCong =
    id.startsWith('cong_') ||
    id.startsWith('sr_sup') ||
    id.startsWith('sr_res') ||
    id.startsWith('sr_rng') ||
    id.startsWith('sr_cong') ||
    id.startsWith('sr_eq') ||
    id.startsWith('sr_deal') ||
    id.startsWith('sr_htf')

  const isAction = zone.type === 'FVG' || zone.type === 'ORDER_BLOCK'

  if (isPrimary) {
    return {
      fillA: 0.26,
      borderA: 0.78,
      borderW: 1.5,
      stripeW: 0,
      tier: 'STRONG' as const,
      isFib141: false,
      isCong: false,
      isAction,
      isPrimary: true,
      outlineOnly: false,
    }
  }

  if (isSecondary || onlyStrong) {
    return {
      fillA: 0.05,
      borderA: 0.38,
      borderW: 1,
      stripeW: 0,
      tier: 'WEAK' as const,
      isFib141,
      isCong,
      isAction,
      isPrimary: false,
      outlineOnly: true,
    }
  }

  const airy = isFib141 || ((zone.id ?? '').startsWith('sr_') && !isCong)
  const tierMul = tier === 'STRONG' ? 1.15 : tier === 'MEDIUM' ? 0.85 : 0.55
  let op = (baseOpacityPct / 100) * tierMul
  if (airy) op = Math.min(0.09, op * 0.28)
  if (isCong) op = 0.2
  if (highlighted) op = Math.min(0.58, op * 1.55)
  else op *= 1.05

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
      ? highlighted
        ? 0.28
        : 0.2
      : isAction
        ? highlighted
          ? 0.32
          : 0.2
      : airy
      ? Math.min(0.16, Math.max(0.07, op))
      : Math.min(0.52, Math.max(0.12, op)),
    borderA: highlighted ? 1 : borderA,
    borderW,
    stripeW,
    tier,
    isFib141,
    isCong,
    isAction,
    isPrimary: false,
    outlineOnly: false,
  }
}

function rgba(c: Rgba, a: number): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`
}

function fmtPx(p: number): string {
  if (!(p > 0) || !Number.isFinite(p)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

function rangeCaption(zone: LiquidityZone): string {
  return `${fmtPx(Math.min(zone.bottom, zone.top))}–${fmtPx(Math.max(zone.bottom, zone.top))}`
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

function edgeLabelStyle(hue: Rgba, dimmed: number, highlighted: boolean, compact: boolean): string {
  return `
    position: absolute;
    right: 4px;
    padding: ${compact ? '1px 5px' : '0 4px'};
    border-radius: 3px;
    font-size: ${compact ? '11px' : highlighted ? '10px' : '9px'};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 700;
    color: rgba(255,255,255,0.95);
    background: rgba(8,10,14,0.78);
    border: 1px solid ${rgba(hue, highlighted ? 0.7 : 0.4)};
    text-shadow: 0 1px 2px rgba(0,0,0,0.9);
    white-space: nowrap;
    pointer-events: none;
    opacity: ${dimmed};
  `
}

function isActionZone(zone: LiquidityZone): boolean {
  return (
    zone.type === 'FVG' ||
    zone.type === 'ORDER_BLOCK' ||
    Boolean(zone.contextHint)
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
  onlyStrong = true,
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
      const compact = containerWidth < 560

      const visibleZones = [...zones]
        .sort((a, b) => {
          const ar = a.storyRole === 'PRIMARY' ? 2 : a.storyRole === 'SECONDARY' ? 1 : 0
          const br = b.storyRole === 'PRIMARY' ? 2 : b.storyRole === 'SECONDARY' ? 1 : 0
          if (ar !== br) return br - ar
          const ah = a.id === highlightId ? 1 : 0
          const bh = b.id === highlightId ? 1 : 0
          if (ah !== bh) return bh - ah
          const ak = isActionZone(a) ? 1 : 0
          const bk = isActionZone(b) ? 1 : 0
          if (ak !== bk) return bk - ak
          return (b.strength ?? 5) - (a.strength ?? 5)
        })
        .slice(0, onlyStrong ? 1 : 8)

      for (const zone of visibleZones) {
        const topY = series.priceToCoordinate(zone.top)
        const bottomY = series.priceToCoordinate(zone.bottom)
        const rawStartX = timeScale.timeToCoordinate(zone.startTime as Time)
        const rawEndX =
          zone.endTime != null
            ? timeScale.timeToCoordinate(zone.endTime as Time)
            : null

        const startXNum = rawStartX == null ? 0 : Number(rawStartX)
        const endXNum =
          rawEndX == null || !Number.isFinite(Number(rawEndX))
            ? NaN
            : Number(rawEndX)

        if (topY == null || bottomY == null) continue

        const height = Math.abs(Number(bottomY) - Number(topY))
        const yPos = Math.min(Number(topY), Number(bottomY))
        const left = Math.max(0, startXNum)
        // Stop at the zone's now-edge so the future window stays empty for the path
        const nowCap = plotRight - 10
        const right = Number.isFinite(endXNum)
          ? Math.min(nowCap, Math.max(left + 8, endXNum))
          : Math.min(nowCap, left + Math.max(48, (nowCap - left) * 0.72))
        const width = Math.max(8, right - left)

        if (height < 1 || yPos < -80 || yPos > containerHeight + 80) continue
        if (left >= plotRight) continue

        const highlighted = Boolean(
          highlightId && zone.id === highlightId
        ) || zone.storyRole === 'PRIMARY'
        const hue = baseHue(zone)
        const vis = strengthVisual(zone, opacity, highlighted, onlyStrong)
        const actionable = vis.isPrimary || vis.isAction || isActionZone(zone)
        const dimmed = vis.outlineOnly ? 0.85 : 1

        const div = document.createElement('div')
        const minH = vis.isPrimary || vis.isAction || highlighted ? 8 : 5
        const fill = vis.outlineOnly
          ? rgba(hue, vis.fillA)
          : vis.isPrimary
            ? rgba(hue, vis.fillA)
            : `linear-gradient(90deg, ${rgba(hue, vis.fillA)} 0%, ${rgba(hue, vis.fillA * 0.55)} 70%, ${rgba(hue, vis.fillA * 0.2)} 100%)`
        div.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${yPos}px;
          width: ${width}px;
          height: ${Math.max(height, minH)}px;
          background: ${fill};
          border-top: ${vis.borderW}px ${vis.outlineOnly || vis.isFib141 ? 'dashed' : 'solid'} ${rgba(hue, vis.borderA * dimmed)};
          border-bottom: ${vis.borderW}px ${vis.outlineOnly || vis.isFib141 ? 'dashed' : 'solid'} ${rgba(hue, vis.borderA * dimmed)};
          box-shadow: ${
            vis.isPrimary
              ? `inset 0 0 0 1px ${rgba(hue, 0.28)}`
              : 'none'
          };
          opacity: ${dimmed};
          pointer-events: none;
          box-sizing: border-box;
          overflow: visible;
          border-radius: 2px;
        `

        const bandH = Math.max(height, minH)
        if (!quiet && !vis.outlineOnly) {
          if (bandH >= 26) {
            const topLbl = document.createElement('div')
            topLbl.textContent = fmtPx(Math.max(zone.top, zone.bottom))
            topLbl.style.cssText = `${edgeLabelStyle(hue, dimmed, highlighted, compact)} top: 1px;`
            div.appendChild(topLbl)
            const botLbl = document.createElement('div')
            botLbl.textContent = fmtPx(Math.min(zone.top, zone.bottom))
            botLbl.style.cssText = `${edgeLabelStyle(hue, dimmed, highlighted, compact)} bottom: 1px;`
            div.appendChild(botLbl)
          } else {
            const midLbl = document.createElement('div')
            midLbl.textContent = rangeCaption(zone)
            midLbl.style.cssText = `${edgeLabelStyle(hue, dimmed, highlighted, compact)} top: 50%; transform: translateY(-50%);`
            div.appendChild(midLbl)
          }
        }

        if (vis.isPrimary && (width >= 40 || highlighted) && !vis.outlineOnly) {
          const pill = document.createElement('div')
          pill.textContent = quiet ? 'зона' : 'сильная зона'
          const pillH = Math.max(height, minH)
          const floatUp = compact && pillH < 24 && yPos >= 22
          pill.style.cssText = `
            position: absolute;
            left: ${floatUp ? `${left + 6}px` : '6px'};
            top: ${floatUp ? `${Math.max(4, yPos - 4)}px` : '50%'};
            transform: ${floatUp ? 'translateY(-100%)' : 'translateY(-50%)'};
            max-width: ${Math.max(72, Math.min(compact ? 160 : 200, width - 10))}px;
            padding: ${compact ? '2px 8px' : '1px 6px'};
            border-radius: 4px;
            font-size: ${compact ? '12px' : '10px'};
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-weight: 700;
            letter-spacing: 0.01em;
            color: rgba(255,255,255,0.95);
            background: rgba(0,0,0,0.72);
            border: 1px solid ${rgba(hue, 0.75)};
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            text-shadow: 0 1px 2px rgba(0,0,0,0.85);
          `
          if (floatUp) {
            overlay.appendChild(div)
            overlay.appendChild(pill)
          } else {
            div.appendChild(pill)
            overlay.appendChild(div)
          }
          continue
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
    onlyStrong,
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
