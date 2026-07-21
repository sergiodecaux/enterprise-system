import type { MacroOutlookContext } from '../../engine/prediction/macroOutlook'
import type { PriceScenario } from '../../engine/prediction/types'

interface Props {
  summary?: string
  scenarios: PriceScenario[]
  macro?: MacroOutlookContext | null
}

/**
 * Weekly / global picture under the chart when MACRO forecast is on.
 */
const MacroOutlookPanel = ({ summary, scenarios, macro }: Props) => {
  const a = scenarios.find((s) => s.id === 'A')

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-cyan-500/25 bg-gradient-to-br from-cyan-500/10 to-transparent p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-cyan-300">
          Общая картина · неделя
        </span>
        {macro && (
          <span className="font-mono text-[9px] text-holo/45">
            range {macro.weekRangePct.toFixed(1)}%
          </span>
        )}
      </div>

      {summary && (
        <p className="font-mono text-[10px] leading-relaxed text-holo/70">
          {summary}
        </p>
      )}

      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        <div className="rounded border border-hull-border/40 bg-black/25 px-2 py-1.5">
          <div className="font-mono text-[8px] uppercase text-holo/40">
            Охота за ликвой
          </div>
          <div className="font-mono text-[10px] font-bold text-cyan-200">
            {macro?.huntedLiquidity?.label ?? a?.liquidityTarget.label ?? '—'}
          </div>
          <div className="font-mono text-[9px] text-holo/50">
            @{' '}
            {macro?.huntedLiquidity?.price?.toPrecision(6) ??
              a?.target.toPrecision(6) ??
              '—'}
          </div>
        </div>
        <div className="rounded border border-hull-border/40 bg-black/25 px-2 py-1.5">
          <div className="font-mono text-[8px] uppercase text-holo/40">
            Глобальный отскок
          </div>
          <div className="font-mono text-[10px] font-bold text-amber-200">
            {macro?.bounceZone?.label ?? '—'}
          </div>
          <div className="font-mono text-[9px] text-holo/50">
            @ {macro?.bounceZone?.price?.toPrecision(6) ?? '—'}
          </div>
        </div>
        <div className="rounded border border-hull-border/40 bg-black/25 px-2 py-1.5">
          <div className="font-mono text-[8px] uppercase text-holo/40">
            Новости / bias
          </div>
          <div className="font-mono text-[10px] font-bold text-holo">
            {macro?.newsBias ?? 'NEUTRAL'} · HTF {macro?.weeklyBias ?? '—'}
          </div>
          <div className="font-mono text-[9px] text-holo/50">
            score{' '}
            {macro
              ? `${macro.newsScore >= 0 ? '+' : ''}${macro.newsScore.toFixed(1)}`
              : '—'}
          </div>
        </div>
      </div>
    </div>
  )
}

export default MacroOutlookPanel
