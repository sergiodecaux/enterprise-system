import { useEffect, useMemo, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Fish,
  Zap,
} from 'lucide-react'
import type { OhlcvCandle } from '../../api/mexc'
import {
  detectDominantWhaleTrap,
  type WhalePosition,
} from './whaleTrap/whaleTrapModel'

interface WhaleTrapOverlayProps {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  candles: OhlcvCandle[]
  currentPrice: number
  symbol: string
  visible: boolean
}

interface OverlayFrame {
  width: number
  plotRight: number
  plotBottom: number
  entryY: number
  liqY: number
  currentY: number | null
}

const LONG_COLOR = '#2DD4BF'
const SHORT_COLOR = '#FB7185'
const WARNING_COLOR = '#F5B942'
const CHART_BG = '#0B0E13'

function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1000) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }
  if (value >= 1) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    })
  }
  if (value >= 0.01) return value.toFixed(5)
  return value.toPrecision(5)
}

function formatAxisPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1000) return value.toFixed(2)
  if (value >= 1) return value.toFixed(4)
  if (value >= 0.01) return value.toFixed(5)
  return value.toPrecision(5)
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${Math.round(abs / 1_000)}k`
  return `$${Math.round(abs)}`
}

function formatPnl(value: number): string {
  return `${value < 0 ? '−' : '+'}${formatUsd(value)}`
}

function isSameFrame(
  previous: OverlayFrame | null,
  next: OverlayFrame
): boolean {
  return Boolean(
    previous &&
      previous.width === next.width &&
      previous.plotRight === next.plotRight &&
      previous.plotBottom === next.plotBottom &&
      previous.entryY === next.entryY &&
      previous.liqY === next.liqY &&
      previous.currentY === next.currentY
  )
}

/**
 * Chart-only Whale Trap / liquidation magnet layer.
 *
 * It never writes to the signal engine. Coordinates are recomputed on pan,
 * zoom, crosshair movement and container resize, then rendered as absolutely
 * positioned DOM above the lightweight-charts canvas.
 */
const WhaleTrapOverlay = ({
  chart,
  series,
  containerRef,
  candles,
  currentPrice,
  symbol,
  visible,
}: WhaleTrapOverlayProps) => {
  const [frame, setFrame] = useState<OverlayFrame | null>(null)
  const whale = useMemo(
    () =>
      visible
        ? detectDominantWhaleTrap(candles, currentPrice, symbol)
        : null,
    [candles, currentPrice, symbol, visible]
  )
  const whaleRef = useRef<WhalePosition | null>(whale)
  whaleRef.current = whale
  const currentPriceRef = useRef(currentPrice)
  currentPriceRef.current = currentPrice
  const paintRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const box = containerRef.current
    if (!visible || !chart || !series || !box) {
      paintRef.current = null
      setFrame(null)
      return
    }

    let alive = true
    let raf = 0
    const timeScale = chart.timeScale()

    const paint = () => {
      if (!alive) return
      const host = containerRef.current
      const position = whaleRef.current
      if (!host || !position) {
        setFrame(null)
        return
      }

      const width = host.clientWidth
      const height = host.clientHeight
      if (width < 80 || height < 40) {
        setFrame(null)
        return
      }

      let plotRight = width - 56
      try {
        const axisWidth = chart.priceScale('right').width()
        if (Number.isFinite(axisWidth) && axisWidth > 8) {
          plotRight = width - axisWidth
        }
      } catch {
        /* keep the conservative fallback */
      }

      let plotBottom = height
      try {
        const timeScaleHeight = timeScale.height()
        if (
          Number.isFinite(timeScaleHeight) &&
          timeScaleHeight > 0 &&
          timeScaleHeight < height
        ) {
          plotBottom = height - timeScaleHeight
        }
      } catch {
        /* keep the full height fallback */
      }

      const safePlotRight = Math.max(40, Math.min(width - 4, plotRight))
      const safePlotBottom = Math.max(40, Math.min(height - 4, plotBottom))

      const toY = (price: number): number | null => {
        try {
          const coordinate = series.priceToCoordinate(price)
          if (coordinate === null) return null
          const value = Number(coordinate)
          return Number.isFinite(value) ? value : null
        } catch {
          return null
        }
      }

      const entryY = toY(position.entryPrice)
      const liqY = toY(position.liqPrice)
      if (entryY === null || liqY === null) {
        setFrame(null)
        return
      }

      // Levels outside the viewport are expected: the render pass clamps them
      // to the plot edges and turns them into edge chips instead of hiding
      // the whole layer. priceToCoordinate keeps returning coordinates for
      // prices above/below the visible range, so no bail-out is needed here.
      const currentY = toY(currentPriceRef.current)
      const next: OverlayFrame = {
        width,
        plotRight: safePlotRight,
        plotBottom: safePlotBottom,
        entryY,
        liqY,
        currentY,
      }
      setFrame((previous) => (isSameFrame(previous, next) ? previous : next))
    }

    paintRef.current = paint

    const schedule = () => {
      if (raf !== 0) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        paint()
      })
    }

    timeScale.subscribeVisibleLogicalRangeChange(schedule)
    chart.subscribeCrosshairMove(schedule)

    const resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(box)

    paint()

    return () => {
      alive = false
      if (raf !== 0) window.cancelAnimationFrame(raf)
      paintRef.current = null
      timeScale.unsubscribeVisibleLogicalRangeChange(schedule)
      chart.unsubscribeCrosshairMove(schedule)
      resizeObserver.disconnect()
      setFrame(null)
    }
  }, [chart, series, containerRef, visible])

  useEffect(() => {
    if (!visible) return
    paintRef.current?.()
  }, [whale, currentPrice, visible])

  if (!visible || !whale || !frame) return null

  const { width, plotRight, plotBottom, entryY, liqY, currentY } = frame
  const compact = width < 600
  const axisWidth = Math.max(0, width - plotRight)
  const isLong = whale.side === 'LONG'
  const color = isLong ? LONG_COLOR : SHORT_COLOR
  const clampY = (value: number) =>
    Math.max(0, Math.min(value, plotBottom))
  const entryVisible = entryY >= 0 && entryY <= plotBottom
  const liqVisible = liqY >= 0 && liqY <= plotBottom
  const entryEdge: 'above' | 'below' | null = entryVisible
    ? null
    : entryY < 0
      ? 'above'
      : 'below'
  const liqEdge: 'above' | 'below' | null = liqVisible
    ? null
    : liqY < 0
      ? 'above'
      : 'below'
  const entryDrawY = clampY(entryY)
  const liqDrawY = clampY(liqY)
  const zoneTop = Math.min(entryDrawY, liqDrawY)
  const zoneHeight = Math.abs(liqDrawY - entryDrawY)
  const sameEdge = entryEdge !== null && entryEdge === liqEdge
  const liqChipOffset = sameEdge ? 34 : 4
  const hasZone = !sameEdge && zoneHeight >= 1
  const CHIP_HEIGHT = 26
  const topChipUsed = entryEdge === 'above' || liqEdge === 'above'
  const bottomChipUsed = entryEdge === 'below' || liqEdge === 'below'
  // Badge is 26px tall and centred with translateY(-50%). Keep its box clear
  // of the edge chips, which sit in the same left-hand column.
  const badgeHalf = 13
  const badgeMinY = 8 + badgeHalf + (topChipUsed ? CHIP_HEIGHT + 6 : 0)
  const badgeMaxY =
    plotBottom - 8 - badgeHalf - (bottomChipUsed ? CHIP_HEIGHT + 6 : 0)
  const badgeSpace = badgeMaxY - badgeMinY
  const zoneBadgeY = Math.max(
    badgeMinY,
    Math.min(zoneTop + zoneHeight / 2, badgeMaxY)
  )
  const cardHeight = Math.min(50, Math.max(28, plotBottom - 12))
  const cardTopLimit = Math.max(4, plotBottom - cardHeight - 4)
  const clampCardTop = (top: number) =>
    Math.max(4, Math.min(top, cardTopLimit))

  // Keep the cards outside the pain zone: entry above/below its line, and
  // liquidation on the opposite side. This prevents them colliding when a
  // 25–40x position has a very thin liquidation band.
  const entryCardTop = clampCardTop(
    isLong ? entryDrawY - cardHeight - 6 : entryDrawY + 6
  )
  const liqCardTop = clampCardTop(
    isLong ? liqDrawY + 6 : liqDrawY - cardHeight - 6
  )
  const cardRight = axisWidth + 8
  const cardMaxWidth = Math.max(
    160,
    Math.round(plotRight * (compact ? 0.72 : 0.46))
  )
  const zoneBadgeMaxWidth = Math.max(
    120,
    Math.round(plotRight * (compact ? 0.44 : 0.5))
  )
  const chipMaxWidth = Math.max(
    140,
    Math.round(plotRight * (compact ? 0.62 : 0.5))
  )
  // On phones the badge only appears when it has a clean channel: no edge
  // chips in the same column and enough band height to stay clear of cards.
  const showZoneBadge =
    hasZone &&
    badgeSpace >= 26 &&
    (compact ? !topChipUsed && !bottomChipUsed && zoneHeight >= 44 : true)
  const showEntryAxisLabel =
    entryVisible && axisWidth >= 24 && zoneHeight >= 22
  const showLiqAxisLabel = liqVisible && axisWidth >= 24

  const currentDrawY = currentY === null ? null : clampY(currentY)
  const distanceVisible =
    currentDrawY !== null &&
    currentY !== null &&
    currentY >= -2 &&
    currentY <= plotBottom + 2
  const rawDistance = distanceVisible
    ? Math.abs(liqDrawY - (currentDrawY as number))
    : 0
  const distanceHeight = distanceVisible ? Math.max(rawDistance, 24) : 0
  const distanceTop = distanceVisible
    ? Math.min(currentDrawY as number, liqDrawY) -
      (distanceHeight - rawDistance) / 2
    : 0
  // The measure rail sits just inside the price scale, clear of the cards
  // (they end 8px before the plot edge) and of the axis labels.
  const measureX = Math.max(18, plotRight - 4)
  const distanceLabelMaxWidth = Math.max(
    compact ? 160 : 180,
    Math.round(plotRight * 0.55)
  )
  const distanceEdgeHint =
    liqEdge === 'above' ? ' ↑' : liqEdge === 'below' ? ' ↓' : ''
  // Keep the distance pill out of the cards when the live price and the
  // liquidation level straddle them.
  const pillHalf = 10
  const pillPadding = 4
  const cardBoxes: Array<[number, number]> = []
  if (entryVisible) cardBoxes.push([entryCardTop, entryCardTop + cardHeight])
  if (liqVisible) cardBoxes.push([liqCardTop, liqCardTop + cardHeight])
  let pillCenter = distanceTop + distanceHeight / 2
  for (const [top, bottom] of cardBoxes) {
    if (
      pillCenter + pillHalf + pillPadding > top &&
      pillCenter - pillHalf - pillPadding < bottom
    ) {
      const below = bottom + pillHalf + pillPadding + 6
      const above = top - pillHalf - pillPadding - 6
      pillCenter =
        below + pillHalf <= distanceTop + distanceHeight ? below : above
    }
  }
  const pillTop = Math.max(
    distanceTop + pillHalf + 2,
    Math.min(pillCenter, distanceTop + distanceHeight - pillHalf - 2)
  )
  const pnlText = formatPnl(whale.unrealizedPnlUsd)
  const zoneState = compact
    ? pnlText
    : `${whale.isUnderwater ? 'UNDERWATER ' : ''}${pnlText}`

  return (
    <div
      data-whale-trap-overlay
      className="pointer-events-none absolute inset-0 z-20 select-none overflow-hidden"
      role="img"
      aria-label={`Ловушка кита: ${whale.side}, размер ${formatUsd(
        whale.sizeUsd
      )}, плечо ${whale.leverage}x, вход ${formatPrice(
        whale.entryPrice
      )}, ликвидация ${formatPrice(whale.liqPrice)}, ${whale.distancePct.toFixed(
        2
      )}% до ликвидации`}
    >
      {/* Pain zone: entry → liquidation, with a diagonal hazard hatch. */}
      {hasZone && (
        <div
          className="absolute left-0"
          style={{
            top: zoneTop,
            height: Math.max(zoneHeight, 1),
            width: plotRight,
            backgroundImage: `${
              isLong
                ? 'linear-gradient(180deg, rgba(45, 212, 191, 0.08) 0%, rgba(245, 185, 66, 0.12) 100%)'
                : 'linear-gradient(180deg, rgba(245, 185, 66, 0.12) 0%, rgba(251, 113, 133, 0.08) 100%)'
            }, repeating-linear-gradient(135deg, rgba(245, 185, 66, 0.11) 0px, rgba(245, 185, 66, 0.11) 1px, transparent 1px, transparent 7px)`,
            boxShadow: 'inset 0 0 0 1px rgba(245, 185, 66, 0.12)',
          }}
        />
      )}

      {/* Liquidation line — dashed amber. */}
      <div
        className="absolute left-0"
        style={{
          top: liqDrawY,
          width: plotRight,
          height: 0,
          borderTop: `1.5px dashed ${WARNING_COLOR}`,
          opacity: 0.9,
        }}
      />

      {/* Whale entry line — side colour. */}
      <div
        className="absolute left-0"
        style={{
          top: entryDrawY,
          width: plotRight,
          height: 1.5,
          backgroundColor: color,
          boxShadow: `0 0 10px ${color}55`,
        }}
      />

      {showZoneBadge && (
        <div
          className="absolute z-20 inline-flex max-w-full items-center gap-1.5 rounded border border-market-warning/35 bg-bg-panel/95 px-2 py-1 shadow-[0_8px_22px_rgba(0,0,0,0.45)] backdrop-blur-sm"
          style={{
            left: 10,
            top: zoneBadgeY,
            transform: 'translateY(-50%)',
            maxWidth: zoneBadgeMaxWidth,
          }}
        >
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-market-warning" />
          <AlertTriangle className="h-3 w-3 shrink-0 text-market-warning" />
          <span className="shrink-0 truncate font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-market-warning">
            {compact ? 'ЗОНА БОЛИ' : 'ЗОНА БОЛИ КИТА'}
          </span>
          {!compact && (
            <span className="truncate font-mono text-[11px] font-bold tabular-nums text-text-primary/90">
              {zoneState}
            </span>
          )}
        </div>
      )}

      {/* Entry card near the right edge of the plot, or an edge chip when the
          entry candle is outside the visible price range. */}
      {entryVisible ? (
        <div
          className="absolute z-30 overflow-hidden"
          style={{
            right: cardRight,
            top: entryCardTop,
            maxWidth: cardMaxWidth,
          }}
        >
          <div
            className="rounded-md border bg-bg-panel/95 px-2.5 py-1.5 shadow-[0_10px_26px_rgba(0,0,0,0.5)] backdrop-blur-md"
            style={{ borderColor: `${color}66` }}
          >
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <Fish
                className="h-3.5 w-3.5 shrink-0"
                style={{ color }}
                strokeWidth={2}
              />
              <span
                className="font-mono text-[11px] font-bold uppercase tracking-[0.06em]"
                style={{ color }}
              >
                {isLong ? 'ЛОНГ КИТА' : 'ШОРТ КИТА'}
              </span>
              <span className="font-mono text-[11px] font-bold tabular-nums text-text-primary">
                {formatUsd(whale.sizeUsd)} × {whale.leverage}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums text-text-secondary">
              <span>
                вход{' '}
                <span className="text-text-primary">
                  {formatPrice(whale.entryPrice)}
                </span>
              </span>
              <span className="text-text-muted">·</span>
              <span>
                ликв.{' '}
                <span className="text-market-warning">
                  {formatPrice(whale.liqPrice)}
                </span>
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="absolute z-30 inline-flex items-center gap-1.5 overflow-hidden rounded-md border bg-bg-panel/95 px-2 py-1 shadow-[0_8px_22px_rgba(0,0,0,0.45)] backdrop-blur-md"
          style={{
            left: 10,
            top: entryEdge === 'above' ? 4 : undefined,
            bottom: entryEdge === 'below' ? 4 : undefined,
            maxWidth: chipMaxWidth,
            borderColor: `${color}66`,
          }}
        >
          <Fish
            className="h-3 w-3 shrink-0"
            style={{ color }}
            strokeWidth={2}
          />
          <span
            className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-[0.06em]"
            style={{ color }}
          >
            Вход
          </span>
          <span className="truncate font-mono text-[11px] font-bold tabular-nums text-text-primary">
            {formatPrice(whale.entryPrice)}
          </span>
          {entryEdge === 'above' ? (
            <ChevronUp
              className="h-3 w-3 shrink-0"
              style={{ color }}
              strokeWidth={2.5}
            />
          ) : (
            <ChevronDown
              className="h-3 w-3 shrink-0"
              style={{ color }}
              strokeWidth={2.5}
            />
          )}
        </div>
      )}

      {/* Liquidation card on the opposite side of the band, or an edge chip
          when the derived liquidation level is outside the price range. */}
      {liqVisible ? (
        <div
          className="absolute z-30 overflow-hidden"
          style={{
            right: cardRight,
            top: liqCardTop,
            maxWidth: cardMaxWidth,
          }}
        >
          <div className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-market-warning/40 bg-bg-panel/95 px-2.5 py-1.5 shadow-[0_10px_26px_rgba(0,0,0,0.5)] backdrop-blur-md">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-market-warning" />
            <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-market-warning">
              Ликвидация
            </span>
            <span className="truncate font-mono text-[11px] font-bold tabular-nums text-text-primary">
              {formatPrice(whale.liqPrice)}
            </span>
          </div>
        </div>
      ) : (
        <div
          className="absolute z-30 inline-flex items-center gap-1.5 overflow-hidden rounded-md border border-market-warning/40 bg-bg-panel/95 px-2 py-1 shadow-[0_8px_22px_rgba(0,0,0,0.45)] backdrop-blur-md"
          style={{
            left: 10,
            top: liqEdge === 'above' ? liqChipOffset : undefined,
            bottom: liqEdge === 'below' ? liqChipOffset : undefined,
            maxWidth: chipMaxWidth,
          }}
        >
          <AlertTriangle className="h-3 w-3 shrink-0 text-market-warning" />
          <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-market-warning">
            Ликв.
          </span>
          <span className="truncate font-mono text-[11px] font-bold tabular-nums text-text-primary">
            {formatPrice(whale.liqPrice)}
          </span>
          {liqEdge === 'above' ? (
            <ChevronUp
              className="h-3 w-3 shrink-0 text-market-warning"
              strokeWidth={2.5}
            />
          ) : (
            <ChevronDown
              className="h-3 w-3 shrink-0 text-market-warning"
              strokeWidth={2.5}
            />
          )}
        </div>
      )}

      {/* Price-scale labels, anchored to the real axis width. */}
      {showEntryAxisLabel && (
        <div
          className="absolute z-20 overflow-hidden rounded-l px-1 text-center font-mono text-[11px] font-bold leading-[18px] tabular-nums"
          style={{
            left: plotRight + 2,
            top: entryDrawY - 9,
            width: Math.max(20, axisWidth - 4),
            height: 18,
            backgroundColor: color,
            color: CHART_BG,
          }}
        >
          {formatAxisPrice(whale.entryPrice)}
        </div>
      )}
      {showLiqAxisLabel && (
        <div
          className="absolute z-20 overflow-hidden rounded-l px-1 text-center font-mono text-[11px] font-bold leading-[18px] tabular-nums"
          style={{
            left: plotRight + 2,
            top: liqDrawY - 9,
            width: Math.max(20, axisWidth - 4),
            height: 18,
            backgroundColor: WARNING_COLOR,
            color: CHART_BG,
          }}
        >
          {formatAxisPrice(whale.liqPrice)}
        </div>
      )}

      {/* Distance from live price to the liquidation cascade. */}
      {distanceVisible && (
        <div
          className="absolute z-30"
          style={{
            left: measureX - 12,
            top: distanceTop,
            width: 24,
            height: distanceHeight,
          }}
        >
          <ChevronUp
            className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 text-market-warning"
            strokeWidth={2.5}
          />
          <div className="absolute bottom-1.5 left-1/2 top-1.5 w-px -translate-x-1/2 bg-market-warning/60" />
          <ChevronDown
            className="absolute bottom-0 left-1/2 h-2 w-2 -translate-x-1/2 text-market-warning"
            strokeWidth={2.5}
          />
          <div
            className="absolute flex -translate-y-1/2 items-center gap-1 overflow-hidden rounded-full bg-market-warning px-2 py-0.5 shadow-[0_4px_14px_rgba(0,0,0,0.45)]"
            style={{
              right: 20,
              top: pillTop - distanceTop,
              maxWidth: distanceLabelMaxWidth,
            }}
          >
            <Zap className="h-3 w-3 shrink-0" strokeWidth={2.5} />
            <span
              className="truncate whitespace-nowrap font-mono text-[11px] font-bold tabular-nums"
              style={{ color: CHART_BG }}
            >
              {whale.distancePct.toFixed(2)}%{' '}
              {compact ? 'до ликв.' : 'до ликвидации'}
              {distanceEdgeHint}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export default WhaleTrapOverlay
