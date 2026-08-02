import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { SequenceHit } from '../../engine/sequence'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  sequence: SequenceHit | null
}

/**
 * Remizov process on the chart: absorption band at wall + "предел" marker.
 * Does not use price lines (no autoscale stretch).
 */
const SequenceProcessOverlay = ({
  chart,
  series,
  containerRef,
  sequence,
}: Props) => {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    if (
      !overlay ||
      !chart ||
      !series ||
      !containerRef.current ||
      !sequence ||
      sequence.expiresAt < Date.now()
    ) {
      if (overlay) overlay.innerHTML = ''
      return
    }

    const redraw = () => {
      const box = containerRef.current
      if (!box) return
      const h = box.clientHeight
      const w = box.clientWidth
      overlay.innerHTML = ''

      const isLong = sequence.side === 'LONG'
      const accent = isLong
        ? 'rgba(34, 211, 238, 0.95)'
        : 'rgba(251, 146, 60, 0.95)'
      const soft = isLong
        ? 'rgba(34, 211, 238, 0.14)'
        : 'rgba(251, 146, 60, 0.14)'

      let y: number | null = null
      if (sequence.wallPrice != null && sequence.wallPrice > 0) {
        const yCoord = series.priceToCoordinate(sequence.wallPrice)
        if (yCoord != null && !Number.isNaN(Number(yCoord))) {
          y = Math.max(16, Math.min(h - 16, Number(yCoord)))
        }
      }
      if (y == null) {
        // No wall price — pin marker mid-right
        y = isLong ? h * 0.62 : h * 0.38
      }

      // Hit / absorption band around wall — thicker when more USD slammed
      if (sequence.wallPrice != null) {
        const heat = Math.min(1, (sequence.hitUsd || 0) / 3_000_000)
        const bandH = 22 + Math.round(heat * 22)
        const band = document.createElement('div')
        band.style.cssText = `
          position: absolute;
          left: 0;
          right: 48px;
          top: ${Math.max(0, y - bandH / 2)}px;
          height: ${bandH}px;
          background: linear-gradient(90deg, transparent 0%, ${soft} 20%, rgba(255,255,255,${0.04 + heat * 0.08}) 55%, ${soft} 100%);
          border-top: 1px solid ${accent};
          border-bottom: 1px solid ${accent};
          box-shadow: inset 0 0 ${8 + heat * 20}px ${soft};
          opacity: ${0.75 + heat * 0.25};
          pointer-events: none;
          z-index: 2;
        `
        overlay.appendChild(band)

        if (sequence.hitUsd > 0) {
          const heatLabel = document.createElement('div')
          heatLabel.style.cssText = `
            position: absolute;
            left: 8px;
            top: ${Math.max(2, y - bandH / 2 - 14)}px;
            z-index: 3;
            pointer-events: none;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 8px;
            font-weight: 700;
            color: ${accent};
            opacity: 0.85;
          `
          const hitStr =
            sequence.hitUsd >= 1e6
              ? `$${(sequence.hitUsd / 1e6).toFixed(2)}M`
              : `$${(sequence.hitUsd / 1e3).toFixed(0)}K`
          heatLabel.textContent = `удары ${hitStr}`
          overlay.appendChild(heatLabel)
        }
      }

      // Limit pulse marker
      const mark = document.createElement('div')
      mark.style.cssText = `
        position: absolute;
        left: ${Math.max(8, w * 0.42)}px;
        top: ${y - 16}px;
        z-index: 6;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      `
      const allowed = sequence.allowedInRegime
      mark.innerHTML = `
        <div style="
          display:inline-flex;align-items:center;gap:6px;
          padding:4px 8px;border-radius:7px;
          border:1px solid ${accent};
          background:rgba(6,8,12,0.9);
          backdrop-filter:blur(8px);
          box-shadow:0 0 16px ${soft}, 0 2px 8px rgba(0,0,0,0.5);
          font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          white-space:nowrap;
        ">
          <span style="
            width:7px;height:7px;border-radius:99px;background:${accent};
            box-shadow:0 0 8px ${accent};
            ${allowed ? 'animation:none;' : 'opacity:0.5;'}
          "></span>
          <span style="font-size:9px;font-weight:800;letter-spacing:0.04em;color:${accent};">
            МОМЕНТ
          </span>
          <span style="font-size:10px;font-weight:700;color:rgba(240,245,250,0.92);">
            ${sequence.side === 'LONG' ? 'вверх ↑' : 'вниз ↓'}
          </span>
          <span style="font-size:9px;color:rgba(200,210,220,0.55);">
            ~${sequence.confidence}%
          </span>
        </div>
        <div style="
          max-width:min(240px,58vw);
          font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:8px;line-height:1.35;
          color:rgba(200,210,220,0.55);
          padding-left:2px;
        ">${escapeHtml(kindRu(sequence.kind))}${
          allowed ? '' : ' · сейчас не входим (режим)'
        }</div>
      `
      overlay.appendChild(mark)
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
  }, [chart, series, containerRef, sequence])

  if (!sequence || sequence.expiresAt < Date.now()) return null

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 z-[6] overflow-hidden"
      aria-hidden
    />
  )
}

function kindRu(kind: string): string {
  switch (kind) {
    case 'WALL_ABSORPTION_EXHAUSTION':
      return 'Стена выдержала удары — агрессия стихает'
    case 'CVD_DIVERGENCE_LIMIT':
      return 'Цена и поток сделок разошлись'
    case 'WALL_RELEASE':
      return 'Крупную стену сняли — путь открыт'
    case 'OI_DELTA_CONFIRM':
      return 'Цена и контракты идут вместе'
    default:
      return kind.replace(/_/g, ' ')
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export default SequenceProcessOverlay
