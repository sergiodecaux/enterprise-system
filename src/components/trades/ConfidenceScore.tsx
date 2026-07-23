import type { ConfidenceScoreResult } from '../../engine/confidence'

interface ConfidenceScoreProps {
  result: ConfidenceScoreResult
}

const ConfidenceScore = ({ result }: ConfidenceScoreProps) => {
  const { totalScore, factors, quality, recommendation, mmStatus } = result

  const qualityColor =
    quality === 'ELITE'
      ? 'text-matrix'
      : quality === 'STRONG'
        ? 'text-yellow-400'
        : 'text-alert'

  const qualityBg =
    quality === 'ELITE'
      ? 'bg-matrix/10'
      : quality === 'STRONG'
        ? 'bg-yellow-400/10'
        : 'bg-alert/10'

  const qualityBorder =
    quality === 'ELITE'
      ? 'border-matrix/30'
      : quality === 'STRONG'
        ? 'border-yellow-400/30'
        : 'border-alert/30'

  const mmBadge =
    mmStatus === 'ABSORPTION_TRAP'
      ? '⚠️ ABSORPTION TRAP'
      : mmStatus === 'MM_DISTRIBUTION'
        ? '⚠️ MM DISTRIBUTION'
        : mmStatus === 'TRIPLE_CONFIRMED'
          ? '🎯 TRIPLE CONFIRMED'
          : mmStatus === 'BTC_DUMP'
            ? '📉 BTC DUMP'
            : mmStatus === 'NO_LIQUIDITY_RAID'
              ? '🔄 NO LIQUIDITY RAID'
              : null

  return (
    <div className={`rounded-xl border ${qualityBorder} ${qualityBg} p-4`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">
            {quality === 'ELITE' ? '💎' : quality === 'STRONG' ? '✅' : '⚠️'}
          </span>
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
            Оценка уверенности
          </span>
        </div>
        <div className={`font-mono text-3xl font-bold ${qualityColor}`}>
          {totalScore}%
        </div>
      </div>

      {mmBadge && (
        <div className="mb-3 rounded-lg border border-alert/40 bg-alert/10 px-3 py-1.5 font-mono text-[11px] font-bold text-alert">
          {mmBadge}
        </div>
      )}

      <p
        className={`mb-4 rounded-lg bg-black/20 px-3 py-2 font-mono text-xs leading-relaxed ${qualityColor}`}
      >
        {recommendation}
      </p>

      <div className="space-y-2">
        {factors.map((factor) => (
          <div key={factor.name} className="rounded-lg bg-black/10 p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm">{factor.emoji}</span>
                <span className="font-mono text-xs font-bold text-holo/80">
                  {factor.name}
                </span>
                <span className="font-mono text-[10px] text-holo/40">
                  ({factor.weight}%)
                </span>
              </div>
              <span
                className={`font-mono text-xs font-bold ${
                  factor.passed ? 'text-matrix' : 'text-holo/30'
                }`}
              >
                {factor.passed ? '✓' : '—'}
              </span>
            </div>

            <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-hull-border">
              <div
                className={`h-full rounded-full transition-all ${
                  factor.passed ? 'bg-matrix' : 'bg-holo/20'
                }`}
                style={{ width: `${factor.score * 100}%` }}
              />
            </div>

            <p className="font-mono text-[10px] text-holo/50">{factor.reason}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

export default ConfidenceScore
