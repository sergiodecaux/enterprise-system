import { useState } from 'react'
import { Flame, TrendingUp, TrendingDown, Eye } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useMemePulseScanner } from '../../hooks/useMemePulseScanner'
import MemeCard from './MemeCard'

const MemePulseView = () => {
  const memeSignals = useAppStore((s) => s.memeSignals)
  useMemePulseScanner()

  const [filter, setFilter] = useState<'ALL' | 'CRITICAL' | 'PUMPING' | 'REVERSAL'>('ALL')

  const filteredSignals = memeSignals.filter((s) => {
    if (filter === 'CRITICAL') return s.quality === 'CRITICAL' || s.quality === 'STRONG'
    if (filter === 'PUMPING') return s.volumeSpike.detected && s.volumeSpike.priceChangePct > 0
    if (filter === 'REVERSAL') return s.meanReversion.detected
    return true
  })

  const criticalCount = memeSignals.filter(
    (s) => s.quality === 'CRITICAL' || s.quality === 'STRONG'
  ).length
  const pumpingCount = memeSignals.filter(
    (s) => s.volumeSpike.detected && s.volumeSpike.priceChangePct > 0
  ).length
  const reversalCount = memeSignals.filter((s) => s.meanReversion.detected).length

  return (
    <div className="flex min-h-screen flex-col bg-space pb-6">
      <div className="sticky top-0 z-10 border-b border-hull-border bg-space/95 px-4 py-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Flame className="h-6 w-6 text-alert" />
            <h1 className="font-mono text-2xl font-bold uppercase tracking-tight text-holo">
              Мем-пульс
            </h1>
            <span className="font-mono text-[10px] uppercase text-holo/40">
              Топ 10
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-alert/30 bg-alert/10 px-3 py-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-alert" />
              <span className="font-mono text-sm font-bold text-alert">
                ОНЛАЙН
              </span>
            </div>
            {memeSignals.length > 0 && (
              <div className="rounded-lg border border-hull-border bg-hull px-3 py-1.5">
                <span className="font-mono text-sm font-bold text-holo/70">
                  {memeSignals.length}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => setFilter('ALL')}
            className={`flex flex-col items-center justify-center rounded-lg px-2 py-2 font-mono text-xs font-bold uppercase transition-all ${
              filter === 'ALL'
                ? 'border border-matrix/50 bg-matrix/20 text-matrix'
                : 'border border-hull-border bg-hull text-holo/40 hover:bg-hull-light hover:text-holo/70'
            }`}
          >
            <Eye className="mb-1 h-3 w-3" />
            Все
          </button>

          <button
            type="button"
            onClick={() => setFilter('CRITICAL')}
            className={`flex flex-col items-center justify-center rounded-lg px-2 py-2 font-mono text-xs font-bold uppercase transition-all ${
              filter === 'CRITICAL'
                ? 'border border-alert/50 bg-alert/20 text-alert'
                : 'border border-hull-border bg-hull text-holo/40 hover:bg-hull-light hover:text-holo/70'
            }`}
          >
            <Flame className="mb-1 h-3 w-3" />
            Хот ({criticalCount})
          </button>

          <button
            type="button"
            onClick={() => setFilter('PUMPING')}
            className={`flex flex-col items-center justify-center rounded-lg px-2 py-2 font-mono text-xs font-bold uppercase transition-all ${
              filter === 'PUMPING'
                ? 'border border-matrix/50 bg-matrix/20 text-matrix'
                : 'border border-hull-border bg-hull text-holo/40 hover:bg-hull-light hover:text-holo/70'
            }`}
          >
            <TrendingUp className="mb-1 h-3 w-3" />
            Памп ({pumpingCount})
          </button>

          <button
            type="button"
            onClick={() => setFilter('REVERSAL')}
            className={`flex flex-col items-center justify-center rounded-lg px-2 py-2 font-mono text-xs font-bold uppercase transition-all ${
              filter === 'REVERSAL'
                ? 'border border-yellow-400/50 bg-yellow-400/20 text-yellow-400'
                : 'border border-hull-border bg-hull text-holo/40 hover:bg-hull-light hover:text-holo/70'
            }`}
          >
            <TrendingDown className="mb-1 h-3 w-3" />
            Откат ({reversalCount})
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 pt-4">
        {filteredSignals.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <span className="mb-3 text-5xl opacity-20">🔥</span>
            <p className="mb-1 font-mono text-sm font-bold text-holo/60">
              Нет активных мемов
            </p>
            <p className="max-w-xs text-center font-mono text-xs text-holo/30">
              Ищем самые горячие мемы на MEXC...
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
          <div className="rounded-lg border border-alert/20 bg-alert/5 p-3">
            <div className="mb-1 flex items-center gap-2">
              <Flame className="h-4 w-4 text-alert" />
              <span className="font-mono text-xs font-bold uppercase text-alert">
                Скальпер волатильности
              </span>
            </div>
            <p className="font-mono text-xs leading-relaxed text-holo/60">
              Мемы летают быстро. «БЫСТРЫЙ ВХОД» = вход по рынку. Фиксация при
              угасании давления спреда. Используй микро-стопы.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default MemePulseView
