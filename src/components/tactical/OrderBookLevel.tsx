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
  const barWidth = maxVolume > 0 ? Math.min(100, (level.volume / maxVolume) * 100) : 0

  const bgColor =
    side === 'BID'
      ? isWall
        ? 'bg-matrix/30'
        : 'bg-matrix/10'
      : isWall
        ? 'bg-alert/30'
        : 'bg-alert/10'

  const textColor = side === 'BID' ? 'text-matrix' : 'text-alert'
  const wallBorder = isWall ? 'ring-1 ring-inset ring-holo/40' : ''

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
    <div className={`relative h-6 flex items-center px-2 ${wallBorder}`}>
      {heatmap && <HeatmapOverlay price={level.price} heatmap={heatmap} side={side} />}
      <div
        className={`absolute inset-y-0 ${side === 'BID' ? 'right-0' : 'left-0'} ${bgColor}`}
        style={{ width: `${barWidth}%` }}
      />
      <div className="relative z-10 flex justify-between w-full text-xs font-mono">
        <span className={textColor}>{formatPrice(level.price)}</span>
        <span className="text-holo/60">{formatVolume(level.volume)}</span>
      </div>
    </div>
  )
}

export default OrderBookLevelRow
