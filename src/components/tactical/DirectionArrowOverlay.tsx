import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { DirectionConsensus } from '../../engine/trend/directionConsensus'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  consensus: DirectionConsensus
  lastTime: number
  lastPrice: number
  visible: boolean
}

/**
 * Стрелка направления + краткие голоса факторов у правого края графика.
 */
const DirectionArrowOverlay = ({
  chart,
  series,
  containerRef,
  consensus,
  lastTime,
  lastPrice,
  visible,
}: Props) => {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (
      !visible ||
      !chart ||
      !series ||
      !overlayRef.current ||
      !containerRef.current ||
      !(lastPrice > 0)
    ) {
      if (overlayRef.current) overlayRef.current.innerHTML = ''
      return
    }

    const overlay = overlayRef.current
    const timeScale = chart.timeScale()

    const redraw = () => {
      overlay.innerHTML = ''
      const h = containerRef.current!.clientHeight
      const w = containerRef.current!.clientWidth
      const yCoord = series.priceToCoordinate(lastPrice)
      const yNum = Math.max(
        36,
        Math.min(h - 48, yCoord == null ? h * 0.45 : Number(yCoord))
      )

      const xCoord = timeScale.timeToCoordinate(lastTime as Time)
      const xNum =
        xCoord == null
          ? w - 72
          : Math.min(w - 56, Math.max(48, Number(xCoord) + 28))

      const bias = consensus.bias
      const color =
        bias === 'UP'
          ? 'rgba(16, 185, 129, 0.95)'
          : bias === 'DOWN'
            ? 'rgba(244, 63, 94, 0.95)'
            : 'rgba(148, 163, 184, 0.9)'
      const glow =
        bias === 'UP'
          ? 'rgba(16, 185, 129, 0.35)'
          : bias === 'DOWN'
            ? 'rgba(244, 63, 94, 0.35)'
            : 'rgba(148, 163, 184, 0.25)'

      const wrap = document.createElement('div')
      wrap.style.cssText = `
        position: absolute;
        left: ${xNum - 22}px;
        top: ${bias === 'UP' ? yNum - 54 : bias === 'DOWN' ? yNum + 8 : yNum - 20}px;
        width: 44px;
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        filter: drop-shadow(0 0 10px ${glow});
      `

      const arrow = document.createElement('div')
      arrow.style.cssText = `
        width: 0; height: 0;
        border-left: 14px solid transparent;
        border-right: 14px solid transparent;
        ${
          bias === 'DOWN'
            ? `border-top: 28px solid ${color};`
            : bias === 'UP'
              ? `border-bottom: 28px solid ${color};`
              : `width: 22px; height: 6px; border: none; border-radius: 3px; background: ${color};`
        }
      `
      wrap.appendChild(arrow)

      if (bias !== 'FLAT') {
        const stem = document.createElement('div')
        stem.style.cssText = `
          width: 5px;
          height: 22px;
          margin-top: ${bias === 'UP' ? '-2px' : '0'};
          margin-bottom: ${bias === 'DOWN' ? '-2px' : '0'};
          background: ${color};
          border-radius: 2px;
          order: ${bias === 'UP' ? 1 : -1};
        `
        wrap.appendChild(stem)
        if (bias === 'UP') {
          wrap.insertBefore(stem, arrow)
        }
      }

      const conf = document.createElement('div')
      conf.textContent =
        bias === 'FLAT' ? '·' : `${consensus.confidence}`
      conf.style.cssText = `
        margin-top: 4px;
        font-family: ui-monospace, Menlo, monospace;
        font-size: 10px;
        font-weight: 700;
        color: ${color};
        text-shadow: 0 1px 3px rgba(0,0,0,0.9);
      `
      wrap.appendChild(conf)
      overlay.appendChild(wrap)

      // Factor chips — top-right
      const chips = document.createElement('div')
      chips.style.cssText = `
        position: absolute;
        top: 8px;
        right: 8px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 3px;
        max-width: 46%;
        pointer-events: none;
      `
      const head = document.createElement('div')
      head.textContent = consensus.summary
      head.style.cssText = `
        padding: 3px 7px;
        border-radius: 6px;
        font-family: ui-monospace, Menlo, monospace;
        font-size: 9px;
        font-weight: 700;
        color: #fff;
        background: rgba(0,0,0,0.72);
        border: 1px solid ${color};
        text-align: right;
        backdrop-filter: blur(3px);
      `
      chips.appendChild(head)

      for (const v of consensus.votes.slice(0, 5)) {
        const chip = document.createElement('div')
        const vc =
          v.side === 'UP'
            ? 'rgba(16,185,129,0.85)'
            : 'rgba(244,63,94,0.85)'
        chip.textContent = `${v.side === 'UP' ? '↑' : '↓'} ${v.label}`
        chip.title = v.reason
        chip.style.cssText = `
          padding: 1px 6px;
          border-radius: 4px;
          font-family: ui-monospace, Menlo, monospace;
          font-size: 8px;
          font-weight: 600;
          color: #f8fafc;
          background: rgba(0,0,0,0.55);
          border: 1px solid ${vc};
        `
        chips.appendChild(chip)
      }
      overlay.appendChild(chips)
    }

    redraw()
    const onVis = () => redraw()
    timeScale.subscribeVisibleLogicalRangeChange(onVis)
    chart.subscribeCrosshairMove(onVis)
    const ro = new ResizeObserver(() => redraw())
    ro.observe(containerRef.current)

    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(onVis)
      chart.unsubscribeCrosshairMove(onVis)
      ro.disconnect()
      overlay.innerHTML = ''
    }
  }, [
    visible,
    chart,
    series,
    containerRef,
    consensus,
    lastTime,
    lastPrice,
  ])

  if (!visible) return null

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 4 }}
    />
  )
}

export default DirectionArrowOverlay
