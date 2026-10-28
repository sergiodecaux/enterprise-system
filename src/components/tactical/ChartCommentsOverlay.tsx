/**
 * Комментарии на графике — короткие русские карточки-пины.
 * Позиции пересчитываются при pan / zoom / повороте экрана, чтобы
 * комментарии не «залипали» на старых координатах и не исчезали.
 */

import { useEffect, useState } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { ChartComment } from '../../engine/smc/chartStory'

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
  maxW: number
  comment: ChartComment
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n))
}

function palette(side: ChartComment['side'], kind: ChartComment['kind']): {
  border: string
  title: string
  pin: string
  bg: string
} {
  if (kind === 'ENTRY') {
    return side === 'SHORT'
      ? {
          border: 'rgba(251, 113, 133, 0.75)',
          title: 'rgba(254, 205, 211, 1)',
          pin: 'rgba(251, 113, 133, 0.98)',
          bg: 'rgba(32, 14, 18, 0.94)',
        }
      : {
          border: 'rgba(45, 212, 191, 0.75)',
          title: 'rgba(167, 243, 208, 1)',
          pin: 'rgba(45, 212, 191, 0.98)',
          bg: 'rgba(9, 30, 27, 0.94)',
        }
  }
  if (kind === 'EVENT') {
    return {
      border: 'rgba(251, 191, 36, 0.7)',
      title: 'rgba(253, 230, 138, 1)',
      pin: 'rgba(251, 191, 36, 0.98)',
      bg: 'rgba(36, 28, 8, 0.94)',
    }
  }
  if (kind === 'DAILY') {
    return {
      border: 'rgba(167, 139, 250, 0.65)',
      title: 'rgba(221, 214, 254, 1)',
      pin: 'rgba(167, 139, 250, 0.95)',
      bg: 'rgba(24, 18, 40, 0.94)',
    }
  }
  if (kind === 'FUEL') {
    return {
      border: 'rgba(96, 165, 250, 0.7)',
      title: 'rgba(191, 219, 254, 1)',
      pin: 'rgba(96, 165, 250, 0.98)',
      bg: 'rgba(10, 22, 38, 0.94)',
    }
  }
  return {
    border: 'rgba(125, 211, 252, 0.7)',
    title: 'rgba(224, 242, 254, 1)',
    pin: 'rgba(56, 189, 248, 0.98)',
    bg: 'rgba(10, 24, 34, 0.94)',
  }
}

function readableRussian(text: string): string {
  return text
    .replace(/\bSHORT\b/g, 'шорт')
    .replace(/\bLONG\b/g, 'лонг')
    .replace(/\bSHORTу\b/gi, 'шорту')
    .replace(/\bLONGу\b/gi, 'лонгу')
}

function computePins(
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  box: HTMLDivElement,
  comments: ChartComment[],
  lastPrice: number,
  compactPins: boolean,
  openId: string | null
): PinLayout[] {
  const w = box.clientWidth
  const h = box.clientHeight
  if (w < 80 || h < 40 || !comments.length) return []

  const maxW = Math.max(150, Math.min(compactPins ? 236 : 248, w * 0.62))
  const yOf = (price: number): number => {
    try {
      const y = series.priceToCoordinate(price)
      if (y != null && Number.isFinite(Number(y))) return Number(y)
    } catch {
      /* chart may be disposed mid-orientation */
    }
    return price >= lastPrice ? 22 : h - 28
  }
  const xOf = (timeSec?: number): number => {
    if (timeSec != null) {
      try {
        const x = chart.timeScale().timeToCoordinate(timeSec as never)
        if (x != null && Number.isFinite(Number(x))) return Number(x)
      } catch {
        /* ignore */
      }
    }
    return w * 0.72
  }

  const used: number[] = []
  return comments.map((c) => {
    const open = !compactPins || openId === c.id
    // Запас по высоте: длинный русский текст не должен обрезаться
    // нижней границей графика.
    const pinH = open ? 76 : 22
    const rawY = yOf(c.price)
    let y = clamp(rawY, 8, h - pinH - 8)
    for (let i = 0; i < 8; i++) {
      if (!used.some((u) => Math.abs(u - y) < pinH + 6)) break
      y = clamp(y + pinH + 8, 8, h - pinH - 8)
    }
    used.push(y)
    const x = clamp(xOf(c.timeSec), 8, w - maxW - 10)
    return { id: c.id, x, y, maxW, comment: c }
  })
}

const ChartCommentsOverlay = ({
  chart,
  series,
  containerRef,
  comments,
  lastPrice,
  compactPins,
}: Props) => {
  const [openId, setOpenId] = useState<string | null>('now')
  const [, setViewportVersion] = useState(0)

  useEffect(() => {
    if (!chart) return
    const scale = chart.timeScale()
    const update = () => setViewportVersion((v) => v + 1)
    scale.subscribeVisibleLogicalRangeChange(update)
    const box = containerRef.current
    const observer = box ? new ResizeObserver(update) : null
    if (box) observer?.observe(box)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      scale.unsubscribeVisibleLogicalRangeChange(update)
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [chart, containerRef])

  const box = containerRef.current
  let pins: PinLayout[] = []
  if (chart && series && box) {
    try {
      pins = computePins(
        chart,
        series,
        box,
        comments,
        lastPrice,
        compactPins,
        openId
      )
    } catch {
      pins = []
    }
  }

  if (!comments.length || !pins.length) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[11] overflow-visible">
      {pins.map((pin) => {
        const showBody = !compactPins || openId === pin.id
        const colors = palette(pin.comment.side, pin.comment.kind)
        const title = readableRussian(pin.comment.title)
        return (
          <button
            key={pin.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setOpenId((cur) => (cur === pin.id ? null : pin.id))
            }}
            className="absolute text-left"
            style={{
              left: pin.x,
              top: pin.y,
              maxWidth: pin.maxW,
              pointerEvents: 'auto',
            }}
            title={readableRussian(pin.comment.text)}
          >
            <span
              className="inline-flex items-start gap-1 rounded-[4px] border px-1.5 py-1 shadow-[0_4px_14px_rgba(0,0,0,0.45)] backdrop-blur-sm"
              style={{
                borderColor: colors.border,
                borderLeft: `3px solid ${colors.pin}`,
                background: colors.bg,
              }}
            >
              <span
                className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: colors.pin }}
              />
              <span className="min-w-0">
                <span
                  className="block whitespace-nowrap font-mono text-[10px] font-bold leading-tight"
                  style={{ color: colors.title }}
                >
                  {compactPins && !showBody
                    ? `${title.slice(0, 26)}${title.length > 26 ? '…' : ''}`
                    : title}
                </span>
                {showBody && (
                  <span className="mt-0.5 block font-mono text-[9.5px] leading-snug text-white/70">
                    {readableRussian(pin.comment.text)}
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
