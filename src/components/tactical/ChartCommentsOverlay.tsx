/**
 * TradingView-style comment pins on the chart — short RU bubbles, not a sheet.
 * Expanded chart: collapsed pins, tap one to read.
 * Pin positions update via rAF (no React re-render on every pan).
 */

import { useEffect, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { ChartComment } from '../../engine/smc/chartStory'
import { useViewportRedraw } from './useViewportRedraw'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  comments: ChartComment[]
  lastPrice: number
  /** Expanded / exchange view — pins only until tapped */
  compactPins: boolean
  interactingRef?: React.MutableRefObject<boolean>
}

interface PinLayout {
  id: string
  x: number
  y: number
  comment: ChartComment
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n))
}

function palette(side: ChartComment['side'], kind: ChartComment['kind']): {
  border: string
  title: string
  pin: string
} {
  if (kind === 'ENTRY') {
    return side === 'SHORT'
      ? {
          border: 'rgba(251, 113, 133, 0.7)',
          title: 'rgba(254, 205, 211, 0.98)',
          pin: 'rgba(251, 113, 133, 0.95)',
        }
      : {
          border: 'rgba(45, 212, 191, 0.7)',
          title: 'rgba(167, 243, 208, 0.98)',
          pin: 'rgba(45, 212, 191, 0.95)',
        }
  }
  if (kind === 'EVENT') {
    return {
      border: 'rgba(251, 191, 36, 0.65)',
      title: 'rgba(253, 230, 138, 0.98)',
      pin: 'rgba(251, 191, 36, 0.95)',
    }
  }
  if (kind === 'DAILY') {
    return {
      border: 'rgba(167, 139, 250, 0.6)',
      title: 'rgba(221, 214, 254, 0.98)',
      pin: 'rgba(167, 139, 250, 0.92)',
    }
  }
  if (kind === 'FUEL') {
    return {
      border: 'rgba(96, 165, 250, 0.65)',
      title: 'rgba(191, 219, 254, 0.98)',
      pin: 'rgba(96, 165, 250, 0.95)',
    }
  }
  return {
    border: 'rgba(125, 211, 252, 0.65)',
    title: 'rgba(224, 242, 254, 0.98)',
    pin: 'rgba(56, 189, 248, 0.95)',
  }
}

function computePins(
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  box: HTMLDivElement,
  comments: ChartComment[],
  lastPrice: number
): PinLayout[] {
  const w = box.clientWidth
  const h = box.clientHeight
  if (w < 80 || h < 40 || !comments.length) return []

  const yOf = (price: number): number => {
    const y = series.priceToCoordinate(price)
    if (y != null && Number.isFinite(Number(y))) return Number(y)
    return price >= lastPrice ? 22 : h - 28
  }
  const xOf = (timeSec?: number): number => {
    if (timeSec != null) {
      const x = chart.timeScale().timeToCoordinate(timeSec as never)
      if (x != null && Number.isFinite(Number(x))) return Number(x)
    }
    return w * 0.72
  }

  const used: number[] = []
  const placeY = (raw: number): number => {
    let y = clamp(raw, 18, h - 22)
    for (let i = 0; i < 8; i++) {
      if (!used.some((u) => Math.abs(u - y) < 28)) break
      y = clamp(y + 28, 18, h - 22)
    }
    used.push(y)
    return y
  }

  return comments.map((c) => ({
    id: c.id,
    x: clamp(xOf(c.timeSec), 10, w - 36),
    y: placeY(yOf(c.price)),
    comment: c,
  }))
}

const ChartCommentsOverlay = ({
  chart,
  series,
  containerRef,
  comments,
  lastPrice,
  compactPins,
  interactingRef,
}: Props) => {
  const [openId, setOpenId] = useState<string | null>(null)
  const [pins, setPins] = useState<PinLayout[]>([])
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  const lastPriceRef = useRef(lastPrice)
  lastPriceRef.current = lastPrice

  useEffect(() => {
    if (!compactPins && comments[0]) setOpenId(null)
  }, [compactPins, comments])

  const redraw = () => {
    const box = containerRef.current
    if (!chart || !series || !box) {
      setPins([])
      return
    }
    setPins(
      computePins(chart, series, box, commentsRef.current, lastPriceRef.current)
    )
  }

  useEffect(() => {
    redraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, comments, lastPrice])

  useViewportRedraw(chart, containerRef.current, redraw, {
    interactingRef,
    crosshair: false,
  })

  if (!comments.length || !pins.length) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[9] overflow-hidden">
      {pins.map((pin) => {
        const open = compactPins ? openId === pin.id : openId === pin.id || openId == null
        const colors = palette(pin.comment.side, pin.comment.kind)
        const showBody = compactPins ? openId === pin.id : open
        return (
          <button
            key={pin.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setOpenId((cur) => (cur === pin.id ? null : pin.id))
            }}
            className="absolute max-w-[min(11.5rem,46%)] text-left"
            style={{
              left: pin.x,
              top: pin.y,
              transform: 'translate(-8px, -14px)',
              pointerEvents: 'auto',
            }}
            title={pin.comment.text}
          >
            <span
              className="inline-flex items-start gap-1 rounded-lg border px-1.5 py-0.5 shadow-md"
              style={{
                borderColor: colors.border,
                background: 'rgba(8, 10, 14, 0.88)',
              }}
            >
              <span
                className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: colors.pin }}
              />
              <span className="min-w-0">
                <span
                  className="block font-mono text-[10px] font-extrabold leading-tight"
                  style={{ color: colors.title }}
                >
                  {pin.comment.title}
                </span>
                {showBody && (
                  <span className="mt-0.5 block font-mono text-[10px] leading-snug text-holo/80">
                    {pin.comment.text}
                  </span>
                )}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export default ChartCommentsOverlay
