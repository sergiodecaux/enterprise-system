interface WinRateBarProps {
  value: number
}

const WinRateBar = ({ value }: WinRateBarProps) => {
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

  return (
    <div className="w-32 flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-hull-light rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${getBarColorClass()}`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      <span className={`text-xs font-mono w-8 text-right ${getTextColorClass()}`}>
        {Math.round(value)}%
      </span>
    </div>
  )
}

export default WinRateBar
