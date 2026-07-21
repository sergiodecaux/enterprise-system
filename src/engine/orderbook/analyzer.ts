import type {
  OrderBookLevel,
  OrderBookMetrics,
  OrderBookSnapshot,
  OrderBookWall,
} from '../types'

/**
 * Анализ снимка стакана: imbalance, walls, spread
 */
export function calculateOrderBookMetrics(
  snapshot: OrderBookSnapshot
): OrderBookMetrics {
  const { bids, asks } = snapshot

  const bidVolume = bids.reduce((sum, level) => sum + level.volume, 0)
  const askVolume = asks.reduce((sum, level) => sum + level.volume, 0)
  const bidOrders = bids.reduce((sum, level) => sum + level.orderCount, 0)
  const askOrders = asks.reduce((sum, level) => sum + level.orderCount, 0)

  const bestBid = bids[0]?.price ?? null
  const bestAsk = asks[0]?.price ?? null
  const midPrice = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null
  const spreadPercent =
    spread != null && midPrice != null && midPrice > 0 ? (spread / midPrice) * 100 : null

  const totalVolume = bidVolume + askVolume
  const imbalance = totalVolume > 0 ? ((bidVolume - askVolume) / totalVolume) * 100 : 0

  const walls = detectWalls(bids, asks)

  let pressure: OrderBookMetrics['pressure'] = 'NEUTRAL'
  if (imbalance > 20) pressure = 'BUYERS'
  else if (imbalance < -20) pressure = 'SELLERS'

  return {
    imbalance,
    bidVolume,
    askVolume,
    bidOrders,
    askOrders,
    walls,
    midPrice,
    spread,
    spreadPercent,
    pressure,
  }
}

/**
 * Детекция крупных ордеров («стенок»): объём > 3× медиана
 */
export function detectWalls(
  bids: OrderBookLevel[],
  asks: OrderBookLevel[]
): OrderBookWall[] {
  const allVolumes = [...bids, ...asks].map((l) => l.volume).sort((a, b) => a - b)
  if (allVolumes.length === 0) return []

  const medianVolume = allVolumes[Math.floor(allVolumes.length / 2)] || 1
  const threshold = medianVolume * 3
  const walls: OrderBookWall[] = []

  for (const level of bids) {
    if (level.volume > threshold) {
      walls.push({
        side: 'BID',
        price: level.price,
        volume: level.volume,
        ratio: level.volume / medianVolume,
      })
    }
  }

  for (const level of asks) {
    if (level.volume > threshold) {
      walls.push({
        side: 'ASK',
        price: level.price,
        volume: level.volume,
        ratio: level.volume / medianVolume,
      })
    }
  }

  return walls.sort((a, b) => b.volume - a.volume).slice(0, 5)
}

/** Imbalance как отдельная утилита (для тестов / внешнего использования) */
export function detectImbalance(bids: OrderBookLevel[], asks: OrderBookLevel[]): number {
  const bidVolume = bids.reduce((sum, l) => sum + l.volume, 0)
  const askVolume = asks.reduce((sum, l) => sum + l.volume, 0)
  const total = bidVolume + askVolume
  return total > 0 ? ((bidVolume - askVolume) / total) * 100 : 0
}
