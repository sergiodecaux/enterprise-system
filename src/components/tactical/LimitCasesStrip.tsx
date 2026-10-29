/**
 * Компактная лента «сундучков» под графиком — чтобы на телефоне
 * отложенные лимитки были видны даже при маленьком масштабе.
 */

import { Package } from 'lucide-react'
import type { LimitCase } from '../../engine/trades/limitCases'

interface Props {
  cases: LimitCase[]
  selectedId: string | null
  onSelect: (item: LimitCase) => void
}

function fmtPx(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

const LimitCasesStrip = ({ cases, selectedId, onSelect }: Props) => {
  if (!cases.length) return null
  return (
    <div className="border-t border-border bg-bg-base/85 px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-sans text-[11px] font-medium leading-4 text-market-warning">
          <Package className="h-3 w-3 shrink-0" />
          Кейсы · лимитки на отскок
        </span>
        <span className="shrink-0 font-mono text-[11px] leading-4 text-text-muted">
          цель 1–5 %
        </span>
      </div>
      <div className="flex gap-1.5 overflow-x-auto overscroll-contain pb-0.5">
        {cases.map((item) => {
          const long = item.side === 'LONG'
          const active = item.id === selectedId
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item)}
              className={`flex shrink-0 flex-col rounded-sm border px-2 py-1 text-left transition-colors ${
                active
                  ? 'border-market-warning/50 bg-market-warning/10'
                  : 'border-border bg-bg-panel hover:border-border-active'
              }`}
            >
              <span
                className={`font-mono text-[11px] font-medium leading-4 ${
                  long ? 'text-market-long' : 'text-market-short'
                }`}
              >
                {long ? 'лонг' : 'шорт'} · {item.movePct.toFixed(1)}%
              </span>
              <span className="tnum font-mono text-[11px] leading-4 text-text-muted">
                лимит {fmtPx(item.entry)} · шанс {item.probability}%
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default LimitCasesStrip
