import type { MemeSignal } from '../../engine/types'
import SpreadPressureBar from './SpreadPressureBar'

interface MemePulsePanelProps {
  meme: MemeSignal
}

const MemePulsePanel = ({ meme }: MemePulsePanelProps) => {
  const qualityColor =
    meme.quality === 'CRITICAL'
      ? 'text-alert'
      : meme.quality === 'STRONG'
        ? 'text-yellow-400'
        : meme.quality === 'MODERATE'
          ? 'text-matrix'
          : 'text-holo/50'

  return (
    <div className="rounded-xl border border-alert/30 bg-alert/5 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-alert">
          🔥 Мем-пульс
        </span>
        <div className="flex items-center gap-2">
          <span className={`font-mono text-2xl font-bold ${qualityColor}`}>
            {meme.heatScore}
          </span>
          <span className="font-mono text-[10px] uppercase text-holo/40">
            Нагрев
          </span>
        </div>
      </div>

      {meme.recommendation === 'QUICK_ENTRY' && (
        <div className="mb-3 rounded-lg border border-alert/40 bg-alert/10 px-3 py-2">
          <span className="font-mono text-xs font-bold uppercase text-alert">
            ⚡ Быстрый вход — {meme.quality}
          </span>
        </div>
      )}

      <div className="mb-3">
        <SpreadPressureBar pressure={meme.spreadPressure} />
      </div>

      <div className="space-y-2">
        {meme.volumeSpike.detected && (
          <p className="font-mono text-[11px] text-matrix/90">
            {meme.volumeSpike.emoji} {meme.volumeSpike.label}
          </p>
        )}
        {meme.liquidityGap.detected && (
          <p className="font-mono text-[11px] text-yellow-400/90">
            {meme.liquidityGap.emoji} {meme.liquidityGap.label}
          </p>
        )}
        {meme.meanReversion.detected && (
          <p className="font-mono text-[11px] text-alert/90">
            {meme.meanReversion.emoji} {meme.meanReversion.label}
          </p>
        )}
      </div>
    </div>
  )
}

export default MemePulsePanel
