import { Fish } from 'lucide-react'

interface WhaleTrapButtonProps {
  active: boolean
  onClick: () => void
}

/**
 * Toolbar toggle for the chart-only Whale Trap layer.
 * Amber is reserved for liquidation / warning semantics in the terminal.
 */
const WhaleTrapButton = ({ active, onClick }: WhaleTrapButtonProps) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title="Показать ловушки китов и уровни ликвидации крупных позиций"
      className={`tv-btn shrink-0 ${active ? 'tv-btn-whale-on' : ''}`}
    >
      <Fish className="h-3.5 w-3.5" strokeWidth={2} />
      <span className="hidden min-[600px]:inline">Whale Trap</span>
      <span className="min-[600px]:hidden">Кит</span>
      {active && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-market-warning" />
      )}
    </button>
  )
}

export default WhaleTrapButton
