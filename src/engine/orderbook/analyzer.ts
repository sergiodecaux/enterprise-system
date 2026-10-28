import type {
  OrderBookLevel,
  OrderBookMetrics,
  OrderBookSnapshot,
  OrderBookWall,
} from '../types'

export interface WallDetectionContext {
  /** 24h quote volume in USD (volume24h * price is preferred by callers) */
  advUsd?: number | null
  /** Optional hard floor in USD */
  minWallUsd?: number | null
}

/**
 * Distance-weighted order-book imbalance (exponential decay from mid).
 * A spoofed $500k wall 2.5% away must not outweigh the real touch.
 * Returns −100…+100.
 */
export function calculateWeightedImbalance(
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  midPrice: number,
  decayFactor = 50
): number {
  if (!(midPrice > 0) || bids.length === 0 || asks.length === 0) return 0

  let weightedBidVol = 0
  let weightedAskVol = 0

  for (const bid of bids) {
    const distPct = Math.abs(midPrice - bid.price) / midPrice
    weightedBidVol += bid.volume * Math.exp(-decayFactor * distPct)
  }
  for (const ask of asks) {
    const distPct = Math.abs(ask.price - midPrice) / midPrice
    weightedAskVol += ask.volume * Math.exp(-decayFactor * distPct)
  }

  const total = weightedBidVol + weightedAskVol
  return total > 0 ? ((weightedBidVol - weightedAskVol) / total) * 100 : 0
}

/**
 * Анализ снимка стакана: weighted imbalance, walls, spread.
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

  // Distance-weighted OBI (spoof-resistant). Raw volume stays for context.
  const imbalance =
    midPrice != null ? calculateWeightedImbalance(bids, asks, midPrice) : 0

  const walls = detectWalls(bids, asks)
  const top10 = [...bids.slice(0, 10), ...asks.slice(0, 10)]
  const top10Usd =
    midPrice != null
      ? top10.reduce((sum, level) => sum + level.volume * midPrice, 0)
      : null

  let pressure: OrderBookMetrics['pressure'] = 'NEUTRAL'
  if (imbalance > 20) pressure = 'BUYERS'
  else if (imbalance < -20) pressure = 'SELLERS'

  return {
    imbalance,
    weightedImbalance: imbalance,
    bidVolume,
    askVolume,
    bidOrders,
    askOrders,
    walls,
    midPrice,
    spread,
    spreadPercent,
    pressure,
    top10Usd,
  }
}

/**
 * Детекция крупных ордеров («стенок»).
 *
 * Threshold is relative to touch liquidity (top-10 average), not a sparse
 * median, and can be anchored to ADV: a wall must be ≥ ~2% of one minute of
 * average daily volume. This makes the detector work on alts/metals instead
 * of being hard-wired to BTC-sized $500k walls.
 */
export function detectWalls(
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  ctx: WallDetectionContext = {}
): OrderBookWall[] {
  const allVolumes = [...bids, ...asks].map((l) => l.volume).sort((a, b) => a - b)
  if (allVolumes.length === 0) return []

  const medianVolume = allVolumes[Math.floor(allVolumes.length / 2)] || 1
  const topTouch = [...bids.slice(0, 10), ...asks.slice(0, 10)]
  const avgTopVolume =
    topTouch.length > 0
      ? topTouch.reduce((sum, l) => sum + l.volume, 0) / topTouch.length
      : medianVolume

  // Relative to what is actually near price, never 3× a dead median.
  const relativeThreshold = Math.max(medianVolume * 3, avgTopVolume * 2.5)

  const adv = ctx.advUsd != null && ctx.advUsd > 0 ? ctx.advUsd : null
  // 2% of one minute of ADV — meaningful size, still reachable on alts.
  const advThresholdUsd = adv != null ? (adv / 1440) * 0.02 : null
  const hardFloorUsd = Math.max(25_000, ctx.minWallUsd ?? 0)
  const floorUsd = advThresholdUsd != null ? Math.min(hardFloorUsd, advThresholdUsd) : hardFloorUsd

  const walls: OrderBookWall[] = []
  const consider = (levels: OrderBookLevel[], side: 'BID' | 'ASK') => {
    for (const level of levels) {
      const passesRelative = level.volume > relativeThreshold
      const passesUsd = level.price > 0 && level.volume * level.price >= floorUsd
      if (!passesRelative && !passesUsd) continue
      walls.push({
        side,
        price: level.price,
        volume: level.volume,
        ratio: level.volume / medianVolume,
      })
    }
  }

  consider(bids, 'BID')
  consider(asks, 'ASK')

  return walls.sort((a, b) => b.volume - a.volume).slice(0, 5)
}

/** Imbalance как отдельная утилита (для тестов / внешнего использования) */
export function detectImbalance(bids: OrderBookLevel[], asks: OrderBookLevel[]): number {
  const bestBid = bids[0]?.price
  const bestAsk = asks[0]?.price
  if (bestBid == null || bestAsk == null) return 0
  return calculateWeightedImbalance(bids, asks, (bestBid + bestAsk) / 2)
}
