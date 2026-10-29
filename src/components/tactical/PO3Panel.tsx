import {
  Drama,
  HelpCircle,
  Moon,
  Rocket,
  ScanLine,
  type LucideIcon,
} from 'lucide-react'
import type { PO3Analysis, PO3Phase } from '../../engine/types'

interface Props {
  analysis: PO3Analysis
}

const PHASE_TONES: Record<
  PO3Phase,
  { border: string; bg: string; text: string }
> = {
  ACCUMULATION: {
    border: 'border-market-purple/25',
    bg: 'bg-market-purple/[0.04]',
    text: 'text-market-purple',
  },
  MANIPULATION: {
    border: 'border-market-warning/25',
    bg: 'bg-market-warning/[0.04]',
    text: 'text-market-warning',
  },
  DISTRIBUTION: {
    border: 'border-market-long/20',
    bg: 'bg-market-long/[0.04]',
    text: 'text-market-long',
  },
  UNKNOWN: {
    border: 'border-border',
    bg: 'bg-bg-panel',
    text: 'text-text-muted',
  },
}

const PHASE_ICONS: Record<PO3Phase, LucideIcon> = {
  ACCUMULATION: Moon,
  MANIPULATION: Drama,
  DISTRIBUTION: Rocket,
  UNKNOWN: HelpCircle,
}

const PO3Panel = ({ analysis }: Props) => {
  if (!analysis.asiaBox && analysis.currentPhase === 'UNKNOWN') return null

  const tone = PHASE_TONES[analysis.currentPhase]
  const PhaseIcon = PHASE_ICONS[analysis.currentPhase]

  const formatPrice = (p: number) =>
    p >= 1000
      ? p.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : p >= 1
        ? p.toFixed(4)
        : p.toFixed(6)

  return (
    <div className={`rounded-lg border ${tone.border} ${tone.bg} p-3`}>
      <div className="mb-2.5 flex items-center gap-2">
        <PhaseIcon className={`h-3.5 w-3.5 shrink-0 ${tone.text}`} strokeWidth={1.9} />
        <span className="font-sans text-[13px] font-medium leading-5 text-text-primary">
          Power of Three
        </span>
        <span
          className={`ml-auto rounded-sm border ${tone.border} px-1.5 py-0.5 font-mono text-[11px] font-medium leading-4 ${tone.text}`}
        >
          {analysis.currentPhase}
        </span>
      </div>

      <p className={`mb-2 font-sans text-[11px] font-medium leading-4 ${tone.text}`}>
        {analysis.phaseLabel}
      </p>

      {analysis.asiaBox && (
        <div className="mb-2 rounded-md border border-border bg-bg-base/40 p-2">
          <div className="mb-1 flex items-center gap-1 font-sans text-[11px] leading-4 text-text-muted">
            <Moon className="h-2.5 w-2.5" />
            Коробка Азии ({analysis.asiaBox.date})
          </div>
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-sm border border-border bg-border">
            <div className="bg-bg-base/60 px-2 py-1.5 text-center">
              <div className="font-sans text-[11px] leading-4 text-text-muted">
                High
              </div>
              <div className="tnum font-mono text-[12px] font-medium leading-4 text-market-long">
                {formatPrice(analysis.asiaBox.high)}
              </div>
            </div>
            <div className="bg-bg-base/60 px-2 py-1.5 text-center">
              <div className="font-sans text-[11px] leading-4 text-text-muted">
                Mid
              </div>
              <div className="tnum font-mono text-[12px] font-medium leading-4 text-text-secondary">
                {formatPrice(analysis.asiaBox.mid)}
              </div>
            </div>
            <div className="bg-bg-base/60 px-2 py-1.5 text-center">
              <div className="font-sans text-[11px] leading-4 text-text-muted">
                Low
              </div>
              <div className="tnum font-mono text-[12px] font-medium leading-4 text-market-short">
                {formatPrice(analysis.asiaBox.low)}
              </div>
            </div>
          </div>
          <div className="tnum mt-1 text-center font-mono text-[11px] leading-4 text-text-muted">
            Диапазон: {analysis.asiaBox.rangePct.toFixed(2)}%
          </div>
        </div>
      )}

      {analysis.manipulationDetected && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-market-warning/25 bg-market-warning/[0.05] px-2 py-1.5">
          <ScanLine className="h-3 w-3 shrink-0 text-market-warning" />
          <span className="font-sans text-[11px] leading-4 text-market-warning">
            Манипуляция:{' '}
            {analysis.manipulationDirection === 'HIGH_SWEPT'
              ? 'вынос хая Азии'
              : analysis.manipulationDirection === 'LOW_SWEPT'
                ? 'вынос лоя Азии'
                : 'двойной вынос'}
          </span>
          {analysis.returnIntoBox && (
            <span className="ml-auto shrink-0 rounded-sm bg-market-long/15 px-1 font-mono text-[11px] font-medium leading-4 text-market-long">
              ВОЗВРАТ
            </span>
          )}
        </div>
      )}

      <div className="rounded-md border border-border bg-bg-base/30 px-2 py-2">
        <p className="font-sans text-[11px] leading-4 text-text-secondary">
          {analysis.tradingAdvice}
        </p>
      </div>
    </div>
  )
}

export default PO3Panel
