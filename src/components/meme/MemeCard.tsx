import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { MemeSignal } from '../../engine/types'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { useAppStore } from '../../store/useAppStore'
import { loadMemeCoinAnalysis } from '../../hooks/loadMemeCoinAnalysis'
import { gapDirectionLabel } from '../../i18n/displayMaps'
import SpreadPressureBar from './SpreadPressureBar'

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
      ? 'border-alert/60 bg-alert/10'
      : signal.quality === 'STRONG'
        ? 'border-yellow-400/50 bg-yellow-400/8'
        : signal.quality === 'MODERATE'
          ? 'border-matrix/40 bg-matrix/5'
          : 'border-hull-border bg-hull'

  const qualityText =
    signal.quality === 'CRITICAL'
      ? 'text-alert'
      : signal.quality === 'STRONG'
        ? 'text-yellow-400'
        : signal.quality === 'MODERATE'
          ? 'text-matrix'
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
      <div className="mb-3 flex items-start justify-between">
        <div className="flex-1">
          <div className="mb-1 flex items-center gap-2">
            <h3 className="font-mono text-lg font-bold text-holo">
              {signal.displayName}
            </h3>
            {signal.recommendation === 'QUICK_ENTRY' && (
              <span className="animate-pulse rounded-md bg-alert px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-black">
                БЫСТРЫЙ ВХОД
              </span>
            )}
            {loading && (
              <Loader2 className="h-4 w-4 animate-spin text-holo/50" />
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-holo/60">
              ${formatPrice(signal.price)}
            </span>
            <span
              className={`font-mono text-xs font-bold ${
                signal.priceChange24h >= 0 ? 'text-matrix' : 'text-alert'
              }`}
            >
              {signal.priceChange24h >= 0 ? '+' : ''}
              {signal.priceChange24h.toFixed(2)}%
            </span>
          </div>
        </div>

        <div className="text-right">
          <div className={`mb-0.5 font-mono text-3xl font-bold ${qualityText}`}>
            {signal.heatScore}
          </div>
          <div className="font-mono text-[10px] uppercase text-holo/40">
            Нагрев
          </div>
        </div>
      </div>

      <div className="mb-3">
        <SpreadPressureBar pressure={signal.spreadPressure} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div
          className={`rounded-lg border p-2 ${
            signal.volumeSpike.detected
              ? 'border-matrix/30 bg-matrix/5'
              : 'border-hull-border/50 bg-hull/50'
          }`}
        >
          <div className="mb-1 font-mono text-[9px] uppercase text-holo/40">
            Объём
          </div>
          <div
            className={`font-mono text-xs font-bold ${
              signal.volumeSpike.detected ? 'text-matrix' : 'text-holo/30'
            }`}
          >
            {signal.volumeSpike.detected
              ? `${signal.volumeSpike.emoji} ×${signal.volumeSpike.volumeMultiplier.toFixed(1)}`
              : '—'}
          </div>
        </div>

        <div
          className={`rounded-lg border p-2 ${
            signal.liquidityGap.detected
              ? 'border-yellow-400/30 bg-yellow-400/5'
              : 'border-hull-border/50 bg-hull/50'
          }`}
        >
          <div className="mb-1 font-mono text-[9px] uppercase text-holo/40">
            Гэп
          </div>
          <div
            className={`font-mono text-xs font-bold ${
              signal.liquidityGap.detected ? 'text-yellow-400' : 'text-holo/30'
            }`}
          >
            {signal.liquidityGap.detected
              ? `${signal.liquidityGap.emoji} ${gapDirectionLabel[signal.liquidityGap.direction] ?? signal.liquidityGap.direction}`
              : '—'}
          </div>
        </div>

        <div
          className={`rounded-lg border p-2 ${
            signal.meanReversion.detected
              ? 'border-alert/30 bg-alert/5'
              : 'border-hull-border/50 bg-hull/50'
          }`}
        >
          <div className="mb-1 font-mono text-[9px] uppercase text-holo/40">
            Откат
          </div>
          <div
            className={`font-mono text-xs font-bold ${
              signal.meanReversion.detected ? 'text-alert' : 'text-holo/30'
            }`}
          >
            {signal.meanReversion.detected
              ? `${signal.meanReversion.emoji} RSI ${signal.meanReversion.rsi?.toFixed(0)}`
              : '—'}
          </div>
        </div>
      </div>

      {signal.volumeSpike.detected && (
        <p className="mt-2 font-mono text-[10px] text-matrix/80">
          📊 {signal.volumeSpike.label}
        </p>
      )}
      {signal.liquidityGap.detected && (
        <p className="mt-1 font-mono text-[10px] text-yellow-400/80">
          💨 {signal.liquidityGap.label}
        </p>
      )}
      {signal.meanReversion.detected && (
        <p className="mt-1 font-mono text-[10px] text-alert/80">
          {signal.meanReversion.emoji} {signal.meanReversion.label}
        </p>
      )}
    </button>
  )
}

export default MemeCard
