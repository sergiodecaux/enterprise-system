import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PriceScenario } from '../../engine/prediction/types'

interface Props {
  scenarios: PriceScenario[]
  dominantId: 'A' | 'B' | 'C'
  activeScenarios: Set<string>
  onToggle: (id: string) => void
  /** Forecast generatedAt ms */
  updatedAt?: number | null
  horizon?: string | null
}

const ScenarioLegend = ({
  scenarios,
  dominantId,
  activeScenarios,
  onToggle,
  updatedAt,
  horizon,
}: Props) => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [, setNowTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 5_000)
    return () => window.clearInterval(id)
  }, [])
  const ageSec =
    updatedAt != null
      ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000))
      : null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase text-holo/50">
          {horizon === 'SWING' || horizon === 'MACRO'
            ? 'Сценарии · свинг'
            : horizon === 'SCALP'
              ? 'Сценарии · скальп'
              : scenarios.some((s) => s.label.toLowerCase().includes('неделя'))
                ? 'Сценарии · неделя'
                : t('forecast_scenarios')}
        </div>
        <div className="font-mono text-[9px] text-holo/35">
          {ageSec != null
            ? ageSec < 60
              ? `обновлено ${ageSec}с`
              : `обновлено ${Math.floor(ageSec / 60)}м`
            : t('forecast_hint')}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {scenarios.map((sc) => {
          const isActive = activeScenarios.has(sc.id)
          const isDominant = sc.id === dominantId

          return (
            <button
              key={sc.id}
              type="button"
              onClick={() => onToggle(sc.id)}
              className={`rounded-lg border px-2 py-2 text-left transition-all ${
                isActive
                  ? 'bg-hull-light/40'
                  : 'border-hull-border/30 bg-hull/20 opacity-45'
              }`}
              style={{
                borderColor: isActive ? `${sc.color}70` : undefined,
              }}
            >
              <div className="mb-1 flex items-center justify-between gap-1">
                <span
                  className="font-mono text-xs font-bold"
                  style={{ color: sc.color }}
                >
                  {sc.id}
                  {isDominant ? ' ★' : ''}
                </span>
                <span
                  className="font-mono text-[11px] font-bold"
                  style={{ color: sc.color }}
                >
                  {sc.probability}%
                </span>
              </div>
              <div className="mb-1.5 h-1 overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${sc.probability}%`,
                    backgroundColor: sc.color,
                  }}
                />
              </div>
              <div className="line-clamp-2 font-mono text-[9px] leading-tight text-holo/55">
                {sc.label}
              </div>
            </button>
          )
        })}
      </div>

      {scenarios.map((sc) => {
        const isExpanded = expanded === sc.id
        if (!activeScenarios.has(sc.id) && !isExpanded) return null

        return (
          <div
            key={`detail-${sc.id}`}
            className="rounded-lg border border-hull-border/40 bg-hull/30"
          >
            <button
              type="button"
              onClick={() => setExpanded(isExpanded ? null : sc.id)}
              className="flex w-full items-center justify-between px-2.5 py-1.5"
            >
              <span className="font-mono text-[10px] text-holo/60">
                <span style={{ color: sc.color }}>{sc.id}</span> — детали
              </span>
              {isExpanded ? (
                <ChevronUp className="h-3 w-3 text-holo/40" />
              ) : (
                <ChevronDown className="h-3 w-3 text-holo/40" />
              )}
            </button>

            {isExpanded && (
              <div className="space-y-2 border-t border-hull-border/20 px-3 pb-3 pt-2">
                <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
                  <div>
                    <div className="text-holo/40">{t('scenario_entry')}</div>
                    <div className="text-holo/80">${sc.entry.toFixed(4)}</div>
                  </div>
                  <div>
                    <div className="text-holo/40">{t('scenario_target')}</div>
                    <div style={{ color: sc.color }}>${sc.target.toFixed(4)}</div>
                  </div>
                  <div>
                    <div className="text-holo/40">{t('scenario_invalidation')}</div>
                    <div className="text-alert/70">
                      ${sc.invalidation.toFixed(4)}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-[10px] text-holo/40">
                    {t('scenario_trigger')}:
                  </div>
                  <div className="font-mono text-[10px] text-holo/70">
                    {sc.triggerCondition}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-[10px] text-holo/40">
                    {t('scenario_factors')}:
                  </div>
                  {sc.reasoning.map((r) => (
                    <div key={r} className="text-[10px] text-holo/60">
                      • {r}
                    </div>
                  ))}
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
