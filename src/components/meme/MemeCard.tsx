import { useState } from 'react'
import { Loader2, Lock } from 'lucide-react'
import type { MemeSignal } from '../../engine/types'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { useAppStore } from '../../store/useAppStore'
import { loadMemeCoinAnalysis } from '../../hooks/loadMemeCoinAnalysis'
import { gapDirectionLabel } from '../../i18n/displayMaps'
import SpreadPressureBar from './SpreadPressureBar'
import VolatilityGauge from './VolatilityGauge'

interface MemeCardProps {
  signal: MemeSignal
}

const MemeCard = ({ signal }: MemeCardProps) => {
  const { haptic } = useTelegramWebApp()
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const [loading, setLoading] = useState(false)

  const qualityColor =
    signal.quality === 'CRITICAL'
      ? 'border-alert/70 bg-gradient-to-br from-alert/20 to-orange-600/10 shadow-[0_0_20px_rgba(255,0,60,0.15)]'
      : signal.quality === 'STRONG'
        ? 'border-orange-500/50 bg-gradient-to-br from-orange-500/15 to-yellow-500/5'
        : signal.quality === 'MODERATE'
          ? 'border-yellow-400/40 bg-yellow-400/5'
          : 'border-hull-border bg-hull'

  const qualityText =
    signal.quality === 'CRITICAL'
      ? 'text-alert'
      : signal.quality === 'STRONG'
        ? 'text-orange-400'
        : signal.quality === 'MODERATE'
          ? 'text-yellow-400'
          : 'text-holo/40'

  const handleClick = async () => {
    if (loading) return
    haptic.impact()
    setLoading(true)
    try {
      await loadMemeCoinAnalysis(signal)
      selectCoin(signal.symbol)
      setDrawerOpen(true)
    } finally {
      setLoading(false)
    }
  }

  const formatPrice = (price: number): string => {
    if (price >= 1) return price.toFixed(6)
    return price.toFixed(8)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={`w-full rounded-xl border ${qualityColor} p-4 text-left transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-70`}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-lg font-bold text-holo">
              {signal.displayName}
            </h3>
            {signal.setupTag && (
              <span className="animate-pulse rounded-md border border-alert/50 bg-alert/20 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-alert">
                {signal.setupTag}
              </span>
            )}
            {signal.recommendation === 'QUICK_ENTRY' && !signal.setupTag && (
              <span className="animate-pulse rounded-md bg-alert px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-black">
                БЫСТРЫЙ ВХОД
              </span>
            )}
            {loading && (
              <Loader2 className="h-4 w-4 animate-spin text-holo/50" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-holo/60">
              ${formatPrice(signal.price)}
            </span>
            <span
              className={`font-mono text-xs font-bold ${
                signal.priceChange24h >= 0 ? 'text-orange-400' : 'text-alert'
              }`}
            >
              {signal.priceChange24h >= 0 ? '+' : ''}
              {signal.priceChange24h.toFixed(2)}%
            </span>
            {signal.lifecycle && (
              <span
                className={`font-mono text-[10px] font-bold ${signal.lifecycle.color}`}
              >
                {signal.lifecycle.badge}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-start gap-2">
          {signal.volatility && (
            <VolatilityGauge volatility={signal.volatility} compact />
          )}
          <div className="text-right">
            <div className={`mb-0.5 font-mono text-3xl font-bold ${qualityText}`}>
              {signal.heatScore}
            </div>
            <div className="font-mono text-[10px] uppercase text-holo/40">
              Fuel
            </div>
          </div>
        </div>
      </div>

      {(signal.longBlocked || signal.shortBlocked) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {signal.longBlocked && (
            <span className="inline-flex items-center gap-1 rounded border border-alert/40 bg-alert/10 px-2 py-0.5 font-mono text-[9px] font-bold text-alert">
              <Lock className="h-2.5 w-2.5" /> LONG LOCKED
            </span>
          )}
          {signal.shortBlocked && (
            <span className="inline-flex items-center gap-1 rounded border border-yellow-400/40 bg-yellow-400/10 px-2 py-0.5 font-mono text-[9px] font-bold text-yellow-400">
              <Lock className="h-2.5 w-2.5" /> SHORT LOCKED
            </span>
          )}
        </div>
      )}

      <div className="mb-3">
        <SpreadPressureBar pressure={signal.spreadPressure} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div
          className={`rounded-lg border p-2 ${
            signal.volumeSpike.detected || signal.flatline?.detected
              ? 'border-orange-500/40 bg-orange-500/10'
              : 'border-hull-border/50 bg-black/30'
          }`}
        >
          <div className="mb-1 font-mono text-[9px] uppercase text-holo/40">
            Объём
          </div>
          <div
            className={`font-mono text-xs font-bold ${
              signal.volumeSpike.detected || signal.flatline?.detected
                ? 'text-orange-400'
                : 'text-holo/30'
            }`}
          >
            {signal.flatline?.detected
              ? `🔥 ×${signal.flatline.volumeMultiplier.toFixed(0)}`
              : signal.volumeSpike.detected
                ? `${signal.volumeSpike.emoji} ×${signal.volumeSpike.volumeMultiplier.toFixed(1)}`
                : '—'}
          </div>
        </div>

        <div
          className={`rounded-lg border p-2 ${
            signal.squeeze?.detected
              ? 'border-alert/40 bg-alert/10'
              : signal.liquidityGap.detected
                ? 'border-yellow-400/30 bg-yellow-400/5'
                : 'border-hull-border/50 bg-black/30'
          }`}
        >
          <div className="mb-1 font-mono text-[9px] uppercase text-holo/40">
            Fuel/Gap
          </div>
          <div
            className={`font-mono text-xs font-bold ${
              signal.squeeze?.detected
                ? 'text-alert'
                : signal.liquidityGap.detected
                  ? 'text-yellow-400'
                  : 'text-holo/30'
            }`}
          >
            {signal.squeeze?.detected
              ? `${signal.squeeze.emoji} FR`
              : signal.liquidityGap.detected
                ? `${signal.liquidityGap.emoji} ${gapDirectionLabel[signal.liquidityGap.direction] ?? signal.liquidityGap.direction}`
                : '—'}
          </div>
        </div>

        <div
          className={`rounded-lg border p-2 ${
            signal.backside?.detected || signal.toxic?.detected
              ? 'border-alert/40 bg-alert/10'
              : signal.meanReversion.detected
                ? 'border-alert/30 bg-alert/5'
                : 'border-hull-border/50 bg-black/30'
          }`}
        >
          <div className="mb-1 font-mono text-[9px] uppercase text-holo/40">
            Setup
          </div>
          <div
            className={`font-mono text-xs font-bold ${
              signal.toxic?.detected
                ? 'text-holo/50'
                : signal.backside?.detected
                  ? 'text-alert'
                  : signal.meanReversion.detected
                    ? 'text-alert'
                    : 'text-holo/30'
            }`}
          >
            {signal.toxic?.detected
              ? '☠️ TOXIC'
              : signal.backside?.detected
                ? '🎯 SHORT'
                : signal.meanReversion.detected
                  ? `${signal.meanReversion.emoji} RSI ${signal.meanReversion.rsi?.toFixed(0)}`
                  : '—'}
          </div>
        </div>
      </div>

      {signal.criticalAlert && (
        <p className="mt-2 font-mono text-[10px] font-bold leading-snug text-alert">
          {signal.criticalAlert}
        </p>
      )}
      {!signal.criticalAlert && signal.volumeSpike.detected && (
        <p className="mt-2 font-mono text-[10px] text-orange-400/80">
          📊 {signal.volumeSpike.label}
        </p>
      )}
    </button>
  )
}

export default MemeCard
