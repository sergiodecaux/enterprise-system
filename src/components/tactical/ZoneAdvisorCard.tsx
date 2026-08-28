/**
 * Compact advisor sheet after tapping a zone.
 */

import type { ZoneAdvisorBrief } from '../../engine/smc/zoneAdvisor'

interface Props {
  brief: ZoneAdvisorBrief
  botStatus: 'idle' | 'sent' | 'fail'
  onClose: () => void
}

function px(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

const ZoneAdvisorCard = ({ brief, botStatus, onClose }: Props) => {
  const a = brief.primary
  const b = brief.alternate
  const up = a.side === 'LONG'

  return (
    <div className="pointer-events-auto absolute bottom-1 left-1 right-14 z-30 rounded-lg border border-white/15 bg-[#10141ae6] px-2.5 py-2 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`font-mono text-[10px] font-bold uppercase ${
                up ? 'text-emerald-300' : 'text-rose-300'
              }`}
            >
              {a.side === 'LONG' ? 'лонг' : 'шорт'} {a.probability}%
            </span>
            <span className="font-mono text-[10px] text-white/40">
              слом {b.probability}%
            </span>
            {botStatus === 'sent' && (
              <span className="font-mono text-[9px] text-cyan-300/80">в бота</span>
            )}
            {botStatus === 'fail' && (
              <span className="font-mono text-[9px] text-amber-300/80">бот недоступен</span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[10px] leading-snug text-white/70">
            {a.wait}
          </p>
          <p className="mt-1 font-mono text-[10px] text-white/55">
            вход {px(a.entry)} · {a.invalidationHint}
          </p>
          <p className="font-mono text-[10px] text-white/55">
            цель {px(a.targetPrice)} · {a.targetLabel}
            {a.magnetPrice != null ? ` · дальше ${px(a.magnetPrice)}` : ''}
          </p>
          <p className="mt-0.5 font-mono text-[9px] leading-snug text-white/40">
            Если сломают: {b.title} → {px(b.targetPrice)} ({b.targetLabel})
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-white/45 hover:text-white"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

export default ZoneAdvisorCard
