import type { HeatmapState } from '../../engine/types'
import { getHeatIntensity } from '../../engine/orderbook/heatmap'

interface Props {
  price: number
  heatmap: HeatmapState
  side: 'BID' | 'ASK'
}

const HeatmapOverlay = ({ price, heatmap, side }: Props) => {
  const intensity = getHeatIntensity(heatmap, price)
  if (intensity < 0.1) return null

  const baseColor = side === 'BID' ? '34, 197, 94' : '239, 68, 68'
  const opacity = 0.1 + intensity * 0.4

  return (
    <div
      className="absolute inset-0 pointer-events-none mix-blend-screen"
      style={{
        backgroundColor: `rgba(${baseColor}, ${opacity})`,
      }}
    />
  )
}

export default HeatmapOverlay
