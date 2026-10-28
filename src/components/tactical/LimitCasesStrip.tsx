/**
 * Компактная лента «сундучков» под графиком — чтобы на телефоне
 * отложенные лимитки были видны даже при маленьком масштабе.
 */

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
    <div className="border-t border-white/[0.06] bg-[#0d1117]/80 px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-amber-200/80">
          🧰 Кейсы · лимитки на отскок
        </span>
        <span className="font-mono text-[8px] text-slate-500">цель 1–5 %</span>
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
              className={`flex shrink-0 flex-col rounded-md border px-2 py-1 text-left ${
                active
                  ? 'border-amber-300/80 bg-amber-500/15'
                  : 'border-white/10 bg-white/[0.03]'
              }`}
            >
              <span
                className="font-mono text-[9px] font-bold"
                style={{ color: long ? '#34d399' : '#fb7185' }}
              >
                {long ? 'лонг' : 'шорт'} · {item.movePct.toFixed(1)}%
              </span>
              <span className="font-mono text-[8px] text-slate-400">
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
