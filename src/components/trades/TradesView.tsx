import { useState } from 'react'
import { Activity, History } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useTradeCopilot } from '../../hooks/useTradeCopilot'
import TradeCard from './TradeCard'

const TradesView = () => {
  const activeTrades = useAppStore((s) => s.activeTrades)
  useTradeCopilot()

  const [filter, setFilter] = useState<'ACTIVE' | 'CLOSED'>('ACTIVE')

  const filteredTrades =
    filter === 'ACTIVE'
      ? activeTrades.filter(
          (t) =>
            t.status === 'ACTIVE' ||
            t.status === 'BREAKEVEN' ||
            t.status === 'INVALIDATED'
        )
      : activeTrades.filter(
          (t) => t.status === 'CLOSED_WIN' || t.status === 'CLOSED_LOSS'
        )

  const activeCount = activeTrades.filter(
    (t) =>
      t.status === 'ACTIVE' ||
      t.status === 'BREAKEVEN' ||
      t.status === 'INVALIDATED'
  ).length

  const closedCount = activeTrades.filter(
    (t) => t.status === 'CLOSED_WIN' || t.status === 'CLOSED_LOSS'
  ).length

  return (
    <div className="flex min-h-screen flex-col bg-space pb-6">
      <div className="sticky top-0 z-10 border-b border-hull-border bg-space/95 px-4 py-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-6 w-6 text-matrix" />
            <h1 className="font-mono text-2xl font-bold uppercase tracking-tight text-holo">
              Мои Сделки
            </h1>
          </div>

          <div className="rounded-lg border border-matrix/30 bg-matrix/10 px-3 py-1.5">
            <span className="font-mono text-sm font-bold text-matrix">
              {activeCount}
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setFilter('ACTIVE')}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 font-mono text-xs font-bold uppercase transition-all ${
              filter === 'ACTIVE'
                ? 'border border-matrix/50 bg-matrix/20 text-matrix'
                : 'border border-hull-border bg-hull text-holo/40 hover:bg-hull-light hover:text-holo/70'
            }`}
          >
            <Activity className="h-3 w-3" />
            Активные ({activeCount})
          </button>

          <button
            type="button"
            onClick={() => setFilter('CLOSED')}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 font-mono text-xs font-bold uppercase transition-all ${
              filter === 'CLOSED'
                ? 'border border-matrix/50 bg-matrix/20 text-matrix'
                : 'border border-hull-border bg-hull text-holo/40 hover:bg-hull-light hover:text-holo/70'
            }`}
          >
            <History className="h-3 w-3" />
            Закрытые ({closedCount})
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 pt-4">
        {filteredTrades.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <span className="mb-3 text-5xl opacity-20">
              {filter === 'ACTIVE' ? '📊' : '📜'}
            </span>
            <p className="mb-1 font-mono text-sm font-bold text-holo/60">
              {filter === 'ACTIVE' ? 'Нет активных сделок' : 'История пуста'}
            </p>
            <p className="max-w-xs text-center font-mono text-xs text-holo/30">
              {filter === 'ACTIVE'
                ? 'Открой сделку из вкладки "Снайпер"'
                : 'Закрытые сделки появятся здесь'}
            </p>
          </div>
        )}

        {filteredTrades.length > 0 && (
          <div className="space-y-3">
            {filteredTrades
              .slice()
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((trade) => (
                <TradeCard key={trade.id} trade={trade} />
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default TradesView
