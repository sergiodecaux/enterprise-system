import { Lock } from 'lucide-react'
import type { MemeSignal } from '../../engine/types'
import SpreadPressureBar from './SpreadPressureBar'
import VolatilityGauge from './VolatilityGauge'

interface MemePulsePanelProps {
  meme: MemeSignal
}

const MemePulsePanel = ({ meme }: MemePulsePanelProps) => {
  const qualityColor =
    meme.quality === 'CRITICAL'
      ? 'text-alert'
      : meme.quality === 'STRONG'
        ? 'text-orange-400'
        : meme.quality === 'MODERATE'
          ? 'text-yellow-400'
          : 'text-holo/50'

  return (
    <div className="rounded-xl border border-alert/40 bg-gradient-to-br from-alert/10 to-orange-600/5 p-4 shadow-[0_0_24px_rgba(255,0,60,0.08)]">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-alert">
          🚀 Meme Fuel
        </span>
        <div className="flex items-center gap-3">
          {meme.volatility && (
            <VolatilityGauge volatility={meme.volatility} compact />
          )}
          <div className="text-right">
            <span className={`font-mono text-2xl font-bold ${qualityColor}`}>
              {meme.heatScore}
            </span>
            <div className="font-mono text-[10px] uppercase text-holo/40">
              Fuel
            </div>
          </div>
        </div>
      </div>

      {meme.setupTag && (
        <div className="mb-3 rounded-lg border border-alert/50 bg-alert/15 px-3 py-2">
          <span className="font-mono text-xs font-bold uppercase text-alert">
            {meme.setupTag}
          </span>
        </div>
      )}

      {meme.lifecycle && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-hull-border bg-black/30 px-3 py-2">
          <span className={`font-mono text-xs font-bold ${meme.lifecycle.color}`}>
            {meme.lifecycle.badge}
          </span>
          <span className="font-mono text-[10px] text-holo/50">
            {meme.lifecycle.label}
          </span>
        </div>
      )}

      {(meme.longBlocked || meme.shortBlocked) && (
        <div className="mb-3 space-y-1.5">
          {meme.longBlocked && (
            <div className="flex items-center gap-2 rounded-lg border border-alert/40 bg-alert/10 px-3 py-2">
              <Lock className="h-3.5 w-3.5 text-alert" />
              <span className="font-mono text-[11px] font-bold text-alert">
                LONG ЗАБЛОКИРОВАН
                {meme.bidVoid?.detected
                  ? ' — Bid Void / дамп'
                  : meme.absorptionAlert?.type === 'DISTRIBUTION'
                    ? ' — Absorption / distribution'
                    : ''}
              </span>
            </div>
          )}
          {meme.shortBlocked && (
            <div className="flex items-center gap-2 rounded-lg border border-yellow-400/40 bg-yellow-400/10 px-3 py-2">
              <Lock className="h-3.5 w-3.5 text-yellow-400" />
              <span className="font-mono text-[11px] font-bold text-yellow-400">
                SHORT ЗАБЛОКИРОВАН — риск squeeze. Дождись слома структуры.
              </span>
            </div>
          )}
        </div>
      )}

      {meme.criticalAlert && (
        <div className="mb-3 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-2">
          <p className="font-mono text-[11px] font-bold leading-snug text-orange-300">
            {meme.criticalAlert}
          </p>
        </div>
      )}

      <div className="mb-3">
        <SpreadPressureBar pressure={meme.spreadPressure} />
      </div>

      <div className="space-y-2">
        {meme.squeeze?.detected && (
          <p className="font-mono text-[11px] text-alert/90">
            {meme.squeeze.emoji} {meme.squeeze.label}
          </p>
        )}
        {meme.flatline?.detected && (
          <p className="font-mono text-[11px] text-orange-400/90">
            {meme.flatline.emoji} {meme.flatline.label}
          </p>
        )}
        {meme.backside?.detected && (
          <p className="font-mono text-[11px] text-alert/90">
            {meme.backside.emoji} {meme.backside.label}
          </p>
        )}
        {meme.cvdTrap?.detected && (
          <p className="font-mono text-[11px] text-matrix/90">
            {meme.cvdTrap.emoji} {meme.cvdTrap.label}
          </p>
        )}
        {meme.absorptionAlert?.detected && (
          <p className="font-mono text-[11px] text-yellow-400/90">
            {meme.absorptionAlert.emoji} {meme.absorptionAlert.label}
          </p>
        )}
        {meme.toxic?.detected && (
          <p className="font-mono text-[11px] text-holo/60">
            {meme.toxic.emoji} {meme.toxic.label}
          </p>
        )}
        {meme.bidVoid?.detected && (
          <p className="font-mono text-[11px] text-alert/80">
            {meme.bidVoid.emoji} {meme.bidVoid.label}
          </p>
        )}
        {meme.volumeSpike.detected && (
          <p className="font-mono text-[11px] text-orange-400/80">
            {meme.volumeSpike.emoji} {meme.volumeSpike.label}
          </p>
        )}
      </div>
    </div>
  )
}

export default MemePulsePanel
