import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PriceScenario } from '../../engine/prediction/types'

interface Props {
  scenarios: PriceScenario[]
  dominantId: 'A' | 'B' | 'C'
  activeScenarios: Set<string>
  onToggle: (id: string) => void
}

const ScenarioLegend = ({
  scenarios,
  dominantId,
  activeScenarios,
  onToggle,
}: Props) => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] uppercase text-holo/50">
        {t('forecast_scenarios')}
      </div>

      {scenarios.map((sc) => {
        const isActive = activeScenarios.has(sc.id)
        const isDominant = sc.id === dominantId
        const isExpanded = expanded === sc.id

        return (
          <div
            key={sc.id}
            className={`rounded-lg border transition-all ${
              isActive
                ? 'border-opacity-50 bg-hull-light/30'
                : 'border-hull-border/20 bg-hull/20 opacity-50'
            }`}
            style={{ borderColor: isActive ? `${sc.color}60` : undefined }}
          >
            <div className="flex items-center gap-2 p-2.5">
              <button
                type="button"
                onClick={() => onToggle(sc.id)}
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border-2 transition-colors"
                style={{
                  borderColor: sc.color,
                  backgroundColor: isActive ? `${sc.color}40` : 'transparent',
                }}
              >
                {isActive && (
                  <div
                    className="h-2 w-2 rounded-sm"
                    style={{ backgroundColor: sc.color }}
                  />
                )}
              </button>

              <div
                className="h-0.5 w-6 flex-shrink-0 rounded"
                style={{ backgroundColor: sc.color }}
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-bold text-holo/90">{sc.id}</span>
                  <span className="truncate font-mono text-xs text-holo/70">{sc.label}</span>
                  {isDominant && (
                    <span className="flex-shrink-0 rounded bg-holo/20 px-1 font-mono text-[9px] text-holo">
                      ★
                    </span>
                  )}
                </div>
                <div className="font-mono text-[10px]" style={{ color: sc.color }}>
                  {sc.type} • {sc.probability}%
                </div>
              </div>

              <div className="w-16 flex-shrink-0">
                <div className="h-1.5 overflow-hidden rounded-full bg-hull">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${sc.probability}%`, backgroundColor: sc.color }}
                  />
                </div>
                <div
                  className="mt-0.5 text-right font-mono text-[10px]"
                  style={{ color: sc.color }}
                >
                  {sc.probability}%
                </div>
              </div>

              <button
                type="button"
                onClick={() => setExpanded(isExpanded ? null : sc.id)}
                className="p-1 text-holo/40 hover:text-holo/70"
              >
                {isExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </button>
            </div>

            {isExpanded && (
              <div className="space-y-2 border-t border-hull-border/20 px-3 pb-3 pt-2">
                <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
                  <div>
                    <div className="text-holo/40">{t('scenario_entry')}</div>
                    <div className="text-holo/80">${sc.entry.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-holo/40">{t('scenario_target')}</div>
                    <div style={{ color: sc.color }}>${sc.target.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-holo/40">{t('scenario_invalidation')}</div>
                    <div className="text-alert/70">${sc.invalidation.toFixed(2)}</div>
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-[10px] text-holo/40">{t('scenario_trigger')}:</div>
                  <div className="font-mono text-[10px] text-holo/70">{sc.triggerCondition}</div>
                </div>

                <div>
                  <div className="mb-1 text-[10px] text-holo/40">{t('scenario_factors')}:</div>
                  {sc.reasoning.map((r) => (
                    <div key={r} className="text-[10px] text-holo/60">
                      • {r}
                    </div>
                  ))}
                </div>

                <div className="flex gap-3 font-mono text-[10px]">
                  <span className="text-holo/50">
                    R:R <span className="text-holo/80">{sc.riskReward.toFixed(1)}x</span>
                  </span>
                  <span className="text-holo/50">
                    {t('mtf_liq_primary')}{' '}
                    <span style={{ color: sc.color }}>{sc.liquidityTarget.label}</span>
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default ScenarioLegend
