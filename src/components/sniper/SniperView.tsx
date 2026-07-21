import { useState, useMemo } from 'react'
import { Crosshair, AlertCircle, TrendingUp } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { getSniperSignals } from '../../engine/sniperMode'
import type { TradeSide } from '../../engine/smc'
import SniperCard from './SniperCard'
import SniperFilters from './SniperFilters'

const SniperView = () => {
  const signals = useAppStore((s) => s.signals)
  const buyerAggression = useAppStore((s) => s.buyerAggression)
  const isScanning = useAppStore((s) => s.isScanning)

  const [activeFilter, setActiveFilter] = useState<'ALL' | TradeSide>('ALL')

  const sniperSignals = useMemo(() => {
    const enriched = signals.map((s) => ({
      ...s,
      buyerAggression:
        buyerAggression[s.internalSymbol] ?? s.buyerAggression ?? null,
    }))
    const all = getSniperSignals(enriched)
    if (activeFilter === 'ALL') return all
    return all.filter((s) => s.direction === activeFilter)
  }, [signals, buyerAggression, activeFilter])

  const totalCount = sniperSignals.length
  const longCount = sniperSignals.filter((s) => s.direction === 'LONG').length
  const shortCount = sniperSignals.filter((s) => s.direction === 'SHORT').length

  return (
    <div className="flex min-h-screen flex-col bg-space pb-6">
      <div className="sticky top-0 z-10 border-b border-hull-border bg-space/95 px-4 py-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Crosshair className="h-6 w-6 text-matrix" />
            <h1 className="font-mono text-2xl font-bold uppercase tracking-tight text-holo">
              Режим снайпера
            </h1>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-matrix/30 bg-matrix/10 px-3 py-1.5">
            <TrendingUp className="h-4 w-4 text-matrix" />
            <span className="font-mono text-sm font-bold text-matrix">
              {totalCount}
            </span>
          </div>
        </div>

        <div className="mb-3 grid grid-cols-3 gap-2">
          <div className="rounded-md bg-hull px-2 py-1.5 text-center">
            <div className="font-mono text-[10px] uppercase text-holo/40">
              Всего
            </div>
            <div className="font-mono text-lg font-bold text-holo">
              {totalCount}
            </div>
          </div>
          <div className="rounded-md bg-matrix/5 px-2 py-1.5 text-center">
            <div className="font-mono text-[10px] uppercase text-matrix/60">
              Лонг
            </div>
            <div className="font-mono text-lg font-bold text-matrix">
              {longCount}
            </div>
          </div>
          <div className="rounded-md bg-alert/5 px-2 py-1.5 text-center">
            <div className="font-mono text-[10px] uppercase text-alert/60">
              Шорт
            </div>
            <div className="font-mono text-lg font-bold text-alert">
              {shortCount}
            </div>
          </div>
        </div>

        <SniperFilters
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />
      </div>

      <div className="flex-1 px-4 pt-4">
        {isScanning && totalCount === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="mb-3 h-12 w-12 animate-spin rounded-full border-4 border-hull-border border-t-matrix" />
            <p className="font-mono text-sm text-holo/40">
              Сканирование рынка...
            </p>
          </div>
        )}

        {!isScanning && totalCount === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="mb-3 h-12 w-12 text-holo/20" />
            <p className="mb-1 font-mono text-sm font-bold text-holo/60">
              Нет снайперских сигналов
            </p>
            <p className="max-w-xs text-center font-mono text-xs text-holo/30">
              Ожидаем сетапы с подтверждением всех фильтров силы
            </p>
          </div>
        )}

        {totalCount > 0 && (
          <div className="space-y-3">
            {sniperSignals.map((signal) => (
              <SniperCard key={signal.symbol} signal={signal} />
            ))}
          </div>
        )}
      </div>

      {totalCount > 0 && (
        <div className="mt-6 px-4">
          <div className="rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm">💡</span>
              <span className="font-mono text-xs font-bold uppercase text-yellow-400">
                Важно
              </span>
            </div>
            <p className="font-mono text-xs leading-relaxed text-holo/60">
              Снайперские сигналы прошли минимум 2 из 3 фильтров силы. Входите
              строго по входу, не гонитесь за ценой. SL — это закон.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default SniperView
