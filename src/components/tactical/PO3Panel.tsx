import type { PO3Analysis } from '../../engine/types'

interface Props {
  analysis: PO3Analysis
}

const PHASE_COLORS = {
  ACCUMULATION: {
    border: 'border-indigo-400/30',
    bg: 'bg-indigo-400/5',
    text: 'text-indigo-400',
  },
  MANIPULATION: {
    border: 'border-amber-400/30',
    bg: 'bg-amber-400/5',
    text: 'text-amber-400',
  },
  DISTRIBUTION: {
    border: 'border-matrix/30',
    bg: 'bg-matrix/5',
    text: 'text-matrix',
  },
  UNKNOWN: {
    border: 'border-hull-border',
    bg: 'bg-hull',
    text: 'text-holo/40',
  },
} as const

const PO3Panel = ({ analysis }: Props) => {
  if (!analysis.asiaBox && analysis.currentPhase === 'UNKNOWN') return null

  const colors = PHASE_COLORS[analysis.currentPhase]

  const formatPrice = (p: number) =>
    p >= 1000
      ? p.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : p >= 1
        ? p.toFixed(4)
        : p.toFixed(6)

  return (
    <div className={`rounded-xl border ${colors.border} ${colors.bg} p-3`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-base">{analysis.phaseIcon}</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Power of Three
        </span>
        <span
          className={`ml-auto rounded border ${colors.border} px-1.5 py-0.5 font-mono text-[10px] font-bold ${colors.text}`}
        >
          {analysis.currentPhase}
        </span>
      </div>

      <p className={`mb-2 font-mono text-xs font-medium ${colors.text}`}>
        {analysis.phaseLabel}
      </p>

      {analysis.asiaBox && (
        <div className="mb-2 rounded-lg bg-black/20 p-2">
          <div className="mb-1 font-mono text-[10px] uppercase text-holo/30">
            🌙 Коробка Азии ({analysis.asiaBox.date})
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="text-center">
              <div className="font-mono text-[9px] text-holo/30">High</div>
              <div className="font-mono text-xs font-bold text-matrix">
                {formatPrice(analysis.asiaBox.high)}
              </div>
            </div>
            <div className="text-center">
              <div className="font-mono text-[9px] text-holo/30">Mid</div>
              <div className="font-mono text-xs font-bold text-holo/60">
                {formatPrice(analysis.asiaBox.mid)}
              </div>
            </div>
            <div className="text-center">
              <div className="font-mono text-[9px] text-holo/30">Low</div>
              <div className="font-mono text-xs font-bold text-alert">
                {formatPrice(analysis.asiaBox.low)}
              </div>
            </div>
          </div>
          <div className="mt-1 text-center font-mono text-[9px] text-holo/20">
            Диапазон: {analysis.asiaBox.rangePct.toFixed(2)}%
          </div>
        </div>
      )}

      {analysis.manipulationDetected && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2 py-1.5">
          <span className="text-xs">🎭</span>
          <span className="font-mono text-xs text-amber-400">
            Манипуляция:{' '}
            {analysis.manipulationDirection === 'HIGH_SWEPT'
              ? 'вынос хая Азии'
              : analysis.manipulationDirection === 'LOW_SWEPT'
                ? 'вынос лоя Азии'
                : 'двойной вынос'}
          </span>
          {analysis.returnIntoBox && (
            <span className="ml-auto rounded bg-matrix/20 px-1 font-mono text-[9px] text-matrix">
              ВОЗВРАТ ✓
            </span>
          )}
        </div>
      )}

      <div className="rounded-lg bg-black/20 px-2 py-2">
        <p className="font-mono text-xs leading-relaxed text-holo/70">
          {analysis.tradingAdvice}
        </p>
      </div>
    </div>
  )
}

export default PO3Panel
