import type { TradeSide } from '../../engine/smc'

interface SniperFiltersProps {
  activeFilter: 'ALL' | TradeSide
  onFilterChange: (filter: 'ALL' | TradeSide) => void
}

const SniperFilters = ({ activeFilter, onFilterChange }: SniperFiltersProps) => {
  const filters: Array<{ id: 'ALL' | TradeSide; label: string; emoji: string }> =
    [
      { id: 'ALL', label: 'Все', emoji: '🎯' },
      { id: 'LONG', label: 'Лонг', emoji: '📈' },
      { id: 'SHORT', label: 'Шорт', emoji: '📉' },
    ]

  return (
    <div className="flex gap-2">
      {filters.map((filter) => (
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
  )
}

export default SniperFilters
