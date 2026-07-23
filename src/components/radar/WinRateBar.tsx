interface WinRateBarProps {
  value: number
  /** Compact rail for coin rows (fixed width, no layout jump) */
  compact?: boolean
}

const WinRateBar = ({ value, compact = false }: WinRateBarProps) => {
  const getBarColorClass = () => {
    if (value >= 70) return 'bg-matrix'
    if (value >= 50) return 'bg-yellow-500'
    if (value >= 30) return 'bg-orange-500'
    return 'bg-alert'
  }

  const getTextColorClass = () => {
    if (value >= 70) return 'text-matrix'
    if (value >= 50) return 'text-yellow-500'
    if (value >= 30) return 'text-orange-500'
    return 'text-alert'
  }

  if (compact) {
    return (
      <div className="flex w-[3.25rem] shrink-0 items-center gap-1">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hull-light">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${getBarColorClass()}`}
            style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
          />
        </div>
        <span
          className={`w-6 text-right font-mono text-[9px] tabular-nums ${getTextColorClass()}`}
        >
          {Math.round(value)}
        </span>
      </div>
    )
  }

  return (
    <div className="flex w-32 items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hull-light">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${getBarColorClass()}`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      <span className={`w-8 text-right font-mono text-xs tabular-nums ${getTextColorClass()}`}>
        {Math.round(value)}%
      </span>
    </div>
  )
}

export default WinRateBar
