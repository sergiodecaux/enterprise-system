import { Brain, Target, AlertTriangle } from 'lucide-react'
import type { CompositeAnalysis } from '../../engine/composite'
import {
  assetTypeLabel,
  marketPhaseLabel,
  dominantForceLabel,
  volatilityLevelLabel,
  confluenceCategoryLabel,
} from '../../i18n/displayMaps'

interface CompositeAnalysisPanelProps {
  analysis: CompositeAnalysis
}

const CompositeAnalysisPanel = ({ analysis }: CompositeAnalysisPanelProps) => {
  const {
    assetType,
    overallScore,
    marketPhase,
    dominantForce,
    volatilityLevel,
    confluenceBreakdown,
    tacticalAdvice,
    memeContext,
    altContext,
  } = analysis

  const assetColors = {
    MEME: { bg: 'bg-alert/10', border: 'border-alert/30', text: 'text-alert' },
    ALT: { bg: 'bg-matrix/10', border: 'border-matrix/30', text: 'text-matrix' },
    BLUE_CHIP: {
      bg: 'bg-yellow-400/10',
      border: 'border-yellow-400/30',
      text: 'text-yellow-400',
    },
  }

  const colors = assetColors[assetType]

  const scoreColor =
    overallScore >= 80
      ? 'text-matrix'
      : overallScore >= 60
        ? 'text-yellow-400'
        : overallScore >= 40
          ? 'text-holo'
          : 'text-alert'

  const forceEmoji: Record<CompositeAnalysis['dominantForce'], string> = {
    STRONG_BUYERS: '🟢🟢',
    BUYERS: '🟢',
    NEUTRAL: '⚪',
    SELLERS: '🔴',
    STRONG_SELLERS: '🔴🔴',
  }

  const breakdownEntries = Object.entries(confluenceBreakdown) as Array<
    [keyof typeof confluenceBreakdown, (typeof confluenceBreakdown)['technical']]
  >
  const maxScore = Math.max(...breakdownEntries.map(([, d]) => d.score))

  return (
    <div className={`rounded-xl border ${colors.border} ${colors.bg} space-y-4 p-4`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Brain className={`h-5 w-5 ${colors.text}`} />
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
            Композитный анализ
          </span>
        </div>

        <div className="text-right">
          <div className={`mb-0.5 font-mono text-3xl font-bold ${scoreColor}`}>
            {overallScore}
            <span className="text-sm text-holo/40">/100</span>
          </div>
          <div className={`font-mono text-[10px] font-bold uppercase ${colors.text}`}>
            {assetTypeLabel[assetType]}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-lg bg-black/20 p-2">
        <div className="text-center">
          <div className="mb-0.5 font-mono text-[9px] uppercase text-holo/30">
            Фаза
          </div>
          <div className="font-mono text-xs font-bold text-holo">
            {marketPhaseLabel[marketPhase]}
          </div>
        </div>

        <div className="text-center">
          <div className="mb-0.5 font-mono text-[9px] uppercase text-holo/30">
            Сила
          </div>
          <div className="font-mono text-xs font-bold text-holo">
            {forceEmoji[dominantForce]} {dominantForceLabel[dominantForce]}
          </div>
        </div>

        <div className="text-center">
          <div className="mb-0.5 font-mono text-[9px] uppercase text-holo/30">
            Волатильность
          </div>
          <div
            className={`font-mono text-xs font-bold ${
              volatilityLevel === 'EXTREME'
                ? 'text-alert'
                : volatilityLevel === 'HIGH'
                  ? 'text-yellow-400'
                  : 'text-holo'
            }`}
          >
            {volatilityLevelLabel[volatilityLevel]}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="font-mono text-xs font-bold uppercase text-holo/50">
          Разбор confluence
        </div>

        {breakdownEntries.map(([category, data]) => {
          const isDominant = data.score === maxScore && maxScore > 0

          return (
            <div key={category} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-holo/70">
                  {confluenceCategoryLabel[category] ?? category}
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-holo">
                    {data.score}%
                  </span>
                  {isDominant && (
                    <span className="rounded bg-matrix/20 px-1.5 py-0.5 font-mono text-[9px] font-bold text-matrix">
                      ДОМИНИРУЕТ
                    </span>
                  )}
                </div>
              </div>

              <div className="h-1.5 overflow-hidden rounded-full bg-hull-border">
                <div
                  className={`h-full rounded-full transition-all ${
                    data.score >= 70
                      ? 'bg-matrix'
                      : data.score >= 50
                        ? 'bg-yellow-400'
                        : 'bg-holo/30'
                  }`}
                  style={{ width: `${data.score}%` }}
                />
              </div>

              {data.factors.length > 0 && (
                <div className="pl-2 font-mono text-[10px] text-holo/40">
                  {data.factors.slice(0, 2).join(' · ')}
                  {data.factors.length > 2 && ` +ещё ${data.factors.length - 2}`}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="space-y-2 rounded-lg border border-hull-border bg-hull p-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-matrix" />
          <span className="font-mono text-xs font-bold uppercase text-matrix">
            Тактический совет
          </span>
        </div>

        <p className={`font-mono text-sm font-bold leading-relaxed ${colors.text}`}>
          {tacticalAdvice.primary}
        </p>

        {tacticalAdvice.reasoning.length > 0 && (
          <div className="space-y-1">
            <div className="font-mono text-[10px] uppercase text-holo/30">
              Обоснование:
            </div>
            {tacticalAdvice.reasoning.map((reason, idx) => (
              <div
                key={idx}
                className="flex items-start gap-1.5 font-mono text-xs text-holo/70"
              >
                <span className="text-matrix">•</span>
                <span>{reason}</span>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 rounded-md bg-black/20 p-2">
          <div>
            <div className="mb-0.5 font-mono text-[9px] uppercase text-holo/30">
              Вход
            </div>
            <div className="font-mono text-xs text-holo">
              {tacticalAdvice.optimal.entry}
            </div>
          </div>

          <div>
            <div className="mb-0.5 font-mono text-[9px] uppercase text-holo/30">
              Стоп
            </div>
            <div className="font-mono text-xs text-holo">
              {tacticalAdvice.optimal.stop}
            </div>
          </div>

          <div>
            <div className="mb-0.5 font-mono text-[9px] uppercase text-holo/30">
              Цели
            </div>
            <div className="font-mono text-xs text-holo">
              {tacticalAdvice.optimal.targets}
            </div>
          </div>

          <div>
            <div className="mb-0.5 font-mono text-[9px] uppercase text-holo/30">
              Таймфрейм
            </div>
            <div className="font-mono text-xs text-holo">
              {tacticalAdvice.optimal.timeframe}
            </div>
          </div>
        </div>

        {tacticalAdvice.warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-alert/20 bg-alert/5 p-2">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3 text-alert" />
              <span className="font-mono text-[10px] font-bold uppercase text-alert">
                Предупреждения
              </span>
            </div>
            {tacticalAdvice.warnings.map((warning, idx) => (
              <div
                key={idx}
                className="font-mono text-[10px] leading-relaxed text-alert/80"
              >
                {warning}
              </div>
            ))}
          </div>
        )}
      </div>

      {memeContext && (
        <div className="rounded-lg border border-alert/20 bg-alert/5 p-2.5">
          <div className="mb-2 font-mono text-xs font-bold uppercase text-alert">
            🔥 Контекст мема
          </div>
          <div className="grid grid-cols-2 gap-2 font-mono text-xs text-holo/70">
            <div>
              Нагрев:{' '}
              <span className="font-bold text-alert">
                {memeContext.heatScore}/100
              </span>
            </div>
            <div>
              Объём:{' '}
              <span className="font-bold">
                ×{memeContext.volumeMultiplier.toFixed(1)}
              </span>
            </div>
            <div className="col-span-2">
              Ожидаемое:{' '}
              <span className="text-holo">{memeContext.expectedMoveRange}</span>
            </div>
          </div>
        </div>
      )}

      {altContext && (
        <div className="rounded-lg border border-matrix/20 bg-matrix/5 p-2.5">
          <div className="mb-2 font-mono text-xs font-bold uppercase text-matrix">
            📊 Контекст альта
          </div>
          <div className="space-y-1 font-mono text-xs text-holo/70">
            <div>
              Структура:{' '}
              <span className="text-matrix">{altContext.structureQuality}</span>
            </div>
            <div>
              Зоны: <span className="font-bold">{altContext.confluenceZones}</span>
            </div>
            <div>
              Сессия:{' '}
              <span className="text-holo">{altContext.sessionAlignment}</span>
            </div>
            <div>
              Ожидаемое:{' '}
              <span className="text-holo">{altContext.expectedMoveRange}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default CompositeAnalysisPanel
