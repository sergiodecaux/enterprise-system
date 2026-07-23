import { useState } from 'react'
import { Flame, TrendingUp, TrendingDown, Eye, Rocket, Skull } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useMemePulseScanner } from '../../hooks/useMemePulseScanner'
import MemeCard from './MemeCard'

const MemePulseView = () => {
  const memeSignals = useAppStore((s) => s.memeSignals)
  const memeUniverse = useAppStore((s) => s.memeUniverse)
  useMemePulseScanner()

  const [filter, setFilter] = useState<
    'ALL' | 'CRITICAL' | 'PUMPING' | 'SQUEEZE' | 'SHORT' | 'TOXIC'
  >('ALL')

  const filteredSignals = memeSignals.filter((s) => {
    if (filter === 'CRITICAL')
      return s.quality === 'CRITICAL' || s.quality === 'STRONG'
    if (filter === 'PUMPING')
      return s.volumeSpike.detected && s.volumeSpike.priceChangePct > 0
    if (filter === 'SQUEEZE') return !!s.squeeze?.detected
    if (filter === 'SHORT') return !!s.backside?.detected
    if (filter === 'TOXIC') return !!s.toxic?.detected
    return true
  })

  const criticalCount = memeSignals.filter(
    (s) => s.quality === 'CRITICAL' || s.quality === 'STRONG'
  ).length
  const pumpingCount = memeSignals.filter(
    (s) => s.volumeSpike.detected && s.volumeSpike.priceChangePct > 0
  ).length
  const squeezeCount = memeSignals.filter((s) => s.squeeze?.detected).length
  const shortCount = memeSignals.filter((s) => s.backside?.detected).length

  const coveragePct =
    memeUniverse && memeUniverse.memeCount > 0
      ? Math.min(
          100,
          Math.round((memeUniverse.scannedCount / memeUniverse.memeCount) * 100)
        )
      : 0

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#0a0505] via-space to-[#120808] pb-6">
      <div className="sticky top-0 z-10 border-b border-alert/20 bg-[#0a0505]/95 px-4 py-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Rocket className="h-6 w-6 text-alert drop-shadow-[0_0_8px_rgba(255,0,60,0.6)]" />
            <h1 className="font-mono text-2xl font-bold uppercase tracking-tight text-holo">
              Meme Radar
            </h1>
            <span className="font-mono text-[10px] uppercase text-alert/60">
              Rocket intercept
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-alert/40 bg-alert/15 px-3 py-1.5 shadow-[0_0_12px_rgba(255,0,60,0.2)]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-alert" />
              <span className="font-mono text-sm font-bold text-alert">LIVE</span>
            </div>
            {memeSignals.length > 0 && (
              <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-1.5">
                <span className="font-mono text-sm font-bold text-orange-400">
                  {memeSignals.length}
                </span>
              </div>
            )}
          </div>
        </div>

        {memeUniverse && (
          <div className="mb-3 rounded-lg border border-hull-border bg-hull/60 px-3 py-2">
            <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-holo/50">
              <span>
                Вселенная MEXC: {memeUniverse.memeCount} мемов
                {memeUniverse.totalTickers > 0
                  ? ` / ${memeUniverse.totalTickers} тикеров`
                  : ''}
              </span>
              <span>
                Скан {memeUniverse.scannedCount}/{memeUniverse.memeCount} (
                {coveragePct}%)
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-hull-border">
              <div
                className="h-full rounded-full bg-alert/80 transition-all duration-500"
                style={{ width: `${coveragePct}%` }}
              />
            </div>
            <p className="mt-1 font-mono text-[9px] text-holo/35">
              Round-robin ×{memeUniverse.batchSize}/цикл · оборот #
              {memeUniverse.rotation} · радар топ-{memeSignals.length}
            </p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {(
            [
              { id: 'ALL' as const, label: 'Все', icon: Eye, count: null },
              {
                id: 'CRITICAL' as const,
                label: 'Hot',
                icon: Flame,
                count: criticalCount,
              },
              {
                id: 'PUMPING' as const,
                label: 'Памп',
                icon: TrendingUp,
                count: pumpingCount,
              },
              {
                id: 'SQUEEZE' as const,
                label: 'Squeeze',
                icon: Rocket,
                count: squeezeCount,
              },
              {
                id: 'SHORT' as const,
                label: 'Backside',
                icon: TrendingDown,
                count: shortCount,
              },
              {
                id: 'TOXIC' as const,
                label: 'Toxic',
                icon: Skull,
                count: null,
              },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`flex flex-col items-center justify-center rounded-lg px-1 py-2 font-mono text-[10px] font-bold uppercase transition-all ${
                filter === f.id
                  ? 'border border-alert/60 bg-alert/20 text-alert shadow-[0_0_10px_rgba(255,0,60,0.25)]'
                  : 'border border-hull-border bg-hull/80 text-holo/40 hover:border-orange-500/30 hover:text-orange-300'
              }`}
            >
              <f.icon className="mb-1 h-3 w-3" />
              {f.label}
              {f.count != null ? ` (${f.count})` : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 px-4 pt-4">
        {filteredSignals.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <span className="mb-3 text-5xl opacity-30">🚀</span>
            <p className="mb-1 font-mono text-sm font-bold text-holo/60">
              Нет ракет на радаре
            </p>
            <p className="max-w-xs text-center font-mono text-xs text-holo/30">
              {memeUniverse
                ? `Обходим ${memeUniverse.memeCount} мем-перпов MEXC round-robin…`
                : 'Ищем ignition, squeeze и backside на MEXC Futures...'}
            </p>
          </div>
        )}

        {filteredSignals.length > 0 && (
          <div className="space-y-3">
            {filteredSignals.map((signal) => (
              <MemeCard key={signal.symbol} signal={signal} />
            ))}
          </div>
        )}
      </div>

      {filteredSignals.length > 0 && (
        <div className="mt-6 px-4">
          <div className="rounded-lg border border-alert/30 bg-gradient-to-r from-alert/10 to-orange-600/5 p-3">
            <div className="mb-1 flex items-center gap-2">
              <Flame className="h-4 w-4 text-alert" />
              <span className="font-mono text-xs font-bold uppercase text-alert">
                Правила выживания
              </span>
            </div>
            <p className="font-mono text-xs leading-relaxed text-holo/60">
              🚀 Squeeze / Ignition = long с ММ. 🎯 Backside = short после слома.
              ☠️ Toxic / Bid Void = руки прочь. Shadow trailing вместо тупого TP.
              Счёт идёт на секунды.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default MemePulseView
