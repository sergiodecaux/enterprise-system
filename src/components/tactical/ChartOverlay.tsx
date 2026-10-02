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
  /** TradingView-style: no in-chart price pills (prices live on the right axis) */
  quiet?: boolean
  /** One filled take-from zone + faint context — not a wall of bands */
  onlyStrong?: boolean
  /** Fullscreen: smaller primary caption, skip weak labels and edge prices */
  thinLabels?: boolean
}

type Rgba = { r: number; g: number; b: number }
type Box = { x: number; y: number; w: number; h: number }

function storyHue(zone: LiquidityZone): Rgba | null {
  if (zone.storyRole === 'PRIMARY') {
    if (zone.side === 'BEARISH') return { r: 251, g: 113, b: 133 }
    if (zone.side === 'BULLISH') return { r: 45, g: 212, b: 191 }
  }
  return null
}

function baseHue(zone: LiquidityZone): Rgba {
  const story = storyHue(zone)
  if (story) return story
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
      return { r: 45, g: 212, b: 191 }
    case 'BSL':
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
      fillA: 0.56,
      borderA: 1,
      borderW: 3.2,
      stripeW: 0,
      tier: 'STRONG' as const,
      isFib141: false,
      isCong: false,
      isAction,
      isPrimary: true,
      outlineOnly: false,
    }
  }

  if (isSecondary) {
    return {
      fillA: 0.12,
      borderA: 0.72,
      borderW: 1.4,
      stripeW: 0,
      tier: 'WEAK' as const,
      isFib141,
      isCong,
      isAction,
      isPrimary: false,
      outlineOnly: true,
    }
  }

  if (onlyStrong) {
    return {
      fillA: 0.08,
      borderA: 0.5,
      borderW: 1.2,
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
      ? highlighted
        ? 0.85
        : 0.62
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

function zoneCaption(
  zone: LiquidityZone,
  _many: boolean,
  isPrimary: boolean,
  thin: boolean
): string {
  if (thin) return zone.label || (isPrimary ? 'сильная' : compactLabel(zone))
  if (isPrimary) return zone.contextHint || compactLabel(zone)
  return zone.label || zone.contextHint || compactLabel(zone)
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

function overlaps(a: Box, b: Box): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

function placeBox(
  used: Box[],
  x: number,
  y: number,
  w: number,
  h: number,
  plotRight: number,
  containerHeight: number
): Box {
  let px = Math.max(10, Math.min(x, plotRight - w - 10))
  let py = Math.max(2, y)
  for (let i = 0; i < 12; i++) {
    const b = { x: px, y: py, w, h }
    if (
      !used.some((u) => overlaps(u, b)) &&
      py >= 2 &&
      py + h <= containerHeight - 2 &&
      px >= 10 &&
      px + w <= plotRight - 6
    ) {
      used.push(b)
      return b
    }
    py += h + 3
    if (py + h > containerHeight - 2) {
      py = Math.max(2, y - (i + 1) * (h + 3))
    }
  }
  const fallback = {
    x: Math.max(10, Math.min(px, plotRight - w - 10)),
    y: Math.max(2, Math.min(y, containerHeight - h - 2)),
    w,
    h,
  }
  used.push(fallback)
  return fallback
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
  thinLabels = false,
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
      const used: Box[] = []

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
        .slice(0, onlyStrong ? 4 : 8)

      const many = visibleZones.length > 3
      const captions: Array<{
        zone: LiquidityZone
        vis: ReturnType<typeof strengthVisual>
        hue: Rgba
        left: number
        yPos: number
        height: number
        width: number
      }> = []

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

        const highlighted =
          Boolean(highlightId && zone.id === highlightId) ||
          zone.storyRole === 'PRIMARY'
        const isPrimaryBand = zone.storyRole === 'PRIMARY' || highlighted

        let topN = topY == null ? NaN : Number(topY)
        let botN = bottomY == null ? NaN : Number(bottomY)
        if ((!Number.isFinite(topN) || !Number.isFinite(botN)) && isPrimaryBand) {
          const mid = containerHeight * 0.42
          topN = mid - 22
          botN = mid + 22
        }
        if (!Number.isFinite(topN) || !Number.isFinite(botN)) continue

        const rawH = Math.abs(botN - topN)
        const minBand = isPrimaryBand ? (compact ? 44 : 36) : 10
        const height = Math.max(rawH, minBand)
        let yPos = Math.min(topN, botN)
        if (rawH < minBand) yPos -= (minBand - rawH) / 2
        yPos = Math.max(4, Math.min(yPos, containerHeight - height - 4))
        const left = isPrimaryBand ? 0 : Math.max(0, startXNum)
        const nowCap = plotRight - 8
        const histRight = Number.isFinite(endXNum)
          ? Math.min(nowCap, Math.max(left + 8, endXNum))
          : Math.min(nowCap, left + Math.max(48, (nowCap - left) * 0.72))
        const right = isPrimaryBand
          ? nowCap
          : Math.max(histRight, Math.min(nowCap, left + Math.max(72, (nowCap - left) * 0.55)))
        const width = Math.max(isPrimaryBand ? 80 : 12, right - left)

        if (yPos < -120 || yPos > containerHeight + 120) continue
        if (left >= plotRight) continue

        const hue = baseHue(zone)
        const vis = strengthVisual(zone, opacity, highlighted, onlyStrong)
        const dimmed = vis.outlineOnly ? 0.92 : 1

        const div = document.createElement('div')
        const minH = vis.isPrimary || vis.isAction || highlighted ? 28 : 8
        const fill = vis.isPrimary
          ? `linear-gradient(180deg, ${rgba(hue, vis.fillA * 0.72)} 0%, ${rgba(hue, vis.fillA)} 45%, ${rgba(hue, vis.fillA * 0.78)} 100%)`
          : vis.outlineOnly
            ? rgba(hue, vis.fillA)
            : `linear-gradient(90deg, ${rgba(hue, vis.fillA)} 0%, ${rgba(hue, vis.fillA * 0.55)} 70%, ${rgba(hue, vis.fillA * 0.2)} 100%)`
        const dash = vis.outlineOnly || vis.isFib141 ? 'dashed' : 'solid'
        div.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${yPos}px;
          width: ${width}px;
          height: ${Math.max(height, minH)}px;
          background: ${fill};
          border: ${vis.borderW}px ${dash} ${rgba(hue, vis.borderA * dimmed)};
          box-shadow: ${
            vis.isPrimary
              ? `inset 0 0 0 2px ${rgba(hue, 0.7)}, 0 0 22px ${rgba(hue, 0.38)}`
              : 'none'
          };
          opacity: 1;
          pointer-events: none;
          box-sizing: border-box;
          overflow: visible;
          border-radius: 4px;
          z-index: ${vis.isPrimary ? 2 : 1};
        `

        const bandH = Math.max(height, minH)
        if (!thinLabels && !quiet && !vis.outlineOnly) {
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

        overlay.appendChild(div)
        captions.push({
          zone,
          vis,
          hue,
          left,
          yPos,
          height: bandH,
          width,
        })
      }

      for (const cap of captions) {
        const isPrimary = cap.vis.isPrimary
        const story =
          cap.zone.storyRole === 'PRIMARY' || cap.zone.storyRole === 'SECONDARY'
        if (thinLabels && !isPrimary) continue
        if (!story && !showLabels && quiet) continue
        let text = zoneCaption(cap.zone, many, isPrimary, thinLabels)
        if (!text) continue
        if (thinLabels && text.length > 26) text = `${text.slice(0, 25)}…`
        const fontPx = thinLabels
          ? 9
          : isPrimary
            ? 11
            : compact
              ? 10
              : 9
        const padX = thinLabels ? 5 : isPrimary ? 7 : 5
        const twoLine = !thinLabels && isPrimary && compact && text.length > 22
        const pillH = thinLabels
          ? 16
          : twoLine
            ? compact
              ? 32
              : 28
            : isPrimary
              ? compact
                ? 20
                : 18
              : compact
                ? 16
                : 14
        const est = text.length * (fontPx * 0.62) + padX * 2
        const visLeft = Math.max(10, cap.left)
        const visRight = Math.min(plotRight - 10, cap.left + cap.width)
        const room = Math.max(96, visRight - visLeft - 8)
        const pillW = Math.min(Math.max(twoLine ? 108 : 84, est), room, plotRight - 20)
        const preferAbove =
          cap.height < (twoLine ? 36 : 26) && cap.yPos >= pillH + 4
        const preferInside = cap.height >= pillH + 6
        const rawX = visLeft + 6
        const rawY = preferAbove
          ? cap.yPos - pillH - 2
          : preferInside
            ? cap.yPos + Math.max(3, (cap.height - pillH) * 0.12)
            : cap.yPos + 3
        const box = placeBox(
          used,
          rawX,
          rawY,
          pillW,
          pillH,
          plotRight,
          containerHeight
        )
        box.x = Math.max(10, box.x)
        const pill = document.createElement('div')
        pill.textContent = text
        pill.style.cssText = `
          position: absolute;
          left: ${box.x}px;
          top: ${box.y}px;
          width: ${pillW}px;
          max-width: ${Math.max(80, plotRight - box.x - 10)}px;
          padding: ${thinLabels ? '1px 5px' : isPrimary ? '2px 7px' : '1px 5px'};
          border-radius: 4px;
          font-size: ${fontPx}px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-weight: ${isPrimary ? 800 : 600};
          letter-spacing: 0.01em;
          line-height: 1.25;
          color: ${isPrimary ? 'rgba(255,255,255,0.96)' : 'rgba(226,232,240,0.9)'};
          background: ${isPrimary ? 'rgba(0,0,0,0.84)' : 'rgba(8,10,14,0.78)'};
          border: ${isPrimary ? 1.5 : 1}px ${isPrimary ? 'solid' : 'dashed'} ${rgba(
            cap.hue,
            isPrimary ? 0.9 : 0.55
          )};
          white-space: ${twoLine ? 'normal' : 'nowrap'};
          overflow: visible;
          word-break: keep-all;
          text-shadow: 0 1px 2px rgba(0,0,0,0.85);
          opacity: 1;
          pointer-events: none;
        `
        overlay.appendChild(pill)
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
    thinLabels,
  ])

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 8 }}
    />
  )
}

export default ChartOverlay
