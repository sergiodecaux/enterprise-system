import SegmentedControl from '../ui/SegmentedControl'
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

const STYLE_OPTIONS = [
  { value: 'ALL' as const, label: 'Все стили' },
  { value: 'SCALP' as const, label: 'Скальп' },
  { value: 'INTRADAY' as const, label: 'Интрадей' },
  { value: 'SWING' as const, label: 'Свинг' },
]

const SIDE_OPTIONS = [
  { value: 'ALL' as const, label: 'Все', tone: 'neutral' as const },
  { value: 'LONG' as const, label: 'Лонг', tone: 'long' as const },
  { value: 'SHORT' as const, label: 'Шорт', tone: 'short' as const },
]

const SniperFilters = ({
  activeFilter,
  onFilterChange,
  styleFilter,
  onStyleFilterChange,
}: SniperFiltersProps) => (
  <div className="grid gap-1.5">
    <SegmentedControl
      value={styleFilter}
      onChange={onStyleFilterChange}
      options={STYLE_OPTIONS}
      size="sm"
      stretch
      ariaLabel="Стиль торговли"
      className="w-full"
    />
    <SegmentedControl
      value={activeFilter}
      onChange={onFilterChange}
      options={SIDE_OPTIONS}
      size="sm"
      stretch
      ariaLabel="Направление"
      className="w-full"
    />
  </div>
)

export default SniperFilters
