import type { SpreadPressureResult } from '../../engine/meme'
import { spreadQualityLabel } from '../../i18n/displayMaps'

interface SpreadPressureBarProps {
  pressure: SpreadPressureResult
}

const SpreadPressureBar = ({ pressure }: SpreadPressureBarProps) => {
  const { pressureBarPct, label, color, quality } = pressure

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Давление спреда
        </span>
        <span
          className="rounded px-2 py-0.5 font-mono text-[10px] font-bold uppercase"
          style={{ backgroundColor: color + '30', color }}
        >
          {spreadQualityLabel[quality] ?? quality}
        </span>
      </div>

      <div className="relative h-3 overflow-hidden rounded-full bg-hull-border">
        {pressureBarPct < 50 && (
          <div
            className="absolute left-0 top-0 h-full rounded-l-full bg-alert transition-all duration-700"
            style={{ width: `${50 - pressureBarPct}%` }}
          />
        )}

        {pressureBarPct > 50 && (
          <div
            className="absolute right-0 top-0 h-full rounded-r-full transition-all duration-700"
            style={{ width: `${pressureBarPct - 50}%`, backgroundColor: color }}
          />
        )}

        <div className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-holo/30" />
      </div>

      <div className="flex justify-between font-mono text-[9px] text-holo/40">
        <span>ПРОДАВЦЫ</span>
        <span className="max-w-[40%] truncate text-center" style={{ color }}>
          {pressure.pressure === 'NEUTRAL' ? '—' : label}
        </span>
        <span>ПОКУПАТЕЛИ</span>
      </div>
    </div>
  )
}

export default SpreadPressureBar
