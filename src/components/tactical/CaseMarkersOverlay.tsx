/**
 * 🧰 «Сундучки» на графике — отложенные лимитки на отскок от важных зон.
 * Позиция пересчитывается при pan / zoom / повороте экрана.
 */

import { useEffect, useState } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { LimitCase } from '../../engine/trades/limitCases'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  cases: LimitCase[]
  selectedId: string | null
  dense?: boolean
  onSelect: (item: LimitCase, x: number, y: number) => void
}

function fmtPx(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

const CaseMarkersOverlay = ({
  chart,
  series,
  containerRef,
  cases,
  selectedId,
  dense = false,
  onSelect,
}: Props) => {
  const [, setVersion] = useState(0)

  useEffect(() => {
    if (!chart) return
    const scale = chart.timeScale()
    const update = () => setVersion((v) => v + 1)
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

  if (!chart || !series || !containerRef.current || !cases.length) return null
  const box = containerRef.current
  const width = box.clientWidth
  const height = box.clientHeight
  if (width < 80 || height < 60) return null

  let priceScaleW = 56
  try {
    const w = chart.priceScale('right').width()
    if (typeof w === 'number' && w > 8) priceScaleW = w
  } catch {
    /* ignore */
  }

  const cardW = dense ? 128 : 172
  const left = Math.max(6, width - priceScaleW - cardW - 6)
  const usedY: number[] = []

  return (
    <div className="pointer-events-none absolute inset-0 z-[13] overflow-visible">
      {cases.map((item) => {
        let rawY: number | null = null
        try {
          const coord = series.priceToCoordinate(item.entry)
          rawY = coord != null && Number.isFinite(Number(coord)) ? Number(coord) : null
        } catch {
          /* chart may be disposed mid-orientation */
        }
        if (rawY == null) return null
        let y = Math.max(26, Math.min(height - 26, rawY))
        for (let i = 0; i < 6 && usedY.some((u) => Math.abs(u - y) < 34); i++) {
          y = Math.max(26, Math.min(height - 26, y + 34))
        }
        usedY.push(y)

        const active = item.id === selectedId
        const long = item.side === 'LONG'
        const tone = long ? '#34d399' : '#fb7185'

        return (
          <button
            key={item.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onSelect(item, left, y)
            }}
            className={`pointer-events-auto absolute flex items-center gap-1 rounded-md border px-1.5 py-1 text-left shadow-[0_6px_18px_rgba(0,0,0,0.5)] backdrop-blur-sm transition-colors ${
              active
                ? 'border-amber-300/90 bg-[#2b2110]/95'
                : 'border-amber-400/45 bg-[#141310]/92 hover:border-amber-300/80'
            }`}
            style={{
              left,
              top: y,
              width: cardW,
              transform: 'translateY(-50%)',
            }}
            title={`${long ? 'Лимитная покупка' : 'Лимитная продажа'} · вход ${fmtPx(item.entry)} · цель ${fmtPx(item.target)} · ход ${item.movePct.toFixed(2)}% · оценка модели ${item.probability}%`}
          >
            <span className="text-[15px] leading-none" aria-hidden="true">🧰</span>
            <span className="min-w-0 flex-1">
              <span
                className="block truncate font-mono text-[9px] font-bold uppercase tracking-wide"
                style={{ color: tone }}
              >
                {long ? 'лонг' : 'шорт'} · цель {item.movePct.toFixed(1)}%
              </span>
              <span className="mt-0.5 block truncate font-mono text-[8.5px] leading-tight text-amber-100/75">
                лимит {fmtPx(item.entry)} · шанс {item.probability}%
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export default CaseMarkersOverlay
