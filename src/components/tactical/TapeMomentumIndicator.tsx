import type { TapeMomentumState } from '../../engine/types'

interface Props {
  momentum: TapeMomentumState
}

const TapeMomentumIndicator = ({ momentum }: Props) => {
  const isActive =
    momentum.signal === 'STRONG_BUY' || momentum.signal === 'STRONG_SELL'

  return (
    <div className="flex items-center gap-2 rounded-lg border border-hull-border bg-hull px-3 py-2">
      <div className="relative flex-shrink-0">
        <div
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: momentum.color }}
        />
        {isActive && (
          <div
            className="absolute inset-0 h-3 w-3 animate-ping rounded-full"
            style={{ backgroundColor: momentum.color, opacity: 0.5 }}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <span
          className="font-mono text-xs font-bold"
          style={{ color: momentum.color }}
        >
          {momentum.label}
        </span>
      </div>

      <div className="flex flex-shrink-0 items-center gap-1">
        <span className="font-mono text-[10px] text-holo/30">Δ</span>
        <span
          className="font-mono text-[10px] font-bold"
          style={{ color: momentum.color }}
        >
          {momentum.imbalanceDelta >= 0 ? '+' : ''}
          {(momentum.imbalanceDelta * 100).toFixed(1)}%
        </span>
      </div>

      {momentum.isBurst && (
        <span
          className="rounded px-1 font-mono text-[9px] font-bold"
          style={{
            backgroundColor: momentum.color + '30',
            color: momentum.color,
          }}
        >
          BURST
        </span>
      )}
    </div>
  )
}

export default TapeMomentumIndicator
