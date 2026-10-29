import type { OrderBookLevel as Level, HeatmapState } from '../../engine/types'
import HeatmapOverlay from './HeatmapOverlay'

interface Props {
  level: Level
  side: 'BID' | 'ASK'
  maxVolume: number
  isWall?: boolean
  heatmap?: HeatmapState
}

const OrderBookLevelRow = ({ level, side, maxVolume, isWall, heatmap }: Props) => {
  const barWidth =
    maxVolume > 0 ? Math.min(100, (level.volume / maxVolume) * 100) : 0

  const isBid = side === 'BID'
  const fill = isBid
    ? isWall
      ? 'bg-market-long/[0.18]'
      : 'bg-market-long/[0.08]'
    : isWall
      ? 'bg-market-short/[0.18]'
      : 'bg-market-short/[0.08]'

  const formatPrice = (price: number): string => {
    if (price >= 1000) {
      return price.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
    }
    if (price >= 1) {
      return price.toLocaleString('ru-RU', { maximumFractionDigits: 4 })
    }
    return price.toLocaleString('ru-RU', { maximumFractionDigits: 6 })
  }

  const formatVolume = (vol: number): string => {
    if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(2)}M`
    if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`
    return vol.toFixed(0)
  }

  return (
    <div className="relative flex h-6 items-center gap-2 px-2">
      {isWall && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 z-20 w-[2px] bg-market-warning"
        />
      )}
      {heatmap && (
        <HeatmapOverlay price={level.price} heatmap={heatmap} side={side} />
      )}
      <div
        aria-hidden
        className={`absolute inset-y-0 ${isBid ? 'right-0' : 'left-0'} ${fill}`}
        style={{ width: `${barWidth}%` }}
      />
      <span
        className={`tnum relative z-10 truncate font-mono text-[11px] leading-4 ${
          isBid ? 'text-market-long' : 'text-market-short'
        }`}
      >
        {formatPrice(level.price)}
      </span>
      {isWall && (
        <span
          aria-hidden
          className="relative z-10 h-1 w-1 shrink-0 rounded-full bg-market-warning"
          title="Аномальная плотность"
        />
      )}
      <span className="tnum relative z-10 ml-auto shrink-0 font-mono text-[11px] leading-4 text-text-secondary">
        {formatVolume(level.volume)}
      </span>
    </div>
  )
}

export default OrderBookLevelRow
