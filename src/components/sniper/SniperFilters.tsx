import type { TradeSide } from '../../engine/smc'
import type { TradeStyle } from '../../engine/types'

export type SniperStyleFilter = 'ALL' | TradeStyle
export type SniperSideFilter = 'ALL' | TradeSide

interface SniperFiltersProps {
  activeFilter: SniperSideFilter
  onFilterChange: (filter: SniperSideFilter) => void
  styleFilter: SniperStyleFilter
  onStyleFilterChange: (filter: SniperStyleFilter) => void
}

const SniperFilters = ({
  activeFilter,
  onFilterChange,
  styleFilter,
  onStyleFilterChange,
}: SniperFiltersProps) => {
  const sideFilters: Array<{
    id: SniperSideFilter
    label: string
    emoji: string
  }> = [
    { id: 'ALL', label: 'Все', emoji: '🎯' },
    { id: 'LONG', label: 'Лонг', emoji: '📈' },
    { id: 'SHORT', label: 'Шорт', emoji: '📉' },
  ]

  const styleFilters: Array<{
    id: SniperStyleFilter
    label: string
  }> = [
    { id: 'ALL', label: 'Все стили' },
    { id: 'SCALP', label: '⚡️ SCALP' },
    { id: 'INTRADAY', label: '🎯 INTRA' },
    { id: 'SWING', label: '🕯 SWING' },
  ]

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {styleFilters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => onStyleFilterChange(filter.id)}
            className={`flex-1 rounded-lg px-2 py-2 font-mono text-[10px] font-bold uppercase tracking-wide transition-all ${
              styleFilter === filter.id
                ? filter.id === 'SCALP'
                  ? 'border border-yellow-400/50 bg-yellow-400/15 text-yellow-300 shadow-md'
                  : filter.id === 'INTRADAY'
                    ? 'border border-sky-400/50 bg-sky-400/15 text-sky-300 shadow-md'
                    : filter.id === 'SWING'
                      ? 'border border-violet-400/50 bg-violet-400/15 text-violet-300 shadow-md'
                      : 'border border-matrix/50 bg-matrix/20 text-matrix shadow-md'
                : 'border border-hull-border bg-hull text-holo/40 hover:bg-hull-light hover:text-holo/70'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        {sideFilters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => onFilterChange(filter.id)}
            className={`flex-1 rounded-lg px-3 py-2 font-mono text-xs font-bold uppercase tracking-wide transition-all ${
              activeFilter === filter.id
                ? 'border border-matrix/50 bg-matrix/20 text-matrix shadow-md'
                : 'border border-hull-border bg-hull text-holo/40 hover:bg-hull-light hover:text-holo/70'
            }`}
          >
            <span className="mr-1.5">{filter.emoji}</span>
            {filter.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default SniperFilters
