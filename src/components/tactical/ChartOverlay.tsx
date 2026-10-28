import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { LiquidityZone } from '../../engine/indicators/types'
import {
  LABEL_PRIORITY,
  labelAnchor,
  publishLabels,
  useChartLabels,
  watchLayer,
  type LabelRequest,
} from './chartLabels/LabelLayoutManager'
import { useViewportRedraw } from './useViewportRedraw'

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
  /** Skip redraw while user pans/zooms */
  interactingRef?: React.MutableRefObject<boolean>
  /** Click / tap on a painted zone → open the advisor (x,y in container px) */
  onZoneClick?: (zone: LiquidityZone, x: number, y: number) => void
  /** Hover on a painted zone → show a live preview near the pointer. */
  onZoneHover?: (zone: LiquidityZone, x: number, y: number) => void
  onZoneLeave?: () => void
}

type Rgba = { r: number; g: number; b: number }

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

  // TradingView rectangle language: a translucent band, one hairline
  // border, one accent edge. No neon glow, no fat frames.
  if (isPrimary) {
    return {
      fillA: 0.1,
      borderA: 0.7,
      borderW: 1,
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
      fillA: 0.025,
      borderA: 0.3,
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

  if (onlyStrong) {
    return {
      fillA: 0.03,
      borderA: 0.26,
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
  const tierMul = tier === 'STRONG' ? 1 : tier === 'MEDIUM' ? 0.7 : 0.45
  let op = (baseOpacityPct / 100) * tierMul
  if (airy) op = Math.min(0.05, op * 0.22)
  if (isCong) op = 0.05
  if (highlighted) op = Math.min(0.12, op * 1.4)

  const borderA = isCong
    ? 0.3
    : isAction
      ? highlighted
        ? 0.68
        : 0.42
      : airy
        ? 0.22
        : tier === 'STRONG'
          ? 0.62
          : tier === 'MEDIUM'
            ? 0.44
            : 0.28
  const borderW = 1
  const stripeW = 0

  return {
    fillA: isCong
      ? 0.05
      : isAction
        ? highlighted
          ? 0.12
          : 0.07
        : airy
          ? Math.min(0.05, Math.max(0.025, op))
          : Math.min(0.14, Math.max(0.04, op)),
    borderA: highlighted ? 0.9 : borderA,
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

function shortZoneLabel(text: string): string {
  // "попытка сноса 143.1584 · стопы снизу" → "попытка сноса 143.1584"
  const head = text.split('·')[0].trim()
  return head.length > 26 ? `${head.slice(0, 25)}…` : head
}

function zoneCaption(
  zone: LiquidityZone,
  _many: boolean,
  isPrimary: boolean,
  thin: boolean
): string {
  if (thin) return shortZoneLabel(zone.label || (isPrimary ? 'сильная зона' : compactLabel(zone)))
  if (isPrimary) return shortZoneLabel(zone.contextHint || compactLabel(zone))
  return shortZoneLabel(zone.label || zone.contextHint || compactLabel(zone))
}

function edgeLabelStyle(hue: Rgba, dimmed: number, highlighted: boolean, compact: boolean): string {
  return `
    position: absolute;
    right: 6px;
    padding: 0 3px;
    border-radius: 2px;
    font-size: ${compact ? 10 : 9}px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: ${rgba(hue, highlighted ? 1 : 0.92)};
    background: rgba(14,17,22,0.6);
    border: 0;
    text-shadow: 0 1px 2px rgba(0,0,0,0.7);
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
  thinLabels = false,
  interactingRef,
  onZoneClick,
  onZoneHover,
  onZoneLeave,
}: Props) => {
  const overlayRef = useRef<HTMLDivElement>(null)
  const layout = useChartLabels()
  const fromListenerRef = useRef(false)
  const redrawRef = useRef<() => void>(() => {})
  const clickRef = useRef(onZoneClick)
  const hoverRef = useRef(onZoneHover)
  const leaveRef = useRef(onZoneLeave)
  clickRef.current = onZoneClick
  hoverRef.current = onZoneHover
  leaveRef.current = onZoneLeave

  useEffect(() => {
    if (!chart || !series || !overlayRef.current || !containerRef.current) {
      layout.clear('chart-zones')
      redrawRef.current = () => {}
      return
    }

    const overlay = overlayRef.current
    const timeScale = chart.timeScale()

    const redraw = () => {
      try {
      const fromListener = fromListenerRef.current
      overlay.innerHTML = ''
      const containerWidth = containerRef.current!.clientWidth
      const containerHeight = containerRef.current!.clientHeight
      if (containerWidth < 80 || containerHeight < 40) {
        if (!fromListener) layout.clear('chart-zones')
        return
      }
      let priceScaleW = 56
      try {
        const w = chart.priceScale('right').width()
        if (typeof w === 'number' && w > 8) priceScaleW = w
      } catch {
        /* ignore */
      }
      const plotRight = Math.max(80, containerWidth - priceScaleW)
      const compact = containerWidth < 560
      const requests: LabelRequest[] = []
      const edgeJobs: Array<{
        parent: HTMLDivElement
        id: string
        text: string
        zoneTop: number
        fallbackY: number
        css: string
      }> = []
      const pillJobs: Array<{
        id: string
        text: string
        fallbackY: number
        zoneTop: number
        anchorX: number
        hue: string
        css: string
      }> = []

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

      for (let zi = 0; zi < visibleZones.length; zi++) {
        const zone = visibleZones[zi]
        let topY: ReturnType<typeof series.priceToCoordinate> = null
        let bottomY: ReturnType<typeof series.priceToCoordinate> = null
        let rawStartX: ReturnType<typeof timeScale.timeToCoordinate> = null
        let rawEndX: ReturnType<typeof timeScale.timeToCoordinate> = null
        try {
          topY = series.priceToCoordinate(zone.top)
          bottomY = series.priceToCoordinate(zone.bottom)
          rawStartX = timeScale.timeToCoordinate(zone.startTime as Time)
          rawEndX =
            zone.endTime != null
              ? timeScale.timeToCoordinate(zone.endTime as Time)
              : null
        } catch {
          continue
        }

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
        const minBand = isPrimaryBand ? 24 : 6
        const height = Math.max(rawH, minBand)
        let yPos = Math.min(topN, botN)
        if (rawH < minBand) yPos -= (minBand - rawH) / 2
        yPos = Math.max(4, Math.min(yPos, containerHeight - height - 4))
        const left = Math.max(0, startXNum)
        const nowCap = plotRight - 8
        const histRight = Number.isFinite(endXNum)
          ? Math.min(nowCap, Math.max(left + 8, endXNum))
          : Math.min(nowCap, left + Math.max(56, (nowCap - left) * 0.38))
        const right = Math.max(histRight, Math.min(nowCap, left + 72))
        const width = Math.max(16, right - left)

        if (yPos < -120 || yPos > containerHeight + 120) continue
        if (left >= plotRight) continue

        const hue = baseHue(zone)
        const vis = strengthVisual(zone, opacity, highlighted, onlyStrong)
        const dimmed = vis.outlineOnly ? 0.92 : 1

        const div = document.createElement('div')
        const minH = vis.isPrimary ? 22 : 6
        const fill = vis.isPrimary
          ? `linear-gradient(180deg, ${rgba(hue, vis.fillA * 0.55)} 0%, ${rgba(hue, vis.fillA)} 100%)`
          : `linear-gradient(90deg, ${rgba(hue, vis.fillA)} 0%, ${rgba(hue, vis.fillA * 0.45)} 72%, ${rgba(hue, vis.fillA * 0.12)} 100%)`
        const dash = vis.isFib141 ? 'dashed' : 'solid'
        div.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${yPos}px;
          width: ${width}px;
          height: ${Math.max(height, minH)}px;
          background: ${fill};
          border: ${vis.borderW}px ${dash} ${rgba(hue, vis.borderA * dimmed)};
          box-shadow: ${vis.isPrimary ? `inset 2px 0 0 ${rgba(hue, 0.95)}` : 'none'};
          opacity: 1;
          pointer-events: none;
          box-sizing: border-box;
          overflow: visible;
          border-radius: 2px;
          z-index: ${vis.isPrimary ? 2 : 1};
        `

        const bandH = Math.max(height, minH)
        const edgeCss = edgeLabelStyle(hue, dimmed, highlighted, compact)
        const queueEdge = (suffix: string, text: string, y: number) => {
          const id = `zone:${zone.id}:${suffix}`
          edgeJobs.push({ parent: div, id, text, zoneTop: yPos, fallbackY: y, css: edgeCss })
          requests.push({
            id,
            priceY: y,
            text,
            priority: LABEL_PRIORITY.zone,
            sourceLayer: 'chart-zones',
            height: 16,
          })
        }
        if (!thinLabels && !quiet && !vis.outlineOnly) {
          if (bandH >= 26) {
            queueEdge('top', fmtPx(Math.max(zone.top, zone.bottom)), yPos + 1)
            queueEdge('bot', fmtPx(Math.min(zone.top, zone.bottom)), yPos + bandH - 16)
          } else {
            queueEdge('mid', rangeCaption(zone), yPos + bandH / 2 - 7)
          }
        }

        overlay.appendChild(div)

        // Invisible, taller hit box so thin bands stay easy to hit. The visual
        // band itself keeps pointer-events: none (crosshair stays native).
        const hitH = Math.max(bandH, 20)
        const hit = document.createElement('div')
        hit.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${yPos - (hitH - bandH) / 2}px;
          width: ${width}px;
          height: ${hitH}px;
          pointer-events: ${clickRef.current ? 'auto' : 'none'};
          cursor: pointer;
          z-index: ${30 - zi};
          border-radius: 3px;
        `
        const baseBorder = div.style.borderColor
        const baseShadow = div.style.boxShadow
        hit.addEventListener('pointerenter', (ev) => {
          div.style.borderColor = rgba(hue, Math.max(0.9, vis.borderA))
          div.style.boxShadow = vis.isPrimary
            ? `inset 2px 0 0 ${rgba(hue, 1)}, 0 0 0 1px ${rgba(hue, 0.55)}`
            : `0 0 0 1px ${rgba(hue, 0.55)}`
          const box = containerRef.current
          if (box) {
            const r = box.getBoundingClientRect()
            hoverRef.current?.(zone, ev.clientX - r.left, ev.clientY - r.top)
          }
        })
        hit.addEventListener('pointermove', (ev) => {
          const box = containerRef.current
          if (box) {
            const r = box.getBoundingClientRect()
            hoverRef.current?.(zone, ev.clientX - r.left, ev.clientY - r.top)
          }
        })
        hit.addEventListener('pointerleave', () => {
          div.style.borderColor = baseBorder
          div.style.boxShadow = baseShadow
          leaveRef.current?.()
        })
        hit.addEventListener('click', (ev) => {
          const cb = clickRef.current
          if (!cb) return
          ev.stopPropagation()
          const box = containerRef.current
          if (!box) return
          const r = box.getBoundingClientRect()
          cb(zone, ev.clientX - r.left, ev.clientY - r.top)
        })
        overlay.appendChild(hit)

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
        // A stack of four captions is noise. Keep the lead zone, the action
        // zone, and the secondary story — drop the rest into the visual band.
        if (many && !isPrimary && !cap.vis.isAction && cap.zone.storyRole !== 'SECONDARY')
          continue
        if (!story && !showLabels && quiet) continue
        let text = zoneCaption(cap.zone, many, isPrimary, thinLabels)
        if (!text) continue
        if (thinLabels && text.length > 26) text = `${text.slice(0, 25)}…`
        const fontPx = thinLabels ? 9 : isPrimary ? 10 : 9
        const padX = 5
        const pillH = isPrimary ? 17 : 15
        if (text.length > (thinLabels ? 22 : 30)) {
          text = `${text.slice(0, thinLabels ? 21 : 29)}…`
        }
        const est = text.length * (fontPx * 0.6) + padX * 2
        const visLeft = Math.max(10, cap.left)
        const visRight = Math.min(plotRight - 10, cap.left + cap.width)
        const room = Math.max(96, visRight - visLeft - 8)
        const pillW = Math.min(Math.max(56, est), room, plotRight - 20)
        // TradingView places the rectangle caption at the top-left corner of
        // the drawing, not floating above the price action.
        const rawX = Math.max(6, Math.min(visLeft + 4, plotRight - pillW - 10))
        const rawY = cap.yPos + 1
        const id = `zone:${cap.zone.id}:pill`
        requests.push({
          id,
          priceY: rawY,
          text,
          priority: LABEL_PRIORITY.zone,
          sourceLayer: 'chart-zones',
          height: pillH,
        })
        pillJobs.push({
          id,
          text,
          fallbackY: rawY,
          zoneTop: cap.yPos,
          anchorX: rawX,
          hue: rgba(cap.hue, 0.5),
          css: `
          position: absolute;
          left: ${rawX}px;
          width: ${pillW}px;
          max-width: ${Math.max(80, plotRight - rawX - 10)}px;
          padding: 1px ${padX}px 1px ${padX + 2}px;
          border-radius: 3px;
          font-size: ${fontPx}px;
          font-family: Inter, ui-sans-serif, system-ui, sans-serif;
          font-weight: 500;
          letter-spacing: 0.01em;
          line-height: 1.4;
          color: ${isPrimary ? 'rgba(255,255,255,0.92)' : rgba(cap.hue, 0.95)};
          background: rgba(19,23,34,0.9);
          border: 1px solid ${rgba(cap.hue, isPrimary ? 0.55 : 0.3)};
          border-left: 2px solid ${rgba(cap.hue, isPrimary ? 0.95 : 0.6)};
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-shadow: none;
          opacity: 1;
          pointer-events: none;
        `,
        })
      }

      const placed = publishLabels(layout, 'chart-zones', fromListener, requests)
      for (const job of edgeJobs) {
        const y = labelAnchor(placed, job.id, job.fallbackY)
        if (y == null) continue
        const el = document.createElement('div')
        el.textContent = job.text
        el.style.cssText = `${job.css} top: ${y - job.zoneTop}px;`
        job.parent.appendChild(el)
      }
      for (const job of pillJobs) {
        const y = labelAnchor(placed, job.id, job.fallbackY)
        if (y == null) continue
        // When the shared layout pushes a caption away from its band, keep
        // the connection visible with a hairline leader.
        if (Math.abs(y - job.zoneTop) > 4) {
          const link = document.createElement('div')
          const top = Math.min(y, job.zoneTop)
          const height = Math.abs(y - job.zoneTop)
          link.style.cssText = `
            position: absolute;
            left: ${job.anchorX + 5}px;
            top: ${top}px;
            width: 0;
            height: ${height}px;
            border-left: 1px dashed ${job.hue};
            opacity: 0.75;
            pointer-events: none;
          `
          overlay.appendChild(link)
        }
        const pill = document.createElement('div')
        pill.textContent = job.text
        pill.style.cssText = `${job.css} top: ${y}px;`
        overlay.appendChild(pill)
      }
      } catch {
        /* overlay must never kill the chart */
      }
    }

    const onLayout = () => {
      fromListenerRef.current = true
      try {
        redraw()
      } finally {
        fromListenerRef.current = false
      }
    }

    redrawRef.current = redraw
    redraw()

    const unsub = watchLayer(layout, 'chart-zones', onLayout)

    return () => {
      unsub()
      layout.clear('chart-zones')
      redrawRef.current = () => {}
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
    layout,
  ])

  useViewportRedraw(
    chart,
    containerRef.current,
    () => redrawRef.current(),
    { interactingRef, crosshair: false }
  )

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 8 }}
    />
  )
}

export default ChartOverlay
